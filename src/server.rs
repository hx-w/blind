#[cfg(not(target_os = "linux"))]
use std::process::Command;
use std::{
    collections::HashMap,
    fs,
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr},
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use anyhow::Context;
use axum::{
    Json, Router,
    body::Body,
    extract::{ConnectInfo, DefaultBodyLimit, FromRequestParts, Path as AxumPath, State},
    http::{HeaderMap, HeaderValue, Method, Request, Response, StatusCode, header, request::Parts},
    response::IntoResponse,
    routing::{get, post},
};
use bytes::Bytes;
use http_body_util::{BodyExt, Empty};
use hyper_util::{
    client::legacy::{Client, connect::HttpConnector},
    rt::TokioExecutor,
};
use rust_embed::RustEmbed;
use serde::{Deserialize, Serialize};
use tower_http::set_header::SetResponseHeaderLayer;
use tower_http::{compression::CompressionLayer, trace::TraceLayer};

use crate::source::{FinishRequest, JoinRequest, Source, SourceError};
use crate::{
    config::{Config, config_path, normalize_origin},
    lod::{self, LodAsset, LodCache, LodCacheStats},
    mesh,
    network::{HostCandidate, discover},
    registry::{RegisteredScene, Registry, RegistryAudit, RegistryLookupError, is_short_secret},
    render::Renderer,
    scene::{MeshFormat, MeshQuality, SceneDescriptor, SceneGone, SceneUpdate},
    token::{Scope, TokenCodec},
};

#[derive(RustEmbed)]
#[folder = "web/dist/"]
struct WebAssets;

#[derive(Clone)]
pub struct AppState {
    pub config: Arc<Config>,
    pub codec: TokenCodec,
    pub registry: Arc<Registry>,
    pub renderer: Option<Arc<Renderer>>,
    pub image_slots: Arc<tokio::sync::Semaphore>,
    pub lod_slots: Arc<tokio::sync::Semaphore>,
    pub lod_memory: Arc<tokio::sync::Semaphore>,
    join_slots: Arc<tokio::sync::Semaphore>,
    plugin_slots: Arc<tokio::sync::Semaphore>,
    pub lod_cache: LodCache,
    pub shutdown: tokio::sync::mpsc::Sender<()>,
    doctor_lock: Arc<tokio::sync::Mutex<()>>,
    short_misses: Arc<Mutex<MissLimiter>>,
}

const LOD_MEMORY_MIB: u32 = 512;
const LOD_MEMORY_EXPANSION: u64 = 3;
const MIB: u64 = 1024 * 1024;

#[derive(Default)]
struct MissLimiter {
    clients: HashMap<IpAddr, MissWindow>,
}

struct MissWindow {
    started: Instant,
    misses: u16,
}

pub struct ServerLease {
    #[cfg(not(target_os = "linux"))]
    path: PathBuf,
    #[cfg(not(target_os = "linux"))]
    pid: u32,
    #[cfg(target_os = "linux")]
    _file: fs::File,
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
pub struct ShareResponse {
    #[serde(flatten)]
    links: ShareLinks,
    /// Origin used to compose the links, echoed for the share-sheet host picker.
    origin: String,
    hosts: Vec<HostCandidate>,
}

#[derive(Debug, Deserialize)]
struct CreateSceneRequest {
    #[serde(default)]
    manifest: Option<crate::plugin::ShareManifest>,
    #[serde(default)]
    paths: Vec<String>,
    title: Option<String>,
    origin: Option<String>,
    labels: Option<Vec<Option<crate::scene::MeshLabel>>>,
    #[serde(default)]
    label_groups: Vec<crate::scene::MeshLabelGroup>,
    #[serde(default)]
    stateless: bool,
}

#[derive(Debug, Deserialize)]
struct ReshareRequest {
    #[serde(flatten)]
    update: SceneUpdate,
    origin: Option<String>,
}

#[derive(Debug, Serialize)]
struct HealthResponse {
    status: &'static str,
    version: &'static str,
    scene_schema: u8,
    image_renderer: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ControlHealth {
    service: String,
    pub pid: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
}

#[derive(Debug, Clone, Copy)]
pub enum DoctorAction {
    Audit,
    CleanInvalid,
    ClearAll,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DoctorRegistryReport {
    #[serde(default)]
    pub unavailable: usize,
    pub valid: usize,
    pub expired: usize,
    pub source_gone: usize,
    pub tombstoned: usize,
    pub corrupt: usize,
    pub removed: usize,
    pub preserved: usize,
    pub key_repaired: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lod_cache: Option<LodCacheStats>,
}

impl DoctorRegistryReport {
    pub fn new(audit: &RegistryAudit, removed: usize) -> Self {
        Self {
            valid: audit.valid,
            unavailable: audit.unavailable,
            expired: audit.expired,
            source_gone: audit.source_gone,
            tombstoned: audit.tombstoned,
            corrupt: audit.corrupt,
            removed,
            preserved: audit.invalid().saturating_sub(removed),
            key_repaired: false,
            lod_cache: None,
        }
    }

    pub fn invalid(&self) -> usize {
        self.expired + self.source_gone + self.tombstoned + self.corrupt
    }

    /// Report for an offline clear that removed every link without auditing it.
    pub fn cleared(removed: usize) -> Self {
        Self {
            valid: 0,
            unavailable: 0,
            expired: 0,
            source_gone: 0,
            tombstoned: 0,
            corrupt: removed,
            removed,
            preserved: 0,
            key_repaired: false,
            lod_cache: None,
        }
    }

