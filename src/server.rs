use std::{net::SocketAddr, sync::Arc};

use axum::{
    Json, Router,
    body::Body,
    extract::{Path as AxumPath, State},
    http::{HeaderMap, HeaderValue, Response, StatusCode, header},
    response::{Html, IntoResponse},
    routing::{get, post},
};
use rust_embed::RustEmbed;
use serde::{Deserialize, Serialize};
use tower_http::{compression::CompressionLayer, trace::TraceLayer};

use crate::{
    config::{Config, normalize_origin},
    network::{HostCandidate, discover},
    render::Renderer,
    scene::{SceneDescriptor, SceneGone, SceneUpdate},
    token::{Scope, TokenCodec},
};

#[derive(RustEmbed)]
#[folder = "web/dist/"]
struct WebAssets;

#[derive(Clone)]
pub struct AppState {
    pub config: Arc<Config>,
    pub codec: TokenCodec,
    pub renderer: Option<Arc<Renderer>>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ShareLinks {
    pub viewer_url: String,
    pub image_url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owner_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub full_text: Option<String>,
}

#[derive(Debug, Serialize)]
struct ShareResponse {
    #[serde(flatten)]
    links: ShareLinks,
    hosts: Vec<HostCandidate>,
}

#[derive(Debug, Deserialize)]
struct CreateSceneRequest {
    paths: Vec<String>,
    title: Option<String>,
    origin: Option<String>,
}

#[derive(Debug, Serialize)]
struct HealthResponse {
    status: &'static str,
    version: &'static str,
    image_renderer: bool,
}

#[derive(Debug, Serialize)]
struct PublicScene {
    title: String,
    meshes: Vec<PublicMesh>,
    state: crate::scene::ViewState,
    owner: bool,
}

#[derive(Debug, Serialize)]
struct PublicMesh {
    name: String,
    format: crate::scene::MeshFormat,
    revision: String,
    byte_size: u64,
    color: String,
    opacity: f32,
    visible: bool,
    source_url: String,
}

pub async fn serve(config: Config, listen_override: Option<String>) -> anyhow::Result<()> {
    let listen = listen_override.unwrap_or_else(|| config.listen.clone());
    let address: SocketAddr = listen.parse()?;
    let codec = TokenCodec::new(config.secret_bytes()?);
    let renderer = match Renderer::new().await {
        Ok(renderer) => Some(Arc::new(renderer)),
        Err(error) => {
            tracing::warn!(%error, "instant image rendering is unavailable");
            None
        }
    };
    let state = AppState {
        config: Arc::new(config),
        codec,
        renderer,
    };
    let app = Router::new()
        .route("/api/v1/health", get(health))
        .route("/api/v1/hosts", get(hosts))
        .route("/api/v1/scenes", post(create_scene))
        .route("/api/v1/scenes/{token}", get(get_scene))
        .route("/api/v1/scenes/{token}/meshes/{index}", get(get_mesh))
        .route("/api/v1/scenes/{token}/share", post(reshare))
        .route("/i/{*token}", get(render_image))
        .route("/v/{token}", get(view_scene))
        .route("/", get(index))
        .fallback(asset)
        .layer(CompressionLayer::new())
        .layer(TraceLayer::new_for_http())
        .with_state(state);
    let listener = tokio::net::TcpListener::bind(address).await?;
    tracing::info!(%address, "Blind is ready");
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown())
        .await?;
    Ok(())
}

pub fn links_for(
    codec: &TokenCodec,
    scene: &SceneDescriptor,
    origin: &str,
    include_owner: bool,
) -> anyhow::Result<ShareLinks> {
    let public_token = codec.seal(Scope::Public, scene)?;
    let viewer_url = format!("{origin}/v/{public_token}");
    let image_url = format!("{origin}/i/{public_token}.png");
    let owner_url = if include_owner {
        let owner_token = codec.seal(Scope::Owner, scene)?;
        Some(format!("{viewer_url}#owner={owner_token}"))
    } else {
        None
    };
    let full_text = include_owner.then(|| scene.full_text(&viewer_url, &image_url));
    Ok(ShareLinks {
        viewer_url,
        image_url,
        owner_url,
        full_text,
    })
}

async fn health(State(state): State<AppState>) -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "ok",
        version: env!("CARGO_PKG_VERSION"),
        image_renderer: state.renderer.is_some(),
    })
}

