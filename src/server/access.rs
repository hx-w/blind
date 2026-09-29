use super::{
    error::AppError,
    state::{AppState, MissWindow},
};
use crate::{
    runtime::config::Config,
    scene::SceneDescriptor,
    storage::{
        registry::{RegisteredScene, RegistryLookupError, is_short_secret},
        sources::SourceError,
    },
};
use axum::{
    extract::FromRequestParts,
    http::{HeaderMap, header, request::Parts},
};
use std::{
    net::IpAddr,
    time::{Duration, Instant},
};

pub(super) fn require_pat(headers: &HeaderMap, config: &Config) -> Result<(), AppError> {
    let token = bearer(headers).ok_or_else(|| AppError::unauthorized("PAT required"))?;
    if config.verify_pat(token) {
        Ok(())
    } else {
        Err(AppError::unauthorized("Invalid PAT"))
    }
}

pub(super) fn bearer(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(header::AUTHORIZATION)?
        .to_str()
        .ok()?
        .strip_prefix("Bearer ")
}

pub(super) fn owner_matches(headers: &HeaderMap, state: &AppState, opened: &OpenedScene) -> bool {
    let Some(token) = bearer(headers) else {
        return false;
    };
    state.registry.owner_matches(&opened.owner_secret, token)
}

/// Guard for routes that must only be reachable with the local PAT.
pub(super) struct PatAuth;

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

pub(super) struct OpenedScene {
    pub(super) scene: SceneDescriptor,
    pub(super) owner_secret: String,
}

pub(super) fn open_scene(
    state: &AppState,
    token: &str,
    peer: IpAddr,
) -> Result<OpenedScene, AppError> {
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

pub(super) fn open_scene_inner(
    state: &AppState,
    token: &str,
    peer: IpAddr,
) -> Result<OpenedScene, AppError> {
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

pub(super) fn allow_short_miss(state: &AppState, peer: IpAddr) -> bool {
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

pub(super) fn mark_scene_gone(state: &AppState, token: &str) {
    if let Err(error) = state.registry.mark_gone(token) {
        tracing::warn!(%error, "failed to tombstone invalid short scene");
    }
}

pub(super) fn source_result<T>(
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