    pub fn total(&self) -> usize {
        self.valid + self.unavailable + self.invalid()
    }
}

#[derive(Debug, Serialize)]
struct PublicScene {
    source: Option<crate::source::SceneSource>,
    title: String,
    meshes: Vec<PublicMesh>,
    label_groups: Vec<crate::scene::MeshLabelGroup>,
    state: crate::scene::ViewState,
    owner: bool,
    attachments: Vec<serde_json::Value>,
    warnings: Vec<crate::plugin::Warning>,
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
    quality: MeshQuality,
    label: Option<crate::scene::MeshLabel>,
    source_url: String,
    translation: [f32; 3],
}

pub async fn serve(config: Config) -> anyhow::Result<()> {
    let _lease = ServerLease::acquire()?;
    let address: SocketAddr = config.listen.parse()?;
    let listener = tokio::net::TcpListener::bind(address).await?;
    let codec = TokenCodec::new(config.secret_bytes()?);
    let registry = Arc::new(Registry::open(&config)?);
    let renderer = match Renderer::new().await {
        Ok(renderer) => Some(Arc::new(renderer)),
        Err(error) => {
            tracing::warn!(%error, "instant image rendering is unavailable");
            None
        }
    };
    let (shutdown_tx, shutdown_rx) = tokio::sync::mpsc::channel(1);
    let state = AppState {
        config: Arc::new(config.clone()),
        codec,
        registry,
        renderer,
        image_slots: Arc::new(tokio::sync::Semaphore::new(2)),
        lod_slots: Arc::new(tokio::sync::Semaphore::new(2)),
        lod_memory: Arc::new(tokio::sync::Semaphore::new(LOD_MEMORY_MIB as usize)),
        join_slots: Arc::new(tokio::sync::Semaphore::new(2)),
        plugin_slots: Arc::new(tokio::sync::Semaphore::new(2)),
        lod_cache: LodCache::default(),
        shutdown: shutdown_tx,
        doctor_lock: Arc::new(tokio::sync::Mutex::new(())),
        short_misses: Arc::new(Mutex::new(MissLimiter::default())),
    };
    let routes = Router::new()
        .route("/api/v1/health", get(health))
        .route("/api/v1/control/health", get(control_health))
        .route("/api/v1/control/stop", post(control_stop))
        .route("/api/v1/control/doctor", get(control_doctor))
        .route(
            "/api/v1/control/doctor/clean-invalid",
            post(control_doctor_clean_invalid),
        )
        .route(
            "/api/v1/control/doctor/clear-all",
            post(control_doctor_clear_all),
        )
        .route("/api/v1/hosts", get(hosts))
        .route(
            "/api/v1/scenes",
            post(create_scene).layer(DefaultBodyLimit::max(8 * 1024 * 1024)),
        )
        .route("/api/v1/clients/join", post(join_client))
        .route("/api/v1/client", get(client_info))
        .route("/api/v1/client/oss", get(client_oss))
        .route("/api/v1/client/plugins", get(client_plugins))
        .route(
            "/api/v1/scenes/{token}/attachments/{index}",
            get(get_attachment),
        )
        .route("/api/v1/client/activate", post(activate_client))
        .route("/api/v1/client/revoke", post(revoke_client))
        .route(
            "/api/v1/client/scenes",
            post(client_scene).layer(DefaultBodyLimit::max(8 * 1024 * 1024)),
        )
        .route("/api/v1/control/sources/local", post(local_client))
        .route("/api/v1/scenes/{token}", get(get_scene))
        .route("/api/v1/scenes/{token}/meshes/{index}", get(get_mesh))
        .route(
            "/api/v1/scenes/{token}/meshes/{index}/lod",
            get(get_mesh_lod),
        )
        .route(
            "/api/v1/scenes/{token}/share",
            post(reshare).layer(DefaultBodyLimit::max(8 * 1024 * 1024)),
        )
        .route("/i/{*token}", get(render_image))
        .route("/s/{token}", get(view_scene))
        .route("/v/{token}", get(view_scene))
        .route("/", get(index));
    // With a base path the app lives exclusively under that prefix: the
    // root-level routes are not registered, so the root path stays free for
    // other independent services behind the same host.
    let app = match config.base_path().as_deref() {
        // axum 0.8 maps the nested "/" route to "{base}" (no trailing slash);
        // "{base}/" must reach the viewer index as well.
        Some(base) => {
            let with_slash = format!("{base}/");
            Router::new()
                .nest(base, routes)
                .route(&with_slash, get(index))
                .fallback(asset)
        }
        None => routes.fallback(asset),
    }
        .layer(SetResponseHeaderLayer::if_not_present(
            header::HeaderName::from_static("content-security-policy"),
            HeaderValue::from_static(
                "default-src 'self'; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
            ),
        ))
        .layer(SetResponseHeaderLayer::if_not_present(
            header::HeaderName::from_static("x-content-type-options"),
            HeaderValue::from_static("nosniff"),
        ))
        .layer(SetResponseHeaderLayer::if_not_present(
            header::HeaderName::from_static("referrer-policy"),
            HeaderValue::from_static("no-referrer"),
        ))
        .layer(CompressionLayer::new())
        .layer(TraceLayer::new_for_http())
        .with_state(state);
    tracing::info!(%address, "Blind is ready");
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown(shutdown_rx))
    .await?;
    Ok(())
}

pub fn acquire_offline_maintenance_lease() -> anyhow::Result<ServerLease> {
    ServerLease::acquire().context(
        "a Blind server is still running; restore its configured listen address before offline maintenance",
    )
}

impl ServerLease {
    fn acquire() -> anyhow::Result<Self> {
        let path = config_path()?
            .parent()
            .context("config path has no parent")?
            .join("server.lock");
        let pid = std::process::id();
        #[cfg(target_os = "linux")]
        {
            use std::io::Write;
            use std::os::fd::AsRawFd;
            let mut file = fs::OpenOptions::new()
                .read(true)
                .write(true)
                .create(true)
                .truncate(false)
                .open(&path)?;
            // Keep the inode in place so all competing processes lock the same file.
            if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
                anyhow::bail!("another Blind server or offline maintenance operation is active");
            }
            file.set_len(0)?;
            writeln!(file, "{pid}")?;
            Ok(Self { _file: file })
        }
        #[cfg(not(target_os = "linux"))]
        {
            let output = Command::new("/usr/bin/shlock")
                .args(["-f"])
                .arg(&path)
                .args(["-p", &pid.to_string()])
                .output()
                .context("could not run the macOS server lock helper")?;
            if !output.status.success() {
                anyhow::bail!("another Blind server or offline maintenance operation is active");
            }
            Ok(Self { path, pid })
        }
    }
}

#[cfg(not(target_os = "linux"))]
impl Drop for ServerLease {
    fn drop(&mut self) {
        let owned = fs::read_to_string(&self.path)
            .ok()
            .and_then(|value| value.trim().parse::<u32>().ok())
            == Some(self.pid);
        if owned {
            let _ = fs::remove_file(&self.path);
        }
    }
}

pub async fn probe(config: &Config) -> anyhow::Result<Option<ControlHealth>> {
    let Some((status, body)) =
        control_request(config, Method::GET, "/api/v1/control/health").await?
    else {
        return Ok(None);
    };
    let health = match status {
        StatusCode::OK => {
            let health: ControlHealth = serde_json::from_slice(&body).map_err(|_| {
                anyhow::anyhow!("configured port returned an invalid Blind control response")
            })?;
            if health.service != "blind" {
                anyhow::bail!("configured port is occupied by a non-Blind service");
            }
            health
        }
        status => return Err(control_rejection(status)),
    };
    Ok(Some(health))
}

pub async fn wait_until_ready(
    config: &Config,
    expected_version: Option<&str>,
    timeout: Duration,
) -> anyhow::Result<ControlHealth> {
    let deadline = Instant::now() + timeout;
    loop {
        let last_observation = match probe(config).await {
            Ok(Some(health)) => {
                let version_matches = expected_version
                    .map(|expected| health.version.as_deref() == Some(expected))
                    .unwrap_or(true);
                if version_matches {
                    return Ok(health);
                }
                format!(
                    "the server reported version {}",
                    health.version.as_deref().unwrap_or("unknown")
                )
            }
            Ok(None) => "the server did not accept a connection".to_owned(),
            Err(error) => error.to_string(),
        };
        if Instant::now() >= deadline {
            anyhow::bail!("Blind did not become ready: {last_observation}");
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

pub async fn stop(config: &Config) -> anyhow::Result<String> {
    let Some((status, _)) = control_request(config, Method::POST, "/api/v1/control/stop").await?
    else {
        return Ok("Blind server is already stopped.".into());
    };
    match status {
        StatusCode::ACCEPTED => Ok("Stopped Blind server.".into()),
        status => Err(control_rejection(status)),
    }
}

pub async fn doctor_registry(
    config: &Config,
    action: DoctorAction,
) -> anyhow::Result<Option<DoctorRegistryReport>> {
    let (method, path) = match action {
        DoctorAction::Audit => (Method::GET, "/api/v1/control/doctor"),
        DoctorAction::CleanInvalid => (Method::POST, "/api/v1/control/doctor/clean-invalid"),
        DoctorAction::ClearAll => (Method::POST, "/api/v1/control/doctor/clear-all"),
    };
    let Some((status, body)) =
        control_request_with_timeout(config, method, path, Duration::from_secs(30 * 60)).await?
    else {
        return Ok(None);
    };
    match status {
        StatusCode::OK => serde_json::from_slice(&body)
            .context("invalid Blind doctor response")
            .map(Some),
        status => Err(control_rejection(status)),
    }
}

fn control_rejection(status: StatusCode) -> anyhow::Error {
    match status {
        StatusCode::UNAUTHORIZED => {
            anyhow::anyhow!("a Blind server is running with a different local configuration")
        }
        StatusCode::NOT_FOUND => {
            anyhow::anyhow!("an older or incompatible service is already using the configured port")
        }
        status => anyhow::anyhow!("configured port returned unexpected control status {status}"),
    }
}

async fn control_request(
    config: &Config,
    method: Method,
    path: &str,
) -> anyhow::Result<Option<(StatusCode, Bytes)>> {
    control_request_with_timeout(config, method, path, Duration::from_secs(2)).await
}

async fn control_request_with_timeout(
    config: &Config,
    method: Method,
    path: &str,
    timeout: Duration,
) -> anyhow::Result<Option<(StatusCode, Bytes)>> {
    let address = control_address(config)?;
    let uri = format!("http://{address}{path}");
    let request = Request::builder()
        .method(method)
        .uri(uri)
        .header(header::AUTHORIZATION, format!("Bearer {}", config.pat))
        .header(header::CONNECTION, "close")
        .body(Empty::<Bytes>::new())?;
    let client: Client<HttpConnector, Empty<Bytes>> =
        Client::builder(TokioExecutor::new()).build_http();
    let response = match tokio::time::timeout(timeout, client.request(request)).await {
        Err(_) => {
            anyhow::bail!("the configured port accepted a connection but did not answer as Blind")
        }
        Ok(Err(error)) if error.is_connect() => return Ok(None),
        Ok(Err(error)) => return Err(error.into()),
        Ok(Ok(response)) => response,
    };
    let status = response.status();
    let body = tokio::time::timeout(timeout, response.into_body().collect())
        .await
        .map_err(|_| anyhow::anyhow!("Blind control response timed out"))??
        .to_bytes();
    if body.len() > 64 * 1024 {
        anyhow::bail!("Blind control response is unexpectedly large");
    }
    Ok(Some((status, body)))
}

pub(crate) fn control_address(config: &Config) -> anyhow::Result<SocketAddr> {
    let configured: SocketAddr = config.listen.parse()?;
    let ip = match configured.ip() {
        IpAddr::V4(ip) if ip.is_unspecified() => IpAddr::V4(Ipv4Addr::LOCALHOST),
        IpAddr::V6(ip) if ip.is_unspecified() => IpAddr::V6(Ipv6Addr::LOCALHOST),
        ip => ip,
    };
    Ok(SocketAddr::new(ip, configured.port()))
}

pub fn stateless_links_for(
    codec: &TokenCodec,
    scene: &SceneDescriptor,
    origin: &str,
    include_owner: bool,
) -> anyhow::Result<ShareLinks> {
    let public_token = codec.seal(Scope::Public, scene)?;
    let owner_secret = include_owner
        .then(|| codec.seal(Scope::Owner, scene))
        .transpose()?;
    Ok(compose_links(
        origin,
        "v",
        &public_token,
        owner_secret.as_deref(),
        scene,
    ))
}

pub fn links_for(
    registry: &Registry,
    scene: &SceneDescriptor,
    origin: &str,
    include_owner: bool,
) -> anyhow::Result<ShareLinks> {
    let registration = registry.register(scene)?;
    Ok(compose_links(
        origin,
        "s",
        &registration.code,
        include_owner.then_some(registration.owner_secret.as_str()),
        scene,
    ))
}

/// One link contract shared by short-registry and stateless links.
fn compose_links(
    origin: &str,
    route: &str,
    token: &str,
    owner: Option<&str>,
    scene: &SceneDescriptor,
) -> ShareLinks {
    let viewer_url = format!("{origin}/{route}/{token}");
    let image_url = format!("{origin}/i/{token}.png");
    let owner_url = owner.map(|owner| format!("{viewer_url}#owner={owner}"));
    let full_text = owner
        .is_some()
        .then(|| scene.full_text(&viewer_url, &image_url));
    ShareLinks {
        viewer_url,
        image_url,
        owner_url,
        full_text,
    }
}

async fn health(State(state): State<AppState>) -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "ok",
        version: env!("CARGO_PKG_VERSION"),
        scene_schema: 4,
        image_renderer: state.renderer.is_some(),
    })
}

async fn control_health(_pat: PatAuth) -> Result<impl IntoResponse, AppError> {
    Ok((
        no_store(),
        Json(ControlHealth {
            service: "blind".into(),
            pid: std::process::id(),
            version: Some(env!("CARGO_PKG_VERSION").into()),
        }),
    ))
}

async fn control_stop(
    State(state): State<AppState>,
    _pat: PatAuth,
) -> Result<impl IntoResponse, AppError> {
    state
        .shutdown
        .try_send(())
        .map_err(|_| AppError::unavailable("Blind shutdown is already in progress"))?;
    Ok((StatusCode::ACCEPTED, no_store()))
}

async fn control_doctor(
    State(state): State<AppState>,
    _pat: PatAuth,
) -> Result<impl IntoResponse, AppError> {
    doctor_registry_response(&state, DoctorAction::Audit).await
}

async fn control_doctor_clean_invalid(
    State(state): State<AppState>,
    _pat: PatAuth,
) -> Result<impl IntoResponse, AppError> {
    doctor_registry_response(&state, DoctorAction::CleanInvalid).await
}

async fn control_doctor_clear_all(
    State(state): State<AppState>,
    _pat: PatAuth,
) -> Result<impl IntoResponse, AppError> {
    doctor_registry_response(&state, DoctorAction::ClearAll).await
}

async fn doctor_registry_response(
    state: &AppState,
    action: DoctorAction,
) -> Result<
    (
        [(header::HeaderName, HeaderValue); 1],
        Json<DoctorRegistryReport>,
    ),
    AppError,
> {
    let _guard = state
        .doctor_lock
        .try_lock()
        .map_err(|_| AppError::unavailable("Blind doctor is already running"))?;
    let key_repaired = state.config.restore_saved_secret()?;
    state.registry.repair()?;
    let audit = state.registry.audit().await?;
    let removed = match action {
        DoctorAction::Audit => 0,
        DoctorAction::CleanInvalid => state.registry.clean_invalid(&audit).await?,
        DoctorAction::ClearAll => state.registry.clear()?,
    };
    let mut report = DoctorRegistryReport::new(&audit, removed);
    report.key_repaired = key_repaired;
    report.lod_cache = Some(state.lod_cache.stats());
    Ok((no_store(), Json(report)))
}

async fn hosts(
    State(state): State<AppState>,
    _pat: PatAuth,
) -> Result<impl IntoResponse, AppError> {
    Ok((
        no_store(),
        Json(discover(
            state.config.port()?,
            state.config.preferred_origin.as_deref(),
            state.config.base_path().as_deref(),
        )?),
    ))
}

async fn create_scene(
    State(state): State<AppState>,
    _pat: PatAuth,
    headers: HeaderMap,
    Json(request): Json<CreateSceneRequest>,
) -> Result<impl IntoResponse, AppError> {
    let mut paths = Vec::with_capacity(request.paths.len());
    for path in request.paths {
        paths.push(if crate::oss::is_oss(&path) {
            path
        } else {
            tokio::fs::canonicalize(&path)
                .await
                .context("cannot resolve source file")?
                .to_string_lossy()
                .into_owned()
        });
    }
    let mut scene = scene_from_sources(&state, &paths, None, request.title).await?;
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

async fn get_scene(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    AxumPath(token): AxumPath<String>,
    headers: HeaderMap,
) -> Result<impl IntoResponse, AppError> {
    let opened = open_scene(&state, &token, peer.ip())?;
    source_result(
        &state,
        &token,
        state.registry.sources.validate_source(&opened.scene),
    )?;
    let owner = owner_matches(&headers, &state, &opened);
    let scene = opened.scene;
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
            source_url: format!("api/v1/scenes/{token}/meshes/{index}"),
        })
        .collect();
    Ok((
        no_store(),
        Json(PublicScene {
            attachments: scene.attachments.iter().enumerate().map(|(index,a)| serde_json::json!({"id":a.id,"label":a.label,"byte_size":a.byte_size,"unavailable":a.unavailable,"url":if a.revision.is_some(){Some(format!("api/v1/scenes/{token}/attachments/{index}"))}else{None}})).collect(),
            warnings: scene.warnings.clone(),
            source: scene.source.clone(),
            title: scene.title,
            meshes,
            label_groups: scene.label_groups,
            state: scene.state,
            owner,
        }),
    ))
}

