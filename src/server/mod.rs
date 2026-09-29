//! HTTP composition root: routing, middleware, and listener lifecycle.
mod access;
mod assets;
mod control;
mod dto;
mod error;
mod lease;
mod links;
mod preview;
mod registration;
mod scenes;
mod sharing;
mod state;
mod view;

use crate::{
    geometry::lod::LodCache, render::Renderer, runtime::config::Config, storage::registry::Registry,
};
use assets::{get_attachment, get_renderer};
use axum::{
    Router,
    extract::DefaultBodyLimit,
    http::{HeaderValue, header},
    routing::{get, post},
};
use control::{
    control_doctor, control_doctor_clean_invalid, control_doctor_clear_all, control_health,
    control_stop, health, hosts,
};
use lease::ServerLease;
pub use lease::acquire_offline_maintenance_lease;
use registration::{
    activate_client, client_info, client_oss, client_plugins, join_client, local_client,
    revoke_client,
};
use rust_embed::RustEmbed;
use sharing::{client_scene, create_scene};
use state::{AppState, LOD_MEMORY_MIB, MissLimiter, RESPONSE_MEMORY_MIB};
use std::{
    net::SocketAddr,
    sync::{Arc, Mutex},
};
use tower_http::{
    compression::CompressionLayer, set_header::SetResponseHeaderLayer, trace::TraceLayer,
};
use view::{asset, get_mesh, get_mesh_lod, get_scene, index, render_image, reshare, view_scene};

#[derive(RustEmbed)]
#[folder = "web/dist/"]
struct WebAssets;

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

fn no_store() -> [(header::HeaderName, HeaderValue); 1] {
    [(header::CACHE_CONTROL, HeaderValue::from_static(NO_STORE))]
}

const NO_STORE: &str = "no-store, max-age=0";

#[cfg(test)]
mod tests {
    use super::*;
    use super::{links::select_share_origin, state::MIB, view::lod_memory_permits};
    use crate::{runtime::config::control_address, runtime::network::HostCandidate};

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
