use super::*;

pub(super) async fn get_scene(
    Query(query): Query<HashMap<String, String>>,
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    AxumPath(token): AxumPath<String>,
    headers: HeaderMap,
) -> Result<impl IntoResponse, AppError> {
    let opened = open_scene(&state, &token, peer.ip())?;
    let owner = owner_matches(&headers, &state, &opened);
    if let Some(collection) = &opened.scene.collection {
        if !query.contains_key("scene") {
            let mut scenes =
                vec![serde_json::json!({"id":collection.first_id,"title":opened.scene.title})];
            scenes.extend(
                collection
                    .scenes
                    .iter()
                    .map(|entry| serde_json::json!({"id":entry.id,"title":entry.scene.title})),
            );
            return Ok((
                no_store(),
                Json(serde_json::json!({
                    "kind":"collection","title":collection.title,"active_scene_id":collection.active_scene_id,
                    "scenes":scenes,"strokes":collection.strokes,"layout":collection.layout,
                    "owner":owner,"ttl_days":opened.scene.link_ttl_days()
                })),
            ));
        }
    }
    let scene_id = query.get("scene").map(String::as_str);
    let scene = selected_scene(&opened.scene, scene_id)?.clone();
    source_result(
        &state,
        if opened.scene.collection.is_some() {
            ""
        } else {
            &token
        },
        state.registry.sources.validate_source(&scene),
    )?;
    let query_suffix = scene_id
        .map(|id| format!("?scene={id}"))
        .unwrap_or_default();
    let meshes = scene
        .meshes
        .iter()
        .enumerate()
        .map(|(index, mesh)| PublicMesh {
            name: mesh.name.clone(),
            format: mesh.format,
            revision: mesh.revision.clone(),
            byte_size: mesh.byte_size,
            color: mesh.color.clone(),
            opacity: mesh.opacity,
            visible: mesh.visible,
            quality: mesh.quality,
            label: mesh.label.clone(),
            translation: mesh.translation,
            // Relative to the document base so both root and base-path mounts
            // resolve to the correct API prefix.
            source_url: format!("api/v1/scenes/{token}/meshes/{index}{query_suffix}"),
        })
        .collect();
    Ok((
        no_store(),
        Json(serde_json::to_value(PublicScene {
            entities: scene.entity_descriptors(),
            attachments: scene.attachments.iter().enumerate().map(|(index,a)| serde_json::json!({"id":a.id,"label":a.label,"byte_size":a.byte_size,"unavailable":a.unavailable,"url":if a.revision.is_some(){Some(format!("api/v1/scenes/{token}/attachments/{index}{query_suffix}"))}else{None}})).collect(),
            warnings: scene.warnings.clone(),
            ttl_days: scene.link_ttl_days(),
            source: scene.source.clone(),
            title: scene.title,
            meshes,
            label_groups: scene.label_groups,
            state: scene.state,
            owner,
        }).map_err(anyhow::Error::from)?),
    ))
}

pub(super) fn selected_scene<'a>(
    root: &'a SceneDescriptor,
    id: Option<&str>,
) -> Result<&'a SceneDescriptor, AppError> {
    match &root.collection {
        Some(collection) => root
            .scene_by_id(id.unwrap_or(&collection.active_scene_id))
            .ok_or_else(|| AppError::not_found("Scene not found in collection")),
        None if id.is_some() => Err(AppError::not_found("Scene not found in collection")),
        None => Ok(root),
    }
}

