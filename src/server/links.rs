use super::{dto::ShareLinks, error::AppError};
use crate::{
    runtime::{
        config::{Config, normalize_origin},
        network::{HostCandidate, discover},
    },
    scene::SceneDescriptor,
    storage::registry::Registry,
};
use axum::http::{HeaderMap, header};

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

pub(super) fn request_origin(headers: &HeaderMap, config: &Config) -> Result<String, AppError> {
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

pub(super) fn share_hosts(
    config: &Config,
    current_origin: &str,
) -> Result<Vec<HostCandidate>, AppError> {
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

pub(super) fn select_share_origin(
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