async fn get_mesh(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    AxumPath((token, index)): AxumPath<(String, usize)>,
) -> Result<Response<Body>, AppError> {
    let opened = open_scene(&state, &token, peer.ip())?;
    let scene = opened.scene;
    let mesh = scene
        .meshes
        .get(index)
        .ok_or_else(|| AppError::not_found("Mesh not found"))?;
    let bytes = source_result(
        &state,
        &token,
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
    Ok(Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, content_type)
        .header(header::CACHE_CONTROL, NO_STORE)
        .header(header::CONTENT_LENGTH, bytes.len())
        .body(Body::from(bytes))?)
}

async fn get_mesh_lod(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    AxumPath((token, index)): AxumPath<(String, usize)>,
) -> Result<Response<Body>, AppError> {
    let opened = open_scene(&state, &token, peer.ip())?;
    lod_response(scene_lod(&state, &token, &opened.scene, index).await?)
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

fn lod_response(asset: Arc<LodAsset>) -> Result<Response<Body>, AppError> {
    Ok(Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, MeshFormat::Ply.mime())
        .header(header::CACHE_CONTROL, NO_STORE)
        .header("x-blind-raw-bytes", asset.raw_bytes)
        .header(header::CONTENT_LENGTH, asset.bytes.len())
        .body(Body::from(asset.bytes.clone()))?)
}