pub(super) async fn get_mesh(
    Query(query): Query<HashMap<String, String>>,
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    AxumPath((token, index)): AxumPath<(String, usize)>,
) -> Result<Response<Body>, AppError> {
    let opened = open_scene(&state, &token, peer.ip())?;
    let scene = selected_scene(&opened.scene, query.get("scene").map(String::as_str))?.clone();
    let mesh = scene
        .meshes
        .get(index)
        .ok_or_else(|| AppError::not_found("Mesh not found"))?;
    let reserved_bytes = mesh.byte_size.max(if mesh.format == MeshFormat::Pts {
        4 * MIB
    } else {
        0
    });
    let mut response_permit = reserve_response(&state, reserved_bytes)?;
    let bytes = source_result(
        &state,
        if opened.scene.collection.is_some() {
            ""
        } else {
            &token
        },
        state.registry.sources.read_mesh(&scene, mesh, true).await,
    )?
    .bytes;
    let format = mesh.format;
    let served = tokio::task::spawn_blocking(move || {
        mesh::serve_bytes(bytes, format).map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| AppError::internal(&error.to_string()))?
    .map_err(|error| AppError::unprocessable(&error))?;
    let (bytes, content_type) = served;
    expand_response_reservation(&state, &mut response_permit, bytes.len())?;
    Ok(Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, content_type)
        .header(header::CACHE_CONTROL, NO_STORE)
        .header(header::CONTENT_LENGTH, bytes.len())
        .body(budgeted_body(bytes, response_permit))?)
}

pub(super) async fn get_mesh_lod(
    Query(query): Query<HashMap<String, String>>,
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    AxumPath((token, index)): AxumPath<(String, usize)>,
) -> Result<Response<Body>, AppError> {
    let opened = open_scene(&state, &token, peer.ip())?;
    let scene = selected_scene(&opened.scene, query.get("scene").map(String::as_str))?;
    lod_response(
        &state,
        scene_lod(
            &state,
            if opened.scene.collection.is_some() {
                ""
            } else {
                &token
            },
            scene,
            index,
        )
        .await?,
    )
}

async fn scene_lod(
    state: &AppState,
    token: &str,
    scene: &SceneDescriptor,
    index: usize,
) -> Result<Arc<LodAsset>, AppError> {
    let mesh = scene
        .meshes
        .get(index)
        .ok_or_else(|| AppError::not_found("Mesh not found"))?;
    let target_primitives = lod::target_primitives(scene.meshes.len());
    let key = lod::cache_key(&mesh.revision, mesh.format, target_primitives);
    if let Some(asset) = state.lod_cache.get(&key) {
        source_result(
            state,
            token,
            state
                .registry
                .sources
                .validate_mesh_metadata(scene, mesh)
                .await,
        )?;
        return Ok(asset);
    }

    let _permit = state
        .lod_slots
        .acquire()
        .await
        .map_err(|error| AppError::unavailable(&error.to_string()))?;
    if let Some(asset) = state.lod_cache.get(&key) {
        source_result(
            state,
            token,
            state
                .registry
                .sources
                .validate_mesh_metadata(scene, mesh)
                .await,
        )?;
        return Ok(asset);
    }

    let memory_permits = lod_memory_permits(mesh.byte_size);
    let _memory = state
        .lod_memory
        .clone()
        .acquire_many_owned(memory_permits)
        .await
        .map_err(|error| AppError::unavailable(&error.to_string()))?;

    let bytes = source_result(
        state,
        token,
        state.registry.sources.read_mesh(scene, mesh, true).await,
    )?
    .bytes;
    let format = mesh.format;
    let asset =
        tokio::task::spawn_blocking(move || lod::build_bytes(&bytes, format, target_primitives))
            .await
            .map_err(|e| AppError::internal(&e.to_string()))??;
    let asset = Arc::new(asset);
    state.lod_cache.insert(key, asset.clone());
    Ok(asset)
}

fn lod_response(state: &AppState, asset: Arc<LodAsset>) -> Result<Response<Body>, AppError> {
    let response_permit = reserve_response(state, asset.bytes.len() as u64)?;
    Ok(Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, MeshFormat::Ply.mime())
        .header(header::CACHE_CONTROL, NO_STORE)
        .header("x-blind-raw-bytes", asset.raw_bytes)
        .header(header::CONTENT_LENGTH, asset.bytes.len())
        .body(budgeted_body(asset.bytes.clone(), response_permit))?)
}