async fn hosts(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<impl IntoResponse, AppError> {
    require_pat(&headers, &state.config)?;
    Ok((
        no_store(),
        Json(discover(
            state.config.port()?,
            state.config.preferred_origin.as_deref(),
        )?),
    ))
}

async fn create_scene(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<CreateSceneRequest>,
) -> Result<impl IntoResponse, AppError> {
    require_pat(&headers, &state.config)?;
    let paths = request
        .paths
        .into_iter()
        .map(Into::into)
        .collect::<Vec<_>>();
    let scene = SceneDescriptor::create(&paths, request.title).await?;
    let origin = match request.origin {
        Some(origin) => normalize_origin(&origin)?,
        None => request_origin(&headers, &state.config)?,
    };
    let links = links_for(&state.codec, &scene, &origin, true)?;
    let hosts = discover(
        state.config.port()?,
        state.config.preferred_origin.as_deref(),
    )?;
    Ok((no_store(), Json(ShareResponse { links, hosts })))
}

async fn get_scene(
    State(state): State<AppState>,
    AxumPath(token): AxumPath<String>,
    headers: HeaderMap,
) -> Result<impl IntoResponse, AppError> {
    let envelope = state
        .codec
        .open(&token)
        .map_err(|_| AppError::not_found("Scene not found"))?;
    envelope.scene.validate().await?;
    let owner = owner_matches(&headers, &state.codec, &envelope.scene);
    let scene = envelope.scene;
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
            source_url: format!("/api/v1/scenes/{token}/meshes/{index}"),
        })
        .collect();
    Ok((
        no_store(),
        Json(PublicScene {
            title: scene.title,
            meshes,
            state: scene.state,
            owner,
        }),
    ))
}

async fn get_mesh(
    State(state): State<AppState>,
    AxumPath((token, index)): AxumPath<(String, usize)>,
) -> Result<Response<Body>, AppError> {
    let envelope = state
        .codec
        .open(&token)
        .map_err(|_| AppError::not_found("Scene not found"))?;
    envelope.scene.validate().await?;
    let mesh = envelope
        .scene
        .meshes
        .get(index)
        .ok_or_else(|| AppError::not_found("Mesh not found"))?;
    let bytes = tokio::fs::read(&mesh.path).await.map_err(|_| SceneGone)?;
    Ok(Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, mesh.format.mime())
        .header(header::CACHE_CONTROL, "no-store, max-age=0")
        .body(Body::from(bytes))?)
}

async fn reshare(
    State(state): State<AppState>,
    AxumPath(token): AxumPath<String>,
    headers: HeaderMap,
    Json(update): Json<SceneUpdate>,
) -> Result<impl IntoResponse, AppError> {
    let envelope = state
        .codec
        .open(&token)
        .map_err(|_| AppError::not_found("Scene not found"))?;
    envelope.scene.validate().await?;
    let owner = owner_matches(&headers, &state.codec, &envelope.scene);
    let mut scene = envelope.scene;
    scene
        .apply_update(update)
        .map_err(|error| AppError::bad_request(&error.to_string()))?;
    let origin = request_origin(&headers, &state.config)?;
    Ok((
        no_store(),
        Json(links_for(&state.codec, &scene, &origin, owner)?),
    ))
}

async fn render_image(
    State(state): State<AppState>,
    AxumPath(token): AxumPath<String>,
) -> Result<Response<Body>, AppError> {
    let token = token.strip_suffix(".png").unwrap_or(&token);
    let envelope = state
        .codec
        .open(token)
        .map_err(|_| AppError::not_found("Scene not found"))?;
    envelope.scene.validate().await?;
    let renderer = state
        .renderer
        .as_ref()
        .ok_or_else(|| AppError::unavailable("Image renderer unavailable"))?;
    let bytes = renderer.render(&envelope.scene).await.map_err(|error| {
        tracing::warn!(%error, "image render failed");
        AppError::unprocessable("Image render failed")
    })?;
    Ok(Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "image/png")
        .header(header::CACHE_CONTROL, "no-store, max-age=0")
        .header(header::CONTENT_LENGTH, bytes.len())
        .body(Body::from(bytes))?)
}

async fn index() -> Result<Html<Vec<u8>>, AppError> {
    let asset =
        WebAssets::get("index.html").ok_or_else(|| AppError::not_found("Viewer not built"))?;
    Ok(Html(asset.data.into_owned()))
}

async fn view_scene(
    State(state): State<AppState>,
    AxumPath(token): AxumPath<String>,
) -> Result<Response<Body>, AppError> {
    let envelope = state
        .codec
        .open(&token)
        .map_err(|_| AppError::not_found("Scene not found"))?;
    envelope.scene.validate().await?;
    let asset =
        WebAssets::get("index.html").ok_or_else(|| AppError::not_found("Viewer not built"))?;
    Ok(Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
        .header(header::CACHE_CONTROL, "no-store, max-age=0")
        .body(Body::from(asset.data.into_owned()))?)
}

