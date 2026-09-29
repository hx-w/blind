use anyhow::{Context, Result, bail};
use serde_json::Value;

pub(crate) fn normalize_server(server: &str) -> Result<String> {
    let url = url::Url::parse(server)?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        bail!("server must be an HTTP(S) URL without credentials, query or fragment");
    }
    Ok(server.trim_end_matches('/').to_owned())
}
pub(crate) async fn api(
    server: &str,
    path: &str,
    token: &str,
    body: Option<Value>,
) -> Result<Value> {
    let server = normalize_server(server)?;
    let http = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(std::time::Duration::from_secs(5))
        .timeout(std::time::Duration::from_secs(180))
        .build()?;
    let url = format!("{server}{path}");
    let request = if let Some(body) = body {
        http.post(&url).json(&body)
    } else {
        http.get(&url)
    }
    .timeout(
        if matches!(path, "/api/v1/scenes" | "/api/v1/client/scenes") {
            std::time::Duration::from_secs(30 * 60)
        } else {
            std::time::Duration::from_secs(180)
        },
    );
    let mut response = request
        .bearer_auth(token)
        .send()
        .await
        .context("could not contact Blind server")?;
    let status = response.status();
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        if bytes.len() + chunk.len() > 4 * 1024 * 1024 {
            bail!("server response too large");
        }
        bytes.extend_from_slice(&chunk);
    }
    let payload: Value = serde_json::from_slice(&bytes).context("server returned invalid JSON")?;
    if !status.is_success() {
        return Err(ApiError {
            status,
            message: payload
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("request failed")
                .to_owned(),
        }
        .into());
    }
    Ok(payload)
}
#[derive(Debug, thiserror::Error)]
#[error("Blind server ({status}): {message}")]
pub(crate) struct ApiError {
    pub(crate) status: reqwest::StatusCode,
    pub(crate) message: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn server_urls_preserve_base_path_and_reject_embedded_secrets() {
        assert_eq!(
            normalize_server("https://a/blind/").unwrap(),
            "https://a/blind"
        );
        assert!(normalize_server("https://user:secret@a").is_err());
        assert!(normalize_server("file:///tmp/a").is_err());
    }
}