pub(super) fn reserve_response(
    state: &AppState,
    byte_size: u64,
) -> Result<tokio::sync::OwnedSemaphorePermit, AppError> {
    let permits = byte_size.div_ceil(MIB).max(1);
    if permits > u64::from(RESPONSE_MEMORY_MIB) {
        return Err(AppError::unprocessable(
            "Response exceeds the memory budget",
        ));
    }
    state
        .response_memory
        .clone()
        .try_acquire_many_owned(permits as u32)
        .map_err(|_| AppError::too_many_requests("Response memory is busy; retry shortly"))
}

pub(super) fn budgeted_body(
    bytes: impl Into<Bytes>,
    permit: tokio::sync::OwnedSemaphorePermit,
) -> Body {
    Body::new(Body::from(bytes.into()).map_frame(move |frame| {
        let _held = &permit;
        frame
    }))
}

pub(super) fn expand_response_reservation(
    state: &AppState,
    permit: &mut tokio::sync::OwnedSemaphorePermit,
    byte_size: usize,
) -> Result<(), AppError> {
    if byte_size as u64 > u64::from(RESPONSE_MEMORY_MIB) * MIB {
        return Err(AppError::unprocessable(
            "Response exceeds the memory budget",
        ));
    }
    let extra = byte_size
        .div_ceil(MIB as usize)
        .saturating_sub(permit.num_permits());
    if extra > 0 {
        permit.merge(reserve_response(state, (extra as u64) * MIB)?);
    }
    Ok(())
}

#[cfg(test)]
mod response_budget_tests {
    use super::*;

    #[test]
    fn response_releases_memory_only_when_body_is_dropped() {
        let memory = Arc::new(tokio::sync::Semaphore::new(1));
        let permit = memory.clone().try_acquire_owned().unwrap();
        let body = budgeted_body(Bytes::from_static(b"mesh"), permit);
        assert_eq!(memory.available_permits(), 0);
        drop(body);
        assert_eq!(memory.available_permits(), 1);
    }
}

pub(super) fn lod_memory_permits(byte_size: u64) -> u32 {
    byte_size
        .saturating_mul(LOD_MEMORY_EXPANSION)
        .div_ceil(MIB)
        .clamp(1, u64::from(LOD_MEMORY_MIB)) as u32
}