fn lod_memory_permits(byte_size: u64) -> u32 {
    byte_size
        .saturating_mul(LOD_MEMORY_EXPANSION)
        .div_ceil(MIB)
        .clamp(1, u64::from(LOD_MEMORY_MIB)) as u32
}

async fn reshare(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    AxumPath(token): AxumPath<String>,
    headers: HeaderMap,
    Json(request): Json<ReshareRequest>,
) -> Result<impl IntoResponse, AppError> {
    let opened = open_scene(&state, &token, peer.ip())?;
    source_result(
        &state,
        &token,
        state.registry.sources.validate_source(&opened.scene),
    )?;
    let owner = owner_matches(&headers, &state, &opened);
    let mut scene = opened.scene;
    scene
        .apply_update(request.update)
        .map_err(|error| AppError::bad_request(&error.to_string()))?;
    let current_origin = request_origin(&headers, &state.config)?;
    let hosts = share_hosts(&state.config, &current_origin)?;
    let origin = select_share_origin(&state.config, request.origin, &current_origin, &hosts)?;
    Ok((
        no_store(),
        Json(ShareResponse {
            links: links_for(&state.registry, &scene, &origin, owner)?,
            origin,
            hosts,
        }),
    ))
}

async fn render_image(
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
    let scene = opened.scene;
    source_result(
        &state,
        token,
        state.registry.sources.validate_source(&scene),
    )?;
    let source_bytes = scene
        .meshes
        .iter()
        .filter(|mesh| mesh.visible)
        .try_fold(0_u64, |total, mesh| total.checked_add(mesh.byte_size))
        .ok_or_else(|| AppError::unprocessable("source size overflow"))?;
    if source_bytes > crate::source::MAX_SOURCE_BYTES {
        return Err(AppError::unprocessable("image sources exceed 512 MiB"));
    }
    let mut render_scene = scene.clone();
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
            let asset = scene_lod(&state, token, &scene, index).await?;
            render_scene.meshes[index].format = MeshFormat::Ply;
            render_scene.meshes[index].byte_size = asset.bytes.len() as u64;
            sources.push(Some(asset.bytes.to_vec()));
            continue;
        }
        if mesh.visible {
            sources.push(Some(
                source_result(
                    &state,
                    token,
                    state.registry.sources.read_mesh(&scene, mesh, true).await,
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
            &state,
            token,
            state
                .registry
                .sources
                .validate_mesh_metadata(&scene, mesh)
                .await,
        )?;
    }
    Ok(Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "image/png")
        .header(header::CACHE_CONTROL, NO_STORE)
        .header(header::CONTENT_LENGTH, bytes.len())
        .body(Body::from(bytes))?)
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

async fn index(State(state): State<AppState>) -> Result<Response<Body>, AppError> {
    serve_index(state.config.base_path())
}

async fn view_scene(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    AxumPath(token): AxumPath<String>,
) -> Result<Response<Body>, AppError> {
    let opened = open_scene(&state, &token, peer.ip())?;
    source_result(
        &state,
        &token,
        state.registry.sources.validate_source(&opened.scene),
    )?;
    serve_index(state.config.base_path())
}

async fn asset(
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

fn owner_matches(headers: &HeaderMap, state: &AppState, opened: &OpenedScene) -> bool {
    let Some(token) = bearer(headers) else {
        return false;
    };
    if let Some(expected) = &opened.owner_secret {
        return state.registry.owner_matches(expected, token);
    }
    let Ok(owner) = state.codec.open(token) else {
        return false;
    };
    owner.scope == Scope::Owner && same_sources(&owner.scene, &opened.scene)
}

fn same_sources(a: &SceneDescriptor, b: &SceneDescriptor) -> bool {
    a.source.as_ref().map(|s| &s.id) == b.source.as_ref().map(|s| &s.id)
        && a.meshes.len() == b.meshes.len()
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
        return Ok(config.origin_with_base(&origin));
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
        return normalize_origin(&format!("{scheme}://{host}"))
            .map(|origin| config.origin_with_base(&origin))
            .map_err(Into::into);
    }
    let hosts = discover(
        config.port()?,
        config.preferred_origin.as_deref(),
        config.base_path().as_deref(),
    )?;
    hosts
        .first()
        .map(|host| host.origin.clone())
        .ok_or_else(|| AppError::internal("No host address available"))
}

fn share_hosts(config: &Config, current_origin: &str) -> Result<Vec<HostCandidate>, AppError> {
    let mut hosts = discover(
        config.port()?,
        config.preferred_origin.as_deref(),
        config.base_path().as_deref(),
    )?;
    if !hosts.iter().any(|host| host.origin == current_origin) {
        hosts.insert(
            0,
            HostCandidate {
                origin: current_origin.to_string(),
                address: current_origin.to_string(),
                scope: "current",
                interface: "request".into(),
                primary: false,
            },
        );
    }
    Ok(hosts)
}

fn select_share_origin(
    config: &Config,
    requested: Option<String>,
    current_origin: &str,
    hosts: &[HostCandidate],
) -> Result<String, AppError> {
    let Some(requested) = requested else {
        return Ok(current_origin.to_string());
    };
    let requested = config.normalize_share_origin(&requested)?;
    // `share_hosts` always inserts the current origin, so membership is the
    // only check needed.
    if hosts.iter().any(|host| host.origin == requested) {
        return Ok(requested);
    }
    Err(AppError::bad_request("Selected Host is not available"))
}

async fn shutdown(mut requested: tokio::sync::mpsc::Receiver<()>) {
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
    tokio::select! { _ = ctrl_c => {}, _ = terminate => {}, _ = requested.recv() => {} }
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
    fn gone(message: &str) -> Self {
        Self {
            status: StatusCode::GONE,
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
    fn too_many_requests(message: &str) -> Self {
        Self {
            status: StatusCode::TOO_MANY_REQUESTS,
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
    [(header::CACHE_CONTROL, HeaderValue::from_static(NO_STORE))]
}

const NO_STORE: &str = "no-store, max-age=0";

/// Guard for routes that must only be reachable with the local PAT.
struct PatAuth;

impl FromRequestParts<AppState> for PatAuth {
    type Rejection = AppError;
    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        require_pat(&parts.headers, &state.config)?;
        Ok(PatAuth)
    }
}

struct OpenedScene {
    scene: SceneDescriptor,
    owner_secret: Option<String>,
}

fn open_scene(state: &AppState, token: &str, peer: IpAddr) -> Result<OpenedScene, AppError> {
    if is_short_secret(token) {
        return match state.registry.resolve(token) {
            Ok(RegisteredScene {
                scene,
                owner_secret,
            }) => Ok(OpenedScene {
                scene,
                owner_secret: Some(owner_secret),
            }),
            Err(RegistryLookupError::NotFound) => {
                if allow_short_miss(state, peer) {
                    Err(AppError::not_found("Scene not found"))
                } else {
                    Err(AppError::too_many_requests("Too many invalid short links"))
                }
            }
            Err(RegistryLookupError::Gone) => {
                Err(AppError::gone("Scene expired or source is gone"))
            }
            Err(RegistryLookupError::Internal(error)) => {
                Err(AppError::internal(&error.to_string()))
            }
        };
    }
    state
        .codec
        .open(token)
        .map(|envelope| OpenedScene {
            scene: envelope.scene,
            owner_secret: None,
        })
        .map_err(|_| AppError::not_found("Scene not found"))
}

fn allow_short_miss(state: &AppState, peer: IpAddr) -> bool {
    const WINDOW: Duration = Duration::from_secs(60);
    const LIMIT: u16 = 30;
    let now = Instant::now();
    let Ok(mut limiter) = state.short_misses.lock() else {
        return false;
    };
    if limiter.clients.len() > 1024 {
        limiter
            .clients
            .retain(|_, window| now.duration_since(window.started) < WINDOW);
    }
    let window = limiter.clients.entry(peer).or_insert(MissWindow {
        started: now,
        misses: 0,
    });
    if now.duration_since(window.started) >= WINDOW {
        window.started = now;
        window.misses = 0;
    }
    window.misses = window.misses.saturating_add(1);
    window.misses <= LIMIT
}

fn mark_scene_gone(state: &AppState, token: &str) {
    if let Err(error) = state.registry.mark_gone(token) {
        tracing::warn!(%error, "failed to tombstone invalid short scene");
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    fn host(origin: &str) -> HostCandidate {
        HostCandidate {
            origin: origin.into(),
            address: origin.into(),
            scope: "private",
            interface: "test".into(),
            primary: false,
        }
    }

    fn test_config(base_path: Option<&str>) -> Config {
        Config {
            listen: "127.0.0.1:0".into(),
            preferred_origin: None,
            base_path: base_path.map(Into::into),
            pat: String::new(),
            secret: String::new(),
        }
    }

    #[test]
    fn local_control_preserves_listen_address_family() {
        let mut config = test_config(None);
        for (listen, expected) in [
            ("[::1]:7400", "[::1]:7400"),
            ("[::]:7400", "[::1]:7400"),
            ("0.0.0.0:7400", "127.0.0.1:7400"),
        ] {
            config.listen = listen.into();
            assert_eq!(control_address(&config).unwrap().to_string(), expected);
        }
    }

    #[test]
    fn lod_memory_is_weighted_by_source_size() {
        assert_eq!(lod_memory_permits(0), 1);
        assert_eq!(lod_memory_permits(MIB), 3);
        assert_eq!(lod_memory_permits(MIB + 1), 4);
        assert_eq!(lod_memory_permits(170 * MIB), 510);
        assert_eq!(lod_memory_permits(171 * MIB), LOD_MEMORY_MIB);
        assert_eq!(lod_memory_permits(u64::MAX), LOD_MEMORY_MIB);
    }

    #[test]
    fn share_origin_must_be_current_or_discovered() {
        let config = test_config(None);
        let hosts = vec![host("http://100.100.100.100:7400")];
        assert_eq!(
            select_share_origin(
                &config,
                Some("http://100.100.100.100:7400".into()),
                "http://192.168.1.2:7400",
                &hosts,
            )
            .unwrap(),
            "http://100.100.100.100:7400"
        );
        assert!(
            select_share_origin(
                &config,
                Some("http://example.com:7400".into()),
                "http://192.168.1.2:7400",
                &hosts,
            )
            .is_err()
        );
    }

    #[test]
    fn share_origin_tolerates_configured_base_path() {
        // The share picker echoes origins from `discover`, which carry the
        // base path; selecting one must not fail on the path suffix.
        let config = test_config(Some("/blind"));
        let hosts = vec![host("http://100.100.100.100:7400/blind")];
        assert_eq!(
            select_share_origin(
                &config,
                Some("http://100.100.100.100:7400/blind".into()),
                "http://192.168.1.2:7400/blind",
                &hosts,
            )
            .unwrap(),
            "http://100.100.100.100:7400/blind"
        );
        assert!(
            select_share_origin(
                &config,
                Some("http://example.com:7400/blind".into()),
                "http://192.168.1.2:7400/blind",
                &hosts,
            )
            .is_err()
        );
    }
}

fn source_result<T>(
    state: &AppState,
    token: &str,
    result: Result<T, SourceError>,
) -> Result<T, AppError> {
    result.map_err(|error| match error {
        SourceError::Gone => {
            mark_scene_gone(state, token);
            AppError::gone("Scene source changed, was deleted, or was revoked")
        }
        SourceError::Unavailable(reason) => {
            tracing::warn!(%reason,"source unavailable");
            AppError::unavailable(
                "Source host is temporarily unavailable; retry after it reconnects",
            )
        }
        SourceError::TooLarge => AppError::unprocessable("Source exceeds the 512 MiB file limit"),
    })
}
fn client_auth(state: &AppState, headers: &HeaderMap, pending: bool) -> Result<Source, AppError> {
    let credential =
        bearer(headers).ok_or_else(|| AppError::unauthorized("Client credential required"))?;
    state
        .registry
        .sources
        .authenticate(credential, pending)
        .map_err(|_| AppError::unauthorized("Client registration is invalid, expired or revoked"))
}
async fn join_client(
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
async fn client_oss(
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

async fn client_info(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<impl IntoResponse, AppError> {
    Ok((no_store(), Json(client_auth(&state, &headers, true)?)))
}
async fn activate_client(
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
async fn revoke_client(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<impl IntoResponse, AppError> {
    let source = client_auth(&state, &headers, true)?;
    state.registry.sources.revoke(&source.id)?;
    Ok((no_store(), Json(serde_json::json!({"revoked":true}))))
}
#[derive(Deserialize)]
struct LocalRequest {
    name: String,
    host: String,
    user: String,
}
async fn local_client(
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
async fn scene_from_sources(
    state: &AppState,
    paths: &[String],
    source: Option<crate::source::SceneSource>,
    title: Option<String>,
) -> Result<SceneDescriptor, AppError> {
    if paths.is_empty() {
        return Err(AppError::bad_request("a scene needs at least one file"));
    }
    let mut meshes = Vec::new();
    for (i, path) in paths.iter().enumerate() {
        if crate::oss::is_oss(path) {
            let input_path = PathBuf::from(
                crate::oss::Location::parse(path)
                    .map_err(|_| AppError::bad_request("invalid OSS resource address"))?
                    .key
                    .as_ref(),
            );
            MeshFormat::from_path(&input_path)
                .map_err(|_| AppError::bad_request("unsupported mesh format"))?;
        }
        let observed = state
            .registry
            .sources
            .observe(source.as_ref(), path, false)
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
        let format = MeshFormat::from_path(&path)?;
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
            color: crate::scene::PALETTE[i % crate::scene::PALETTE.len()].into(),
            opacity: 1.0,
            visible: true,
            quality: MeshQuality::Lod,
            label: None,
            translation: [0.0; 3],
        });
    }
    let title = title.unwrap_or_else(|| {
        if meshes.len() == 1 {
            meshes[0].name.clone()
        } else {
            format!("{} Meshes", meshes.len())
        }
    });
    Ok(SceneDescriptor {
        source,
        schema: 3,
        title,
        created_at: crate::source::now() as u64,
        meshes,
        attachments: Vec::new(),
        warnings: Vec::new(),
        label_groups: Vec::new(),
        state: Default::default(),
    })
}

async fn client_scene(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<CreateSceneRequest>,
) -> Result<impl IntoResponse, AppError> {
    let source = client_auth(&state, &headers, false)?;
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
        let _permit = state
            .plugin_slots
            .clone()
            .try_acquire_owned()
            .map_err(|_| {
                AppError::too_many_requests("Two plugin shares already running; retry later")
            })?;
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
            Some(source.scene_source()),
            request.title,
        )
        .await?
    };
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
    let links = if request.stateless {
        stateless_links_for(&state.codec, &scene, &origin, true)?
    } else {
        links_for(&state.registry, &scene, &origin, true)?
    };
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

async fn client_plugins(
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

async fn get_attachment(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    AxumPath((token, index)): AxumPath<(String, usize)>,
) -> Result<Response<Body>, AppError> {
    let opened = open_scene(&state, &token, peer.ip())?;
    source_result(
        &state,
        &token,
        state.registry.sources.validate_source(&opened.scene),
    )?;
    let a = opened
        .scene
        .attachments
        .get(index)
        .ok_or_else(|| AppError::not_found("Attachment not found"))?;
    let revision = a.revision.as_ref().ok_or_else(|| {
        AppError::unavailable("Attachment was unavailable when this scene was created")
    })?;
    let observed = state
        .registry
        .sources
        .observe(opened.scene.source.as_ref(), &a.path, true)
        .await
        .map_err(|e| match e {
            SourceError::Gone => AppError::gone("Attachment deleted"),
            _ => AppError::unavailable("Attachment unavailable"),
        })?;
    if &observed.revision != revision {
        return Err(AppError::gone("Attachment changed"));
    }
    let name = crate::oss::Location::parse(&a.path)?.key.to_string();
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
        .body(Body::from(observed.bytes))?)
}

async fn scene_from_manifest(
    state: &AppState,
    plan: crate::plugin::ShareManifest,
    source: Option<crate::source::SceneSource>,
    title: Option<String>,
) -> Result<SceneDescriptor, AppError> {
    plan.validate()
        .map_err(|e| AppError::bad_request(&e.to_string()))?;
    let mut warnings = plan.warnings;
    let mut ready = HashMap::new();
    let mut cached = HashMap::new();
    for r in &plan.resources {
        if !cached.contains_key(&r.uri) {
            let result = async {
                let observed = state
                    .registry
                    .sources
                    .observe(source.as_ref(), &r.uri, true)
                    .await
                    .map_err(|_| anyhow::anyhow!("resource unavailable"))?;
                let filename = if crate::oss::is_oss(&r.uri) {
                    crate::oss::Location::parse(&r.uri)?.key.to_string()
                } else {
                    r.uri.clone()
                };
                let format = MeshFormat::from_path(std::path::Path::new(&filename))?;
                let bytes = observed.bytes;
                let bounds = tokio::task::spawn_blocking(move || {
                    crate::mesh::Geometry::from_bytes(&bytes, format).map(|g| g.bounds())
                })
                .await??;
                Ok::<_, anyhow::Error>((
                    crate::scene::MeshRef {
                        path: observed.path,
                        name: std::path::Path::new(&filename)
                            .file_name()
                            .context("no filename")?
                            .to_string_lossy()
                            .into_owned(),
                        format,
                        revision: observed.revision,
                        byte_size: observed.size,
                        modified_ns: observed.modified_ns,
                        change_ns: observed.change_ns,
                        color: crate::scene::PALETTE[ready.len() % crate::scene::PALETTE.len()]
                            .into(),
                        opacity: 1.0,
                        visible: true,
                        quality: MeshQuality::Lod,
                        label: None,
                        translation: [0.0; 3],
                    },
                    bounds,
                ))
            }
            .await;
            cached.insert(r.uri.clone(), result.ok());
        }
        if let Some(Some((mesh, bounds))) = cached.get(&r.uri) {
            let mut mesh = mesh.clone();
            mesh.label = r.label.as_ref().map(|text| crate::scene::MeshLabel {
                text: text.clone(),
                anchor: None,
            });
            ready.insert(r.id.clone(), (mesh, *bounds));
        } else {
            warnings.push(crate::plugin::Warning {
                code: "RESOURCE_UNAVAILABLE".into(),
                message: format!(
                    "{}: resource unavailable or unsupported geometry",
                    r.label.as_deref().unwrap_or(&r.id)
                ),
                resource_id: Some(r.id.clone()),
            });
        }
    }
    if ready.is_empty() {
        return Err(AppError::unprocessable(
            "NO_READABLE_GEOMETRY: no geometry could be loaded; check Server OSS access and artifact availability, then retry",
        ));
    }
    let mut meshes = Vec::new();
    let mut groups = Vec::new();
    if plan.panels.is_empty() {
        for r in &plan.resources {
            if let Some((m, _)) = ready.get(&r.id) {
                meshes.push(m.clone());
            }
        }
    } else {
        let mut panels = Vec::new();
        for panel in plan.panels {
            let members: Vec<_> = panel
                .members
                .iter()
                .filter_map(|id| ready.get(id))
                .collect();
            let missing = panel.members.len() - members.len();
            if missing > 0 {
                warnings.push(crate::plugin::Warning {
                    code: "PANEL_INCOMPLETE".into(),
                    message: format!(
                        "{}：缺少 {missing} 个产物{}",
                        panel.label,
                        if members.is_empty() {
                            "，该组暂无可显示的模型。"
                        } else {
                            "，仅显示可用部分。"
                        }
                    ),
                    resource_id: None,
                });
            }
            if members.is_empty() {
                continue;
            }
            let caption = if missing > 0 {
                format!("{} · 部分可用", panel.label)
                    .chars()
                    .take(120)
                    .collect()
            } else {
                panel.label
            };
            let mut min = glam::Vec3::splat(f32::INFINITY);
            let mut max = glam::Vec3::splat(f32::NEG_INFINITY);
            for (_, bounds) in &members {
                min = min.min(glam::Vec3::from_array(bounds.0));
                max = max.max(glam::Vec3::from_array(bounds.1));
            }
            panels.push((caption, members, min, max));
        }
        let cell = panels
            .iter()
            .map(|(_, _, min, max)| (*max - *min).max_element())
            .fold(1.0_f32, f32::max)
            * 1.1;
        if !cell.is_finite() {
            return Err(AppError::unprocessable(
                "Geometry bounds exceed layout limits",
            ));
        }
        let cols = (panels.len() as f32).sqrt().ceil().min(4.0) as usize;
        for (i, (label, members, min, max)) in panels.into_iter().enumerate() {
            let center = (min + max) * 0.5;
            let target =
                glam::Vec3::new((i % cols) as f32 * cell, -((i / cols) as f32) * cell, 0.0);
            let shift = (target - center).to_array();
            let mut indices = Vec::new();
            let single = members.len() == 1;
            for (mesh, _) in members {
                let mut mesh = mesh.clone();
                mesh.translation = shift;
                if single {
                    let text = match &mesh.label {
                        Some(own) if own.text != label => format!("{label} · {}", own.text),
                        _ => label.clone(),
                    };
                    mesh.label = Some(crate::scene::MeshLabel {
                        text: text.chars().take(120).collect(),
                        anchor: None,
                    });
                }
                indices.push(meshes.len());
                meshes.push(mesh);
            }
            if indices.len() > 1 {
                groups.push(crate::scene::MeshLabelGroup {
                    text: label,
                    meshes: indices,
                });
            }
        }
    }
    let mut attachments = Vec::new();
    for a in plan.attachments {
        let observed = state
            .registry
            .sources
            .observe(source.as_ref(), &a.uri, false)
            .await
            .ok();
        let unavailable = observed
            .is_none()
            .then(|| "Resource unavailable".to_owned());
        if unavailable.is_some() {
            warnings.push(crate::plugin::Warning {
                code: "ATTACHMENT_UNAVAILABLE".into(),
                message: format!(
                    "{}: attachment unavailable",
                    a.label.as_deref().unwrap_or(&a.id)
                ),
                resource_id: Some(a.id.clone()),
            });
        }
        attachments.push(crate::scene::SceneAttachment {
            id: a.id,
            path: a.uri,
            label: a.label.unwrap_or_else(|| "Attachment".into()),
            byte_size: observed.as_ref().map(|o| o.size),
            revision: observed.map(|o| o.revision),
            unavailable,
        });
    }
    // Recheck ownership after potentially slow upstream reads, before publishing.
    if let Some(s) = &source {
        state
            .registry
            .sources
            .get(&s.id)
            .map_err(|_| AppError::unauthorized("Client was revoked"))?;
    }
    Ok(SceneDescriptor {
        source,
        schema: 4,
        title: title
            .or(plan.title)
            .unwrap_or_else(|| "Plugin scene".into()),
        created_at: crate::source::now() as u64,
        meshes,
        label_groups: groups,
        state: Default::default(),
        attachments,
        warnings,
    })
}
