//! Outbound local-owner control API.
use crate::{
    protocol::control::{ControlHealth, DoctorAction, DoctorRegistryReport},
    runtime::config::{Config, control_address},
};
use anyhow::Context;
use axum::http::{Method, Request, StatusCode, header};
use bytes::Bytes;
use http_body_util::{BodyExt, Empty};
use hyper_util::{
    client::legacy::{Client, connect::HttpConnector},
    rt::TokioExecutor,
};
use std::time::{Duration, Instant};

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
