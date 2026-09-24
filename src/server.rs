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
    extract::{ConnectInfo, DefaultBodyLimit, FromRequestParts, Path as AxumPath, Query, State},
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
    scene::{MeshFormat, MeshQuality, SceneDescriptor, SceneUpdate},
};

mod client;
mod view;
use client::{
    activate_client, client_info, client_oss, client_plugins, client_scene, get_attachment,
    get_renderer, join_client, local_client, revoke_client, scene_from_sources,
};
#[cfg(test)]
use view::lod_memory_permits;
use view::{
    asset, budgeted_body, expand_response_reservation, get_mesh, get_mesh_lod, get_scene, index,
    render_image, reserve_response, reshare, selected_scene, view_scene,
};

#[derive(RustEmbed)]
#[folder = "web/dist/"]
struct WebAssets;

#[derive(Clone)]
pub struct AppState {
    pub config: Arc<Config>,
    pub registry: Arc<Registry>,
    pub renderer: Option<Arc<Renderer>>,
    pub image_slots: Arc<tokio::sync::Semaphore>,
    pub lod_slots: Arc<tokio::sync::Semaphore>,
    pub lod_memory: Arc<tokio::sync::Semaphore>,
    response_memory: Arc<tokio::sync::Semaphore>,
    join_slots: Arc<tokio::sync::Semaphore>,
    plugin_slots: Arc<tokio::sync::Semaphore>,
    pub lod_cache: LodCache,
    pub shutdown: tokio::sync::mpsc::Sender<()>,
    doctor_lock: Arc<tokio::sync::Mutex<()>>,
    short_misses: Arc<Mutex<MissLimiter>>,
}

const LOD_MEMORY_MIB: u32 = 512;
const RESPONSE_MEMORY_MIB: u32 = 512;
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
    pub ttl_days: u32,
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
#[serde(deny_unknown_fields)]
struct CreateSceneRequest {
    #[serde(default)]
    collection: Option<CreateCollectionRequest>,
    #[serde(default)]
    display: Vec<crate::component::DisplayOptions>,
    #[serde(default = "crate::scene::default_ttl_days")]
    ttl_days: u32,
    #[serde(default)]
    manifest: Option<crate::plugin::ShareManifest>,
    #[serde(default)]
    paths: Vec<String>,
    title: Option<String>,
    origin: Option<String>,
    labels: Option<Vec<Option<crate::scene::MeshLabel>>>,
    #[serde(default)]
    label_groups: Vec<crate::scene::MeshLabelGroup>,
}

#[derive(Debug, Deserialize)]
struct CreateCollectionRequest {
    title: String,
    active_scene_id: String,
    scenes: Vec<CreateCollectionPart>,
}

#[derive(Debug, Deserialize)]
struct CreateCollectionPart {
    id: String,
    title: String,
    paths: Vec<String>,
    #[serde(default)]
    display: Vec<crate::component::DisplayOptions>,
    #[serde(default)]
    labels: Vec<Option<crate::scene::MeshLabel>>,
    #[serde(default)]
    label_groups: Vec<crate::scene::MeshLabelGroup>,
}

#[derive(Debug, Deserialize)]
struct ReshareRequest {
    #[serde(flatten)]
    update: SceneUpdate,
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
    #[serde(default)]
    pub audit_skipped: bool,
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
            audit_skipped: false,
            key_repaired: false,
            lod_cache: None,
        }
    }

    pub fn invalid(&self) -> usize {
        self.expired + self.source_gone + self.tombstoned + self.corrupt
    }

    /// Report for a clear that removed every link without auditing its sources.
    pub fn cleared(removed: usize) -> Self {
        Self {
            valid: 0,
            unavailable: 0,
            expired: 0,
            source_gone: 0,
            tombstoned: 0,
            corrupt: 0,
            removed,
            preserved: 0,
            audit_skipped: true,
            key_repaired: false,
            lod_cache: None,
        }
    }

    pub fn total(&self) -> usize {
        if self.audit_skipped {
            self.removed
        } else {
            self.valid + self.unavailable + self.invalid()
        }
    }
}