pub(super) async fn reshare(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    AxumPath(token): AxumPath<String>,
    headers: HeaderMap,
    Json(body): Json<serde_json::Value>,
) -> Result<impl IntoResponse, AppError> {
    let opened = open_scene(&state, &token, peer.ip())?;
    if opened.scene.collection.is_none() {
        source_result(
            &state,
            &token,
            state.registry.sources.validate_source(&opened.scene),
        )?;
    }
    let owner = owner_matches(&headers, &state, &opened);
    let mut scene = opened.scene;
    if !is_short_secret(&token) && scene.ttl_days.is_none() {
        scene.ttl_days = Some(0);
    }
    let origin_request = body
        .get("origin")
        .and_then(|v| v.as_str())
        .map(str::to_owned);
    if scene.collection.is_some() {
        let active = body
            .get("active_scene_id")
            .and_then(|v| v.as_str())
            .ok_or_else(|| AppError::bad_request("active_scene_id is required"))?
            .to_owned();
        if scene.scene_by_id(&active).is_none() {
            return Err(AppError::bad_request("unknown active_scene_id"));
        }
        let updates = body
            .get("updates")
            .and_then(|v| v.as_object())
            .ok_or_else(|| AppError::bad_request("updates must be an object"))?;
        for (id, value) in updates {
            let target = scene
                .scene_by_id_mut(id)
                .ok_or_else(|| AppError::bad_request("unknown scene update ID"))?;
            target.entities = target.entity_descriptors();
            let update: SceneUpdate = serde_json::from_value(value.clone())
                .map_err(|e| AppError::unprocessable(&e.to_string()))?;
            target
                .apply_update(update)
                .map_err(|e| AppError::bad_request(&e.to_string()))?;
        }
        let collection = scene.collection.as_mut().unwrap();
        if let Some(value) = body.get("strokes") {
            let strokes: Vec<crate::scene::ScreenStroke> = serde_json::from_value(value.clone())
                .map_err(|e| AppError::unprocessable(&e.to_string()))?;
            crate::scene::validate_screen_strokes(&strokes)
                .map_err(|e| AppError::bad_request(&e.to_string()))?;
            collection.strokes = strokes;
        }
        if let Some(value) = body.get("layout") {
            let layout: crate::scene::CollectionLayout = serde_json::from_value(value.clone())
                .map_err(|e| AppError::unprocessable(&e.to_string()))?;
            layout
                .validate(collection.scenes.len() + 1)
                .map_err(|e| AppError::bad_request(&e.to_string()))?;
            collection.layout = Some(layout);
        }
        collection.active_scene_id = active;
    } else {
        let request: ReshareRequest =
            serde_json::from_value(body).map_err(|e| AppError::unprocessable(&e.to_string()))?;
        scene.entities = scene.entity_descriptors();
        scene
            .apply_update(request.update)
            .map_err(|error| AppError::bad_request(&error.to_string()))?;
    }
    let current_origin = request_origin(&headers, &state.config)?;
    let hosts = share_hosts(&state.config, &current_origin)?;
    let origin = select_share_origin(&state.config, origin_request, &current_origin, &hosts)?;
    Ok((
        no_store(),
        Json(ShareResponse {
            links: links_for(&state.registry, &scene, &origin, owner)?,
            origin,
            hosts,
        }),
    ))
}

pub(super) async fn render_image(
    Query(query): Query<HashMap<String, String>>,
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    AxumPath(token): AxumPath<String>,
) -> Result<Response<Body>, AppError> {
    let _permit = state
        .image_slots
        .try_acquire()
        .map_err(|_| AppError::too_many_requests("Image renderer is busy"))?;
    let token = token.strip_suffix(".png").unwrap_or(&token);
    let opened = open_scene(&state, token, peer.ip())?;
    let bytes = if let Some(collection) = &opened.scene.collection {
        if let Some(id) = query.get("scene") {
            let scene = selected_scene(&opened.scene, Some(id))?;
            render_single_image(&state, token, scene, Some(id), true, None).await?
        } else {
            tokio::time::timeout(Duration::from_secs(180), async {
                let mut images = Vec::with_capacity(collection.scenes.len() + 1);
                for (index, (id, scene)) in std::iter::once((&collection.first_id, &opened.scene))
                    .chain(
                        collection
                            .scenes
                            .iter()
                            .map(|entry| (&entry.id, &entry.scene)),
                    )
                    .enumerate()
                {
                    let size = crate::collection_image::scene_viewport_size(
                        collection.scenes.len() + 1,
                        collection.layout,
                        index,
                    )
                    .map_err(|error| AppError::internal(&error.to_string()))?;
                    let png = render_single_image(&state, token, scene, Some(id), true, Some(size))
                        .await?;
                    images.push((id.clone(), scene.title.clone(), png));
                }
                let active = collection.active_scene_id.clone();
                let layout = collection.layout;
                let strokes = collection.strokes.clone();
                tokio::task::spawn_blocking(move || {
                    crate::collection_image::compose(&images, &active, layout, &strokes)
                })
                .await
                .map_err(|error| AppError::internal(&error.to_string()))?
                .map_err(|error| AppError::internal(&error.to_string()))
            })
            .await
            .map_err(|_| AppError::unprocessable("Collection image export timed out"))??
        }
    } else {
        let scene = selected_scene(&opened.scene, query.get("scene").map(String::as_str))?;
        render_single_image(&state, token, scene, None, false, None).await?
    };
    let response_permit = reserve_response(&state, bytes.len() as u64)?;
    Ok(Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "image/png")
        .header(header::CACHE_CONTROL, NO_STORE)
        .header(header::CONTENT_LENGTH, bytes.len())
        .body(budgeted_body(bytes, response_permit))?)
}