async fn asset(uri: axum::http::Uri) -> Result<Response<Body>, AppError> {
    let path = uri.path().trim_start_matches('/');
    let asset = WebAssets::get(path).ok_or_else(|| AppError::not_found("Not found"))?;
    let mime = mime_guess::from_path(path).first_or_octet_stream();
    Ok(Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, mime.as_ref())
        .header(
            header::CACHE_CONTROL,
            if path.contains('-') {
                "public, max-age=31536000, immutable"
            } else {
                "no-cache"
            },
        )
        .body(Body::from(asset.data.into_owned()))?)
}

fn require_pat(headers: &HeaderMap, config: &Config) -> Result<(), AppError> {
    let token = bearer(headers).ok_or_else(|| AppError::unauthorized("PAT required"))?;
    if config.verify_pat(token) {
        Ok(())
    } else {
        Err(AppError::unauthorized("Invalid PAT"))
    }
}

fn bearer(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(header::AUTHORIZATION)?
        .to_str()
        .ok()?
        .strip_prefix("Bearer ")
}

fn owner_matches(headers: &HeaderMap, codec: &TokenCodec, scene: &SceneDescriptor) -> bool {
    let Some(token) = bearer(headers) else {
        return false;
    };
    let Ok(owner) = codec.open(token) else {
        return false;
    };
    owner.scope == Scope::Owner && same_sources(&owner.scene, scene)
}

fn same_sources(a: &SceneDescriptor, b: &SceneDescriptor) -> bool {
    a.meshes.len() == b.meshes.len()
        && a.meshes
            .iter()
            .zip(&b.meshes)
            .all(|(a, b)| a.path == b.path && a.revision == b.revision)
}

fn request_origin(headers: &HeaderMap, config: &Config) -> Result<String, AppError> {
    if let Some(origin) = headers
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok())
        && let Ok(origin) = normalize_origin(origin)
    {
        return Ok(origin);
    }
    let scheme = headers
        .get("x-forwarded-proto")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(',').next())
        .filter(|value| matches!(value.trim(), "http" | "https"))
        .unwrap_or("http")
        .trim();
    let host = headers
        .get("x-forwarded-host")
        .or_else(|| headers.get(header::HOST))
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(',').next())
        .map(str::trim);
    if matches!(scheme, "http" | "https")
        && let Some(host) = host
    {
        return normalize_origin(&format!("{scheme}://{host}")).map_err(Into::into);
    }
    let hosts = discover(config.port()?, config.preferred_origin.as_deref())?;
    hosts
        .first()
        .map(|host| host.origin.clone())
        .ok_or_else(|| AppError::internal("No host address available"))
}

async fn shutdown() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let terminate = async {
        if let Ok(mut signal) =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        {
            signal.recv().await;
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! { _ = ctrl_c => {}, _ = terminate => {} }
}

#[derive(Debug)]
pub struct AppError {
    status: StatusCode,
    message: String,
}

impl AppError {
    fn bad_request(message: &str) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            message: message.into(),
        }
    }
    fn not_found(message: &str) -> Self {
        Self {
            status: StatusCode::NOT_FOUND,
            message: message.into(),
        }
    }
    fn unauthorized(message: &str) -> Self {
        Self {
            status: StatusCode::UNAUTHORIZED,
            message: message.into(),
        }
    }
    fn unavailable(message: &str) -> Self {
        Self {
            status: StatusCode::SERVICE_UNAVAILABLE,
            message: message.into(),
        }
    }
    fn unprocessable(message: &str) -> Self {
        Self {
            status: StatusCode::UNPROCESSABLE_ENTITY,
            message: message.into(),
        }
    }
    fn internal(message: &str) -> Self {
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            message: message.into(),
        }
    }
}

fn no_store() -> [(header::HeaderName, HeaderValue); 1] {
    [(
        header::CACHE_CONTROL,
        HeaderValue::from_static("no-store, max-age=0"),
    )]
}

impl IntoResponse for AppError {
    fn into_response(self) -> axum::response::Response {
        (
            self.status,
            [(header::CACHE_CONTROL, HeaderValue::from_static("no-store"))],
            Json(serde_json::json!({ "error": self.message })),
        )
            .into_response()
    }
}

impl From<anyhow::Error> for AppError {
    fn from(error: anyhow::Error) -> Self {
        Self::internal(&error.to_string())
    }
}
impl From<SceneGone> for AppError {
    fn from(_: SceneGone) -> Self {
        Self {
            status: StatusCode::GONE,
            message: "Scene source changed or disappeared".into(),
        }
    }
}
impl From<axum::http::Error> for AppError {
    fn from(error: axum::http::Error) -> Self {
        Self::internal(&error.to_string())
    }
}