#[derive(Debug, Serialize)]
struct PublicScene {
    components: Vec<crate::component::SceneComponent>,
    ttl_days: u32,
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
        registry,
        renderer,
        image_slots: Arc::new(tokio::sync::Semaphore::new(2)),
        lod_slots: Arc::new(tokio::sync::Semaphore::new(2)),
        lod_memory: Arc::new(tokio::sync::Semaphore::new(LOD_MEMORY_MIB as usize)),
        response_memory: Arc::new(tokio::sync::Semaphore::new(RESPONSE_MEMORY_MIB as usize)),
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
        .route("/api/v1/scenes/{token}/renderers/{id}", get(get_renderer))
        .route("/i/{*token}", get(render_image))
        .route("/s/{token}", get(view_scene))
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
                "default-src 'self'; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
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

pub fn links_for(
    registry: &Registry,
    scene: &SceneDescriptor,
    origin: &str,
    include_owner: bool,
) -> anyhow::Result<ShareLinks> {
    let registration = registry.register(scene)?;
    Ok(compose_links(
        origin,
        &registration.code,
        include_owner.then_some(registration.owner_secret.as_str()),
        scene,
    ))
}

fn compose_links(
    origin: &str,
    token: &str,
    owner: Option<&str>,
    scene: &SceneDescriptor,
) -> ShareLinks {
    let viewer_url = format!("{origin}/s/{token}");
    let image_url = format!("{origin}/i/{token}.png");
    let owner_url = owner.map(|owner| format!("{viewer_url}#owner={owner}"));
    let full_text = owner
        .is_some()
        .then(|| scene.full_text(&viewer_url, &image_url));
    ShareLinks {
        ttl_days: scene.link_ttl_days(),
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
        scene_schema: 6,
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
    if matches!(action, DoctorAction::ClearAll) {
        let removed = state.registry.clear()?;
        let mut report = DoctorRegistryReport::cleared(removed);
        report.key_repaired = key_repaired;
        report.lod_cache = Some(state.lod_cache.stats());
        return Ok((no_store(), Json(report)));
    }
    let audit = state.registry.audit().await?;
    let removed = match action {
        DoctorAction::Audit => 0,
        DoctorAction::CleanInvalid => state.registry.clean_invalid(&audit).await?,
        DoctorAction::ClearAll => unreachable!(),
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
    state.registry.owner_matches(&opened.owner_secret, token)
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
    owner_secret: String,
}

fn open_scene(state: &AppState, token: &str, peer: IpAddr) -> Result<OpenedScene, AppError> {
    let opened = open_scene_inner(state, token, peer)?;
    if opened.scene.collection.is_some() {
        source_result(
            state,
            token,
            state.registry.sources.validate_source(&opened.scene),
        )?;
    }
    Ok(opened)
}

fn open_scene_inner(state: &AppState, token: &str, peer: IpAddr) -> Result<OpenedScene, AppError> {
    if !is_short_secret(token) {
        return Err(AppError::not_found("Scene not found"));
    }
    match state.registry.resolve(token) {
        Ok(RegisteredScene {
            scene,
            owner_secret,
        }) => Ok(OpenedScene {
            scene,
            owner_secret,
        }),
        Err(RegistryLookupError::NotFound) => {
            if allow_short_miss(state, peer) {
                Err(AppError::not_found("Scene not found"))
            } else {
                Err(AppError::too_many_requests("Too many invalid short links"))
            }
        }
        Err(RegistryLookupError::Gone) => Err(AppError::gone("Scene expired or source is gone")),
        Err(RegistryLookupError::Internal(error)) => Err(AppError::internal(&error.to_string())),
    }
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
            if !token.is_empty() {
                mark_scene_gone(state, token);
            }
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