async fn render_single_image(
    state: &AppState,
    token: &str,
    scene: &SceneDescriptor,
    scene_id: Option<&str>,
    in_collection: bool,
    render_size: Option<(u32, u32)>,
) -> Result<Vec<u8>, AppError> {
    let mut render_scene = scene.clone();
    if let Some((width, height)) = render_size {
        render_scene.state.frame.width = width;
        render_scene.state.frame.height = height;
    }
    let source_token = if in_collection { "" } else { token };
    source_result(
        state,
        source_token,
        state.registry.sources.validate_source(scene),
    )?;
    // The Viewer loads geometry and surfaces eagerly, including hidden entries.
    // Bound their aggregate input before starting either renderer. ZIP members
    // reserve their decompressed limit, not the much smaller archive size.
    let source_bytes = scene
        .meshes
        .iter()
        .map(|m| m.byte_size)
        .chain(
            scene
                .entities
                .iter()
                .filter_map(|c| match c.source {
                    crate::component::ComponentSource::Attachment(i) => scene.attachments.get(i),
                    _ => None,
                })
                .map(|a| {
                    if a.member.is_some() {
                        64 * 1024 * 1024
                    } else {
                        a.byte_size.unwrap_or(0)
                    }
                }),
        )
        .try_fold(0_u64, |total, size| total.checked_add(size))
        .ok_or_else(|| AppError::unprocessable("source size overflow"))?;
    if source_bytes > crate::source::MAX_SOURCE_BYTES {
        return Err(AppError::unprocessable("image sources exceed 512 MiB"));
    }
    if !scene.entities.is_empty() || scene.state.section.is_some() {
        let url = format!(
            "http://{}{}/s/{}?render=1{}",
            control_address(&state.config)?,
            state.config.base_path().unwrap_or_default(),
            token,
            scene_id
                .map(|id| format!("&scene={id}"))
                .unwrap_or_default()
        );
        let bytes = crate::render_viewer::render(&url,render_scene.state.frame.width,render_scene.state.frame.height).await.map_err(|error| {
            tracing::warn!(%error,"full scene image render failed");
            AppError::unprocessable("Full scene export failed; check component availability and the Server Chromium installation")
        })?;
        source_result(
            state,
            source_token,
            state.registry.sources.validate_source(scene),
        )?;
        return Ok(bytes);
    }
    let mut sources = Vec::with_capacity(scene.meshes.len());
    for (index, mesh) in scene.meshes.iter().enumerate() {
        if mesh.visible
            && mesh.quality == MeshQuality::Lod
            && mesh.format != MeshFormat::Pts
            && !scene
                .state
                .annotations
                .iter()
                .any(|mark| mark.mesh == index)
        {
            let asset = scene_lod(state, source_token, scene, index).await?;
            render_scene.meshes[index].format = MeshFormat::Ply;
            render_scene.meshes[index].byte_size = asset.bytes.len() as u64;
            sources.push(Some(asset.bytes.to_vec()));
            continue;
        }
        if mesh.visible {
            sources.push(Some(
                source_result(
                    state,
                    source_token,
                    state.registry.sources.read_mesh(scene, mesh, true).await,
                )?
                .bytes,
            ));
        } else {
            sources.push(None);
        }
    }
    let renderer = state
        .renderer
        .as_ref()
        .ok_or_else(|| AppError::unavailable("Image renderer unavailable"))?;
    let bytes = renderer
        .render(&render_scene, sources)
        .await
        .map_err(|error| {
            tracing::warn!(%error, "image render failed");
            AppError::unprocessable("Image render failed")
        })?;
    for mesh in scene.meshes.iter().filter(|mesh| mesh.visible) {
        source_result(
            state,
            source_token,
            state
                .registry
                .sources
                .validate_mesh_metadata(scene, mesh)
                .await,
        )?;
    }
    Ok(bytes)
}

