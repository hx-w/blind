mod assets;
mod manifest;
pub(super) use assets::{client_plugins, get_attachment, get_renderer};
use manifest::scene_from_manifest;

use super::*;

fn client_auth(state: &AppState, headers: &HeaderMap, pending: bool) -> Result<Source, AppError> {
    let credential =
        bearer(headers).ok_or_else(|| AppError::unauthorized("Client credential required"))?;
    state
        .registry
        .sources
        .authenticate(credential, pending)
        .map_err(|_| AppError::unauthorized("Client registration is invalid, expired or revoked"))
}
pub(super) async fn join_client(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(mut request): Json<JoinRequest>,
) -> Result<impl IntoResponse, AppError> {
    let token = bearer(&headers)
        .ok_or_else(|| AppError::unauthorized("invitation required"))?
        .to_owned();
    if request.host.is_empty() {
        request.host = peer.ip().to_string();
    }
    let permit = state
        .join_slots
        .clone()
        .try_acquire_owned()
        .map_err(|_| AppError::too_many_requests("Too many registrations in progress"))?;
    let sources = state.registry.sources.clone();
    let result = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        sources.begin(&token, request)
    })
    .await
    .map_err(|e| AppError::internal(&e.to_string()))?
    .map_err(|e| AppError::bad_request(&e.to_string()))?;
    Ok((no_store(), Json(result)))
}
pub(super) async fn client_oss(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<impl IntoResponse, AppError> {
    client_auth(&state, &headers, false)?;
    let config = config_path()?;
    let stores = crate::oss::list(config.parent().context("missing config directory")?)?;
    Ok((
        no_store(),
        Json(serde_json::json!({"stores": stores, "can_share": true})),
    ))
}

pub(super) async fn client_info(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<impl IntoResponse, AppError> {
    Ok((no_store(), Json(client_auth(&state, &headers, true)?)))
}
pub(super) async fn activate_client(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<FinishRequest>,
) -> Result<impl IntoResponse, AppError> {
    let source = client_auth(&state, &headers, true)?;
    if source.active {
        return Ok((no_store(), Json(source)));
    }
    let source = state
        .registry
        .sources
        .finish(source, request)
        .await
        .map_err(|e| AppError::bad_request(&format!("SFTP registration failed: {e}")))?;
    Ok((no_store(), Json(source)))
}
pub(super) async fn revoke_client(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<impl IntoResponse, AppError> {
    let source = client_auth(&state, &headers, true)?;
    state.registry.sources.revoke(&source.id)?;
    Ok((no_store(), Json(serde_json::json!({"revoked":true}))))
}
#[derive(Deserialize)]
pub(super) struct LocalRequest {
    name: String,
    host: String,
    user: String,
}
pub(super) async fn local_client(
    State(state): State<AppState>,
    _pat: PatAuth,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Json(request): Json<LocalRequest>,
) -> Result<impl IntoResponse, AppError> {
    if !peer.ip().is_loopback() {
        return Err(AppError::unauthorized(
            "local registration requires loopback and the server owner's PAT",
        ));
    }
    let (user, host) = crate::client::local_identity()?;
    if request.user != user || request.host != host {
        return Err(AppError::bad_request(
            "local registration requires the same OS user and filesystem; use SFTP for another user or a container host",
        ));
    }
    let result = state
        .registry
        .sources
        .local(request.name, request.host, request.user)?;
    Ok((no_store(), Json(result)))
}
pub(super) async fn scene_from_sources(
    state: &AppState,
    paths: &[String],
    display: &[crate::component::DisplayOptions],
    source: Option<crate::source::SceneSource>,
    title: Option<String>,
) -> Result<SceneDescriptor, AppError> {
    if paths.is_empty() {
        return Err(AppError::bad_request("a scene needs at least one file"));
    }
    use crate::component::{ComponentKind, ComponentSource, SceneEntity};
    if !display.is_empty() && display.len() != paths.len() {
        return Err(AppError::bad_request(
            "Display option count must match resources",
        ));
    }
    if paths.len() > 256 {
        return Err(AppError::bad_request(
            "A scene supports at most 256 resources",
        ));
    }
    let mut meshes = Vec::new();
    let mut attachments = Vec::new();
    let mut entities = Vec::new();
    for (i, path) in paths.iter().enumerate() {
        let options = display.get(i).cloned().unwrap_or_default();
        options
            .validate()
            .map_err(|e| AppError::bad_request(&e.to_string()))?;
        let kind = options
            .component
            .map(Ok)
            .unwrap_or_else(|| {
                crate::plugin::infer_component(options.member.as_deref().unwrap_or(path))
            })
            .map_err(|e| AppError::bad_request(&e.to_string()))?;
        if kind.geometry() && options.size.is_some() {
            return Err(AppError::bad_request(
                "size applies to surface components; geometry retains source dimensions",
            ));
        }
        let observed = state
            .registry
            .sources
            .observe(source.as_ref(), path, options.member.is_some())
            .await
            .map_err(|e| match e {
                SourceError::Gone => AppError::bad_request("Source file or OSS alias not found"),
                SourceError::TooLarge => AppError::unprocessable("Source exceeds 512 MiB"),
                SourceError::Unavailable(_) => AppError::unavailable(
                    "Could not read source; check source configuration, credentials and permissions",
                ),
            })?;
        let path = if crate::oss::is_oss(&observed.path) {
            PathBuf::from(crate::oss::Location::parse(&observed.path)?.key.as_ref())
        } else {
            PathBuf::from(&observed.path)
        };
        let name = path
            .file_name()
            .context("missing filename")?
            .to_string_lossy()
            .into_owned();
        if let Some(member) = &options.member {
            if kind.geometry() {
                return Err(AppError::bad_request("archive geometry is not supported"));
            }
            crate::archive::read_member(&observed.bytes, member)
                .map_err(|e| AppError::bad_request(&e.to_string()))?;
        }
        let source_ref = if kind.geometry() {
            ComponentSource::Mesh(meshes.len())
        } else {
            ComponentSource::Attachment(attachments.len())
        };
        entities.push(SceneEntity {
            id: format!("resource-{}", i + 1),
            state: None,
            component: kind.clone(),
            renderer: crate::plugin::bind_component(&kind)
                .map_err(|e| AppError::bad_request(&e.to_string()))?,
            source: source_ref,
            label: name.clone(),
            group: options.group,
            position: options.position,
            size: options.size,
            visible: true,
            opacity: 1.0,
        });
        if !kind.geometry() {
            if observed.size > 64 * 1024 * 1024 {
                return Err(AppError::unprocessable("Surface component exceeds 64 MiB"));
            }
            attachments.push(crate::scene::SceneAttachment {
                member: options.member,
                id: format!("resource-{}", i + 1),
                path: observed.path,
                label: name,
                byte_size: Some(observed.size),
                revision: Some(observed.revision),
                unavailable: None,
            });
            continue;
        }
        let format = MeshFormat::from_path(&path)?;
        if (kind == ComponentKind::Points) != (format == MeshFormat::Pts) {
            return Err(AppError::bad_request(
                "points requires PTS; mesh requires PLY, STL or OBJ",
            ));
        }
        meshes.push(crate::scene::MeshRef {
            path: observed.path.clone(),
            name: path
                .file_name()
                .context("missing filename")?
                .to_string_lossy()
                .into_owned(),
            format,
            revision: observed.revision,
            byte_size: observed.size,
            modified_ns: observed.modified_ns,
            change_ns: observed.change_ns,
            color: crate::scene::default_color(format, i).into(),
            opacity: 1.0,
            visible: true,
            quality: MeshQuality::Lod,
            label: None,
            translation: options.position.unwrap_or([0.0; 3]),
        });
    }
    let title = title.unwrap_or_else(|| {
        if entities.len() == 1 {
            entities[0].label.clone()
        } else {
            format!("{} elements", entities.len())
        }
    });
    Ok(SceneDescriptor {
        source,
        schema: 5,
        title,
        created_at: crate::source::now() as u64,
        ttl_days: None,
        meshes,
        entities,
        attachments,
        warnings: Vec::new(),
        collection: None,
        label_groups: Vec::new(),
        state: Default::default(),
    })
}

pub(super) async fn client_scene(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<CreateSceneRequest>,
) -> Result<impl IntoResponse, AppError> {
    let source = client_auth(&state, &headers, false)?;
    let _manifest_permit = if request.manifest.is_some()
        || request.paths.iter().any(|p| crate::plugin::is_plugin(p))
        || request.collection.as_ref().is_some_and(|c| {
            c.scenes
                .iter()
                .any(|s| s.paths.iter().any(|p| crate::plugin::is_plugin(p)))
        }) {
        Some(
            state
                .plugin_slots
                .clone()
                .try_acquire_owned()
                .map_err(|_| {
                    AppError::too_many_requests("Two manifest shares already running; retry later")
                })?,
        )
    } else {
        None
    };
    if let Some(collection) = request.collection {
        let response = create_collection_scene(
            &state,
            &headers,
            &source,
            collection,
            request.origin,
            request.ttl_days,
        )
        .await?;
        return Ok((no_store(), Json(response)));
    }
    let mut scene = if let Some(plan) = request.manifest {
        if !request.paths.is_empty()
            || request.labels.as_ref().is_some_and(|ls| !ls.is_empty())
            || !request.label_groups.is_empty()
        {
            return Err(AppError::bad_request(
                "manifest conflicts with paths/labels",
            ));
        }
        if plan
            .resources
            .iter()
            .any(|r| crate::plugin::is_plugin(&r.uri))
        {
            return Err(AppError::bad_request("nested plugin URIs are not allowed"));
        }
        for uri in plan.components.iter().map(|c| &c.uri) {
            crate::oss::Location::parse(uri)
                .map_err(|_| AppError::bad_request("plugin components must be OSS references"))?;
        }
        for a in &plan.attachments {
            crate::oss::Location::parse(&a.uri)
                .map_err(|_| AppError::bad_request("attachments must be OSS references"))?;
        }
        scene_from_manifest(&state, plan, Some(source.scene_source()), request.title).await?
    } else if request.paths.iter().any(|p| crate::plugin::is_plugin(p)) {
        if request.paths.len() != 1
            || request
                .labels
                .as_ref()
                .is_some_and(|ls| ls.iter().any(Option::is_some))
            || !request.label_groups.is_empty()
        {
            return Err(AppError::bad_request(
                "plugin shares require one URI without label overrides",
            ));
        }
        let dir = config_path()?
            .parent()
            .context("missing config parent")?
            .to_owned();
        let plan = crate::plugin::resolve(&dir, &request.paths[0])
            .await
            .map_err(|e| AppError::bad_request(&e.to_string()))?;
        scene_from_manifest(&state, plan, Some(source.scene_source()), request.title).await?
    } else {
        scene_from_sources(
            &state,
            &request.paths,
            &request.display,
            Some(source.scene_source()),
            request.title,
        )
        .await?
    };
    scene.ttl_days = Some(request.ttl_days);
    if let Some(labels) = request.labels.filter(|ls| ls.iter().any(Option::is_some)) {
        scene
            .set_labels(labels)
            .map_err(|e| AppError::bad_request(&e.to_string()))?;
    }
    if !request.label_groups.is_empty() {
        scene
            .set_label_groups(request.label_groups)
            .map_err(|e| AppError::bad_request(&e.to_string()))?;
    }
    // Server configuration/request origin selects the public endpoint; source addresses never form URLs.
    let origin = match request.origin {
        Some(origin) => state.config.normalize_share_origin(&origin)?,
        None => {
            if let Some(origin) = &state.config.preferred_origin {
                state.config.origin_with_base(origin)
            } else if source.local {
                discover(
                    state.config.port()?,
                    None,
                    state.config.base_path().as_deref(),
                )?
                .first()
                .context("no server origin")?
                .origin
                .clone()
            } else {
                request_origin(&headers, &state.config)?
            }
        }
    };
    let links = links_for(&state.registry, &scene, &origin, true)?;
    let hosts = discover(
        state.config.port()?,
        state.config.preferred_origin.as_deref(),
        state.config.base_path().as_deref(),
    )?;
    let mut response = serde_json::to_value(ShareResponse {
        links,
        origin,
        hosts,
    })
    .map_err(anyhow::Error::from)?;
    response["resources"] = serde_json::json!(
        scene
            .meshes
            .iter()
            .map(|m| serde_json::json!({"path":m.path,"revision":m.revision}))
            .collect::<Vec<_>>()
    );
    response["warnings"] = serde_json::to_value(&scene.warnings).map_err(anyhow::Error::from)?;
    response["status"] = serde_json::json!(if scene.warnings.is_empty() {
        "complete"
    } else {
        "partial"
    });
    response["attachments"] = serde_json::json!(scene.attachments.len());
    response["source"] = serde_json::to_value(&scene.source).map_err(anyhow::Error::from)?;
    Ok((no_store(), Json(response)))
}

async fn create_collection_scene(
    state: &AppState,
    headers: &HeaderMap,
    source: &Source,
    request: CreateCollectionRequest,
    requested_origin: Option<String>,
    ttl_days: u32,
) -> Result<serde_json::Value, AppError> {
    if !(2..=16).contains(&request.scenes.len())
        || request.title.trim().is_empty()
        || request.title.chars().count() > 120
    {
        return Err(AppError::bad_request(
            "collection requires a title and 2 to 16 scenes",
        ));
    }
    let mut ids = std::collections::HashSet::new();
    let mut total = 0;
    let mut parts = Vec::with_capacity(request.scenes.len());
    for part in request.scenes {
        if part.id.is_empty()
            || part.id.len() > 64
            || !part
                .id
                .bytes()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-' || c == b'_')
            || !ids.insert(part.id.clone())
        {
            return Err(AppError::bad_request(
                "collection scene IDs must be unique lowercase identifiers",
            ));
        }
        if part.title.trim().is_empty() || part.title.chars().count() > 120 {
            return Err(AppError::bad_request(
                "collection scene title must contain 1 to 120 characters",
            ));
        }
        let plugin = part.paths.iter().any(|p| crate::plugin::is_plugin(p));
        let mut scene = if plugin {
            if part.paths.len() != 1
                || !part.display.is_empty()
                || !part.labels.is_empty()
                || !part.label_groups.is_empty()
            {
                return Err(AppError::bad_request(
                    "a collection plugin scene requires one URI without overrides",
                ));
            }
            let dir = config_path()?
                .parent()
                .context("missing config parent")?
                .to_owned();
            let plan = crate::plugin::resolve(&dir, &part.paths[0])
                .await
                .map_err(|e| AppError::bad_request(&e.to_string()))?;
            total += plan.resources.len() + plan.components.len() + plan.attachments.len();
            if total > 256 {
                return Err(AppError::bad_request("collection exceeds 256 resources"));
            }
            scene_from_manifest(state, plan, Some(source.scene_source()), Some(part.title)).await?
        } else {
            total += part.paths.len();
            if total > 256 {
                return Err(AppError::bad_request("collection exceeds 256 resources"));
            }
            scene_from_sources(
                state,
                &part.paths,
                &part.display,
                Some(source.scene_source()),
                Some(part.title),
            )
            .await?
        };
        if !part.labels.is_empty() {
            scene
                .set_labels(part.labels)
                .map_err(|e| AppError::bad_request(&e.to_string()))?;
        }
        if !part.label_groups.is_empty() {
            scene
                .set_label_groups(part.label_groups)
                .map_err(|e| AppError::bad_request(&e.to_string()))?;
        }
        scene.ttl_days = Some(ttl_days);
        parts.push(crate::scene::CollectionEntry { id: part.id, scene });
    }
    if !ids.contains(&request.active_scene_id) {
        return Err(AppError::bad_request(
            "active_scene_id does not name a scene",
        ));
    }
    state
        .registry
        .sources
        .get(&source.id)
        .map_err(|_| AppError::unauthorized("Client was revoked"))?;
    let first = parts.remove(0);
    let mut scene = first.scene;
    scene.schema = 6;
    scene.collection = Some(crate::scene::SceneCollection {
        title: request.title,
        first_id: first.id,
        active_scene_id: request.active_scene_id,
        scenes: parts,
        strokes: Vec::new(),
        layout: None,
    });
    let origin = match requested_origin {
        Some(origin) => state.config.normalize_share_origin(&origin)?,
        None => {
            if let Some(origin) = &state.config.preferred_origin {
                state.config.origin_with_base(origin)
            } else if source.local {
                discover(
                    state.config.port()?,
                    None,
                    state.config.base_path().as_deref(),
                )?
                .first()
                .context("no server origin")?
                .origin
                .clone()
            } else {
                request_origin(headers, &state.config)?
            }
        }
    };
    let links = links_for(&state.registry, &scene, &origin, true)?;
    let hosts = discover(
        state.config.port()?,
        state.config.preferred_origin.as_deref(),
        state.config.base_path().as_deref(),
    )?;
    let mut response = serde_json::to_value(ShareResponse {
        links,
        origin,
        hosts,
    })
    .map_err(anyhow::Error::from)?;
    let collection = scene.collection.as_ref().unwrap();
    let mut entries = vec![(&collection.first_id, &scene)];
    entries.extend(
        collection
            .scenes
            .iter()
            .map(|entry| (&entry.id, &entry.scene)),
    );
    response["kind"] = serde_json::json!("collection");
    response["active_scene_id"] = serde_json::json!(collection.active_scene_id);
    response["scenes"] = serde_json::json!(entries.iter().map(|(id, part)| serde_json::json!({
        "id":id,"title":part.title,
        "viewer_url":format!("{}?scene={id}", response["viewer_url"].as_str().unwrap_or_default()),
        "image_url":format!("{}?scene={id}", response["image_url"].as_str().unwrap_or_default()),
        "resources":part.meshes.iter().map(|m| serde_json::json!({"path":m.path,"revision":m.revision})).collect::<Vec<_>>(),
        "warnings":part.warnings
    })).collect::<Vec<_>>());
    response["status"] = serde_json::json!(if entries
        .iter()
        .any(|(_, part)| !part.warnings.is_empty())
    {
        "partial"
    } else {
        "complete"
    });
    Ok(response)
}
