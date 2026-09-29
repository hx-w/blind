use super::{access::PatAuth, dto::HealthResponse, error::AppError, no_store, state::AppState};
use crate::{
    protocol::control::{ControlHealth, DoctorAction, DoctorRegistryReport},
    runtime::network::discover,
};
use axum::{
    Json,
    extract::State,
    http::{HeaderValue, StatusCode, header},
    response::IntoResponse,
};

pub(super) async fn health(State(state): State<AppState>) -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "ok",
        version: env!("CARGO_PKG_VERSION"),
        scene_schema: 7,
        image_renderer: state.renderer.is_some(),
    })
}

pub(super) async fn control_health(_pat: PatAuth) -> Result<impl IntoResponse, AppError> {
    Ok((
        no_store(),
        Json(ControlHealth {
            service: "blind".into(),
            pid: std::process::id(),
            version: Some(env!("CARGO_PKG_VERSION").into()),
        }),
    ))
}

pub(super) async fn control_stop(
    State(state): State<AppState>,
    _pat: PatAuth,
) -> Result<impl IntoResponse, AppError> {
    state
        .shutdown
        .try_send(())
        .map_err(|_| AppError::unavailable("Blind shutdown is already in progress"))?;
    Ok((StatusCode::ACCEPTED, no_store()))
}

pub(super) async fn control_doctor(
    State(state): State<AppState>,
    _pat: PatAuth,
) -> Result<impl IntoResponse, AppError> {
    doctor_registry_response(&state, DoctorAction::Audit).await
}

pub(super) async fn control_doctor_clean_invalid(
    State(state): State<AppState>,
    _pat: PatAuth,
) -> Result<impl IntoResponse, AppError> {
    doctor_registry_response(&state, DoctorAction::CleanInvalid).await
}

pub(super) async fn control_doctor_clear_all(
    State(state): State<AppState>,
    _pat: PatAuth,
) -> Result<impl IntoResponse, AppError> {
    doctor_registry_response(&state, DoctorAction::ClearAll).await
}

pub(super) async fn doctor_registry_response(
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

pub(super) async fn hosts(
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