fn serve_index(base_path: Option<String>) -> Result<Response<Body>, AppError> {
    let asset =
        WebAssets::get("index.html").ok_or_else(|| AppError::not_found("Viewer not built"))?;
    // Anchor every relative URL (API fetches, bundled assets) to the configured
    // base path so the viewer works under both mounts. With no base path this
    // resolves to "/" which preserves the original absolute-path behavior.
    let href = format!("{}/", base_path.as_deref().unwrap_or_default());
    let html = String::from_utf8_lossy(&asset.data).replacen(
        "<head>",
        &format!("<head>\n    <base href=\"{href}\">"),
        1,
    );
    Ok(Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
        .header(header::CACHE_CONTROL, NO_STORE)
        .body(Body::from(html))?)
}

pub(super) async fn index(State(state): State<AppState>) -> Result<Response<Body>, AppError> {
    serve_index(state.config.base_path())
}

pub(super) async fn view_scene(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    AxumPath(token): AxumPath<String>,
) -> Result<Response<Body>, AppError> {
    let opened = open_scene(&state, &token, peer.ip())?;
    if opened.scene.collection.is_none() {
        source_result(
            &state,
            &token,
            state.registry.sources.validate_source(&opened.scene),
        )?;
    }
    let mut response = serve_index(state.config.base_path())?;
    let mut scenes = vec![&opened.scene];
    if let Some(collection) = &opened.scene.collection {
        scenes.extend(collection.scenes.iter().map(|entry| &entry.scene));
    }
    let mut origins: Vec<_> = scenes
        .into_iter()
        .flat_map(|scene| &scene.entities)
        .filter_map(|c| c.renderer.as_ref())
        .flat_map(|r| r.frame_origins.iter())
        .cloned()
        .collect();
    origins.sort();
    origins.dedup();
    for origin in &origins {
        let url = url::Url::parse(origin).map_err(anyhow::Error::from)?;
        if url.scheme() != "https" || url.origin().ascii_serialization() != *origin {
            return Err(AppError::unprocessable("Invalid renderer frame origin"));
        }
    }
    let frame_ancestors = if opened.scene.collection.is_some() {
        "'self'"
    } else {
        "'none'"
    };
    let policy = format!(
        "default-src 'self'; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-src 'self' {}; object-src 'none'; base-uri 'self'; frame-ancestors {frame_ancestors}",
        origins.join(" ")
    );
    response.headers_mut().insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_str(&policy).map_err(anyhow::Error::from)?,
    );
    Ok(response)
}

pub(super) async fn asset(
    State(state): State<AppState>,
    uri: axum::http::Uri,
) -> Result<Response<Body>, AppError> {
    let path = match state.config.base_path() {
        // Only strip when the remainder starts with its own segment boundary,
        // so look-alike prefixes (e.g. /blindfoo under base /blind) stay intact.
        Some(base) => uri
            .path()
            .strip_prefix(&base)
            .filter(|rest| rest.starts_with('/'))
            .unwrap_or(uri.path())
            .trim_start_matches('/')
            .to_owned(),
        None => uri.path().trim_start_matches('/').to_owned(),
    };
    let asset = WebAssets::get(&path).ok_or_else(|| AppError::not_found("Not found"))?;
    let mime = mime_guess::from_path(&path).first_or_octet_stream();
    Ok(Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, mime.as_ref())
        .header(
            header::CACHE_CONTROL,
            if path.starts_with("assets/") {
                "public, max-age=31536000, immutable"
            } else {
                "no-cache"
            },
        )
        .body(Body::from(asset.data.into_owned()))?)
}
