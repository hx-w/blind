use super::{
    access::PatAuth,
    dto::{CreateCollectionRequest, CreateSceneRequest, ShareResponse},
    error::AppError,
    links::{links_for, request_origin},
    no_store,
    registration::client_auth,
    scenes::{scene_from_manifest, scene_from_sources},
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
            crate::storage::oss::Location::parse(uri)
                .map_err(|_| AppError::bad_request("plugin components must be OSS references"))?;
        }
        for a in &plan.attachments {
            crate::storage::oss::Location::parse(&a.uri)
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
        .any(|(_, part)| !part.warnings.is_empty())
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
    if request.manifest.is_some() {
        return Err(AppError::bad_request(
            "Use the registered Client share endpoint for manifests",
        ));
    }
    let mut paths = Vec::with_capacity(request.paths.len());
    for path in request.paths {
        paths.push(if crate::storage::oss::is_oss(&path) {
            path
        } else {
            tokio::fs::canonicalize(&path)
                .await
                .context("cannot resolve source file")?
                .to_string_lossy()
                .into_owned()
        });
    }
    let mut scene =
        scene_from_sources(&state, &paths, &request.display, None, request.title).await?;
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
    let links = links_for(&state.registry, &scene, &origin, true)?;
    let hosts = discover(
        state.config.port()?,
        state.config.preferred_origin.as_deref(),
        state.config.base_path().as_deref(),
    )?;
    Ok((
        no_store(),
        Json(ShareResponse {
            links,
            hosts,
            origin,
        }),
    ))
}
