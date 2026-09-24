use super::*;

pub(in crate::server) async fn client_plugins(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<impl IntoResponse, AppError> {
    client_auth(&state, &headers, false)?;
    let dir = config_path()?
        .parent()
        .context("missing config parent")?
        .to_owned();
    Ok((no_store(), Json(crate::plugin::list(&dir)?)))
}

pub(in crate::server) async fn get_attachment(
    Query(query): Query<HashMap<String, String>>,
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    AxumPath((token, index)): AxumPath<(String, usize)>,
) -> Result<Response<Body>, AppError> {
    let opened = open_scene(&state, &token, peer.ip())?;
    let scene = selected_scene(&opened.scene, query.get("scene").map(String::as_str))?.clone();
    source_result(
        &state,
        if opened.scene.collection.is_some() {
            ""
        } else {
            &token
        },
        state.registry.sources.validate_source(&scene),
    )?;
    let a = scene
        .attachments
        .get(index)
        .ok_or_else(|| AppError::not_found("Attachment not found"))?;
    let revision = a.revision.as_ref().ok_or_else(|| {
        AppError::unavailable("Attachment was unavailable when this scene was created")
    })?;
    let mut response_permit = reserve_response(
        &state,
        a.byte_size.unwrap_or(crate::source::MAX_SOURCE_BYTES),
    )?;
    let observed = state
        .registry
        .sources
        .observe(scene.source.as_ref(), &a.path, true)
        .await
        .map_err(|e| match e {
            SourceError::Gone => AppError::gone("Attachment deleted"),
            _ => AppError::unavailable("Attachment unavailable"),
        })?;
    if &observed.revision != revision {
        return Err(AppError::gone("Attachment changed"));
    }
    let bytes = if let Some(member) = &a.member {
        crate::archive::read_member(&observed.bytes, member)
            .map_err(|_| AppError::unavailable("Archive member unavailable"))?
    } else {
        observed.bytes
    };
    expand_response_reservation(&state, &mut response_permit, bytes.len())?;
    if query.get("embed").is_some_and(|v| v == "1") {
        let html = scene.components.iter().any(|c| {
            c.component == crate::component::ComponentKind::Html
                && c.source == crate::component::ComponentSource::Attachment(index)
        });
        if !html {
            return Err(AppError::bad_request(
                "Only HTML components support embedding",
            ));
        }
        return Ok(Response::builder().status(StatusCode::OK)
            .header(header::CACHE_CONTROL, NO_STORE)
            .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
            .header("content-security-policy", "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; frame-ancestors 'self'; base-uri 'none'; form-action 'none'")
            .body(budgeted_body(bytes, response_permit))?);
    }
    let name = if crate::oss::is_oss(&a.path) {
        crate::oss::Location::parse(&a.path)?.key.to_string()
    } else {
        a.path.clone()
    };
    let name = name.rsplit('/').next().unwrap_or("attachment");
    // RFC 5987 encoding, never interpolate raw source text into HTTP headers.
    let encoded: String = url::form_urlencoded::byte_serialize(name.as_bytes()).collect();
    Ok(Response::builder()
        .status(StatusCode::OK)
        .header(header::CACHE_CONTROL, NO_STORE)
        .header(header::CONTENT_TYPE, "application/octet-stream")
        .header(
            header::CONTENT_DISPOSITION,
            format!(
                "attachment; filename=\"attachment\"; filename*=UTF-8''{}",
                encoded.replace('+', "%20")
            ),
        )
        .body(budgeted_body(bytes, response_permit))?)
}

pub(in crate::server) async fn get_renderer(
    Query(query): Query<HashMap<String, String>>,
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    AxumPath((token, id)): AxumPath<(String, String)>,
) -> Result<Response<Body>, AppError> {
    let opened = open_scene(&state, &token, peer.ip())?;
    let scene = selected_scene(&opened.scene, query.get("scene").map(String::as_str))?;
    source_result(
        &state,
        if opened.scene.collection.is_some() {
            ""
        } else {
            &token
        },
        state.registry.sources.validate_source(scene),
    )?;
    let binding = scene
        .components
        .iter()
        .find(|c| c.id == id)
        .and_then(|c| c.renderer.as_ref())
        .ok_or_else(|| AppError::not_found("Renderer not found"))?;
    let (bytes, origins) = crate::plugin::renderer_document(binding)
        .map_err(|_| AppError::unavailable("Pinned renderer unavailable"))?;
    let policy = format!(
        "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; frame-src {}; frame-ancestors 'self'; base-uri 'none'; form-action 'none'",
        if origins.is_empty() {
            "'none'".into()
        } else {
            origins.join(" ")
        }
    );
    Ok(Response::builder()
        .header(header::CACHE_CONTROL, NO_STORE)
        .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
        .header("content-security-policy", policy)
        .body(Body::from(bytes))?)
}
