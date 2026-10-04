use super::{
    access::{PatAuth, bearer},
    error::AppError,
    no_store,
    state::AppState,
};
use crate::{
    protocol::registration::{FinishRequest, JoinRequest, Source},
    runtime::config::config_path,
};
use anyhow::Context;
use axum::{
    Json,
    extract::{ConnectInfo, State},
    http::HeaderMap,
    response::IntoResponse,
};
use serde::Deserialize;
use std::net::SocketAddr;

pub(super) fn client_auth(
    state: &AppState,
    headers: &HeaderMap,
    pending: bool,
) -> Result<Source, AppError> {
    let credential =
        bearer(headers).ok_or_else(|| AppError::unauthorized("Client credential required"))?;
    state
        .registry
        .sources
        .authenticate(credential, pending)
        .map_err(|_| AppError::unauthorized("Client registration is invalid, expired or revoked"))
}
pub(super) async fn join_client(
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
pub(super) async fn client_oss(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<impl IntoResponse, AppError> {
    client_auth(&state, &headers, false)?;
    let config = config_path()?;
    let stores = crate::storage::oss::list(config.parent().context("missing config directory")?)?;
    Ok((
        no_store(),
        Json(serde_json::json!({"stores": stores, "can_share": true})),
    ))
}

pub(super) async fn client_plugins(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<impl IntoResponse, AppError> {
    client_auth(&state, &headers, false)?;
    let dir = config_path()?
        .parent()
        .context("missing config parent")?
        .to_owned();
    let mut catalog = crate::plugin::list(&dir)?;
    if let Some(plugins) = catalog["plugins"].as_array_mut() {
        for plugin in plugins {
            plugin["source"] = serde_json::json!("server");
        }
    }
    Ok((no_store(), Json(catalog)))
}

pub(super) async fn client_info(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<impl IntoResponse, AppError> {
    Ok((no_store(), Json(client_auth(&state, &headers, true)?)))
}
pub(super) async fn activate_client(
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
pub(super) async fn revoke_client(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<impl IntoResponse, AppError> {
    let source = client_auth(&state, &headers, true)?;
    state.registry.revoke_source(&source.id)?;
    Ok((no_store(), Json(serde_json::json!({"revoked":true}))))
}
#[derive(Deserialize)]
pub(super) struct LocalRequest {
    name: String,
    host: String,
    user: String,
}
pub(super) async fn local_client(
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
    let (user, host) = crate::runtime::identity::local_identity()?;
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
