use super::{
    access::{ClientAuth, PatAuth},
    dto::{CreateCollectionRequest, CreateSceneRequest, ShareResponse},
    error::AppError,
    links::{links_for, request_origin},
    no_store,
    scenes::{RendererSelection, prepare_renderers, scene_from_manifest, scene_from_sources},
    state::AppState,
};
use crate::{
    protocol::registration::Source,
    runtime::{config::config_path, network::discover},
};
use anyhow::Context;
use axum::{Json, extract::State, http::HeaderMap, response::IntoResponse};

pub(super) async fn client_scene(
    State(state): State<AppState>,
    headers: HeaderMap,
    ClientAuth(source): ClientAuth,
    Json(request): Json<CreateSceneRequest>,
) -> Result<impl IntoResponse, AppError> {
    let _manifest_permit = manifest_permit(&state, &request)?;
    if let Some(collection) = request.collection {
        if request.manifest.is_some()
            || !request.paths.is_empty()
            || !request.display.is_empty()
            || request.labels.as_ref().is_some_and(|ls| !ls.is_empty())
            || !request.label_groups.is_empty()
            || request.viewport.is_some()
        {
            return Err(AppError::bad_request(
                "collection conflicts with standalone scene fields",
            ));
        }
        let response = create_collection_scene(
            &state,
            &headers,
            &source,
            collection,
            request.renderers,
            request.origin,
            request.ttl_days,
        )
        .await?;
        return Ok((no_store(), Json(response)));
    }
    if (request.manifest.is_some() || request.paths.iter().any(|p| crate::plugin::is_plugin(p)))
        && (request.labels.as_ref().is_some_and(|ls| !ls.is_empty())
            || !request.label_groups.is_empty())
    {
        return Err(AppError::bad_request(
            "manifest/plugin shares do not accept label overrides",
        ));
    }
    let (mut scene, renderers) = build_scene(
        &state,
        SceneInput {
            viewport: request.viewport,
            paths: request.paths,
            display: request.display,
            manifest: request.manifest,
            renderers: request.renderers,
            title: request.title,
        },
        &RendererSelection::default(),
        Some(source.scene_source()),
    )
    .await?;
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
    state
        .registry
        .sources
        .get(&source.id)
        .map_err(|_| AppError::unauthorized("Client was revoked"))?;
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
    let hosts = discover(
        state.config.port()?,
        state.config.preferred_origin.as_deref(),
        state.config.base_path().as_deref(),
    )?;
    let links = links_for(&state.registry, &scene, &renderers, &origin, true)?;
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
    response["status"] =
        serde_json::json!(if scene.warnings.iter().all(|w| w.code == "LOD_SELECTED") {
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
    shared_renderers: Vec<crate::plugin::RendererBundle>,
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
    let (mut renderers, shared) = prepare_renderers(
        shared_renderers,
        std::iter::empty(),
        &RendererSelection::default(),
    )?;
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
        if (part.manifest.is_some() || part.paths.iter().any(|p| crate::plugin::is_plugin(p)))
            && (!part.labels.is_empty() || !part.label_groups.is_empty())
        {
            return Err(AppError::bad_request(
                "manifest/plugin collection scenes do not accept label overrides",
            ));
        }
        let (mut scene, child_renderers) = build_scene(
            state,
            SceneInput {
                viewport: part.viewport,
                paths: part.paths,
                display: part.display,
                manifest: part.manifest,
                renderers: part.renderers,
                title: Some(part.title),
            },
            &shared,
            Some(source.scene_source()),
        )
        .await?;
        // Resolver expansion is only known after executing the plugin.
        total += scene.meshes.len() + scene.attachments.len();
        if total > 256 {
            return Err(AppError::bad_request("collection exceeds 256 resources"));
        }
        renderers.extend(child_renderers);
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
    scene.schema = 8;
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
    let hosts = discover(
        state.config.port()?,
        state.config.preferred_origin.as_deref(),
        state.config.base_path().as_deref(),
    )?;
    let links = links_for(&state.registry, &scene, &renderers, &origin, true)?;
    let mut response = serde_json::to_value(ShareResponse {
        links,
        origin,
        hosts,
    })
    .map_err(anyhow::Error::from)?;
    let collection = scene.collection.as_ref().unwrap();
    let entries: Vec<_> = scene.scene_entries().collect();
    response["kind"] = serde_json::json!("collection");
    response["active_scene_id"] = serde_json::json!(collection.active_scene_id);
    response["scenes"] = serde_json::json!(entries.iter().map(|(id, part)| {
        let id = id.expect("collection scenes have IDs");
        serde_json::json!({
            "id":id,"title":part.title,
            "viewer_url":format!("{}?scene={id}", response["viewer_url"].as_str().unwrap_or_default()),
            "image_url":format!("{}?scene={id}", response["image_url"].as_str().unwrap_or_default()),
            "resources":part.meshes.iter().map(|m| serde_json::json!({"path":m.path,"revision":m.revision})).collect::<Vec<_>>(),
            "warnings":part.warnings
        })
    }).collect::<Vec<_>>());
    response["status"] = serde_json::json!(if entries
        .iter()
        .any(|(_, part)| part.warnings.iter().any(|w| w.code != "LOD_SELECTED"))
    {
        "partial"
    } else {
        "complete"
    });
    Ok(response)
}
pub(super) async fn create_scene(
    State(state): State<AppState>,
    _pat: PatAuth,
    headers: HeaderMap,
    Json(request): Json<CreateSceneRequest>,
) -> Result<impl IntoResponse, AppError> {
    if request.collection.is_some() {
        return Err(AppError::bad_request(
            "Use the registered Client share endpoint for collections",
        ));
    }
    let _manifest_permit = manifest_permit(&state, &request)?;
    let (mut scene, renderers) = build_scene(
        &state,
        SceneInput {
            viewport: request.viewport,
            paths: request.paths,
            display: request.display,
            manifest: request.manifest,
            renderers: request.renderers,
            title: request.title,
        },
        &RendererSelection::default(),
        None,
    )
    .await?;
    scene.ttl_days = Some(request.ttl_days);
    if let Some(labels) = request.labels.filter(|ls| ls.iter().any(Option::is_some)) {
        scene
            .set_labels(labels)
            .map_err(|error| AppError::bad_request(&error.to_string()))?;
    }
    scene
        .set_label_groups(request.label_groups)
        .map_err(|error| AppError::bad_request(&error.to_string()))?;
    let origin = match request.origin {
        Some(origin) => state.config.normalize_share_origin(&origin)?,
        None => request_origin(&headers, &state.config)?,
    };
    let hosts = discover(
        state.config.port()?,
        state.config.preferred_origin.as_deref(),
        state.config.base_path().as_deref(),
    )?;
    let links = links_for(&state.registry, &scene, &renderers, &origin, true)?;
    Ok((
        no_store(),
        Json(ShareResponse {
            links,
            hosts,
            origin,
        }),
    ))
}

struct SceneInput {
    viewport: Option<crate::scene::ViewportState>,
    paths: Vec<String>,
    display: Vec<crate::scene::component::DisplayOptions>,
    manifest: Option<crate::plugin::ShareManifest>,
    renderers: Vec<crate::plugin::RendererBundle>,
    title: Option<String>,
}

async fn build_scene(
    state: &AppState,
    input: SceneInput,
    shared: &RendererSelection,
    source: Option<crate::scene::SceneSource>,
) -> Result<
    (
        crate::scene::SceneDescriptor,
        Vec<crate::plugin::RendererBundle>,
    ),
    AppError,
> {
    let SceneInput {
        viewport,
        paths,
        display,
        manifest,
        mut renderers,
        title,
    } = input;
    let plan = if let Some(plan) = manifest {
        if !paths.is_empty() || !display.is_empty() {
            return Err(AppError::bad_request(
                "manifest conflicts with paths/display",
            ));
        }
        Some(plan)
    } else if paths.iter().any(|p| crate::plugin::is_plugin(p)) {
        if paths.len() != 1 || !display.is_empty() {
            return Err(AppError::bad_request(
                "plugin shares require one URI without display overrides",
            ));
        }
        let path = config_path()?;
        let dir = path.parent().context("missing config parent")?;
        let (plan, bundle) = crate::plugin::resolve(dir, &paths[0])
            .await
            .map_err(|e| AppError::bad_request(&e.to_string()))?;
        if let Some(bundle) = bundle {
            renderers.push(bundle);
        }
        Some(plan)
    } else {
        None
    };
    let options = plan
        .as_ref()
        .map(|p| {
            p.components
                .iter()
                .map(|c| c.display.clone())
                .collect::<Vec<_>>()
        })
        .unwrap_or_else(|| display.clone());
    let (renderers, selection) = prepare_renderers(renderers, options.into_iter(), shared)?;
    let mut scene = if let Some(plan) = plan {
        scene_from_manifest(state, plan, &selection, source, title).await?
    } else {
        let mut normalized = Vec::with_capacity(paths.len());
        for path in paths {
            normalized.push(if source.is_some() || crate::storage::oss::is_oss(&path) {
                path
            } else {
                tokio::fs::canonicalize(&path)
                    .await
                    .context("cannot resolve source file")?
                    .to_string_lossy()
                    .into_owned()
            });
        }
        scene_from_sources(state, &normalized, &display, &selection, source, title).await?
    };
    if let Some(viewport) = viewport {
        scene.state.viewport = viewport;
    }
    scene
        .validate_viewport()
        .map_err(|e| AppError::bad_request(&e.to_string()))?;
    Ok((scene, renderers))
}

fn manifest_permit(
    state: &AppState,
    request: &CreateSceneRequest,
) -> Result<Option<tokio::sync::OwnedSemaphorePermit>, AppError> {
    if request.manifest.is_some()
        || !request.renderers.is_empty()
        || request
            .paths
            .iter()
            .any(|path| crate::plugin::is_plugin(path))
        || request.collection.as_ref().is_some_and(|collection| {
            collection.scenes.iter().any(|part| {
                part.manifest.is_some()
                    || !part.renderers.is_empty()
                    || part.paths.iter().any(|path| crate::plugin::is_plugin(path))
            })
        })
    {
        Ok(Some(
            state
                .plugin_slots
                .clone()
                .try_acquire_owned()
                .map_err(|_| {
                    AppError::too_many_requests("Two manifest shares already running; retry later")
                })?,
        ))
    } else {
        Ok(None)
    }
}
