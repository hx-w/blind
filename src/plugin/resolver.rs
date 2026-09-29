//! Execute a one-shot resolver using the installed immutable package.
use super::{
    FEATURES, LIMIT, ShareManifest, installed, list, settings, validate_binding, validate_config,
    validate_manifest,
};
use anyhow::{Context, Result, bail, ensure};
use serde_json::{Value, json};
use std::{path::Path, process::Stdio, time::Duration};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

pub async fn resolve(dir: &Path, uri: &str) -> Result<ShareManifest> {
    let (scheme, input) = uri.split_once("://").context("invalid plugin URI")?;
    let catalog = list(dir)?;
    let id = catalog["plugins"]
        .as_array()
        .context("invalid plugin catalog")?
        .iter()
        .find(|p| {
            p["schemes"]
                .as_array()
                .is_some_and(|ss| ss.contains(&json!(scheme)))
        })
        .and_then(|p| p["id"].as_str())
        .with_context(|| format!("Server has no plugin for {scheme}://"))?;
    let i = installed(dir, id)?;
    validate_manifest(&i.manifest)?;
    let config = settings(dir, &i.manifest)?;
    validate_config(&i.manifest, &config)?;
    validate_binding(dir, &config)?;
    let request = json!({"jsonrpc":"2.0","id":"resolve","method":"resolve","params":{"protocol_version":1,"input":input,"config":config,"context":{"server_version":env!("CARGO_PKG_VERSION"),"capabilities":FEATURES,"deadline":crate::storage::sources::now()+60}}});
    let mut payload = serde_json::to_vec(&request)?;
    payload.push(b'\n');
    ensure!(payload.len() <= LIMIT, "plugin input too large");
    let mut child = tokio::process::Command::new(&i.executable)
        .args(&i.manifest.entrypoint[1..])
        .current_dir(&i.directory)
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("PYTHONDONTWRITEBYTECODE", "1")
        .env("PYTHONIOENCODING", "utf-8")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .context("could not start plugin runtime")?;
    let mut stdin = child.stdin.take().context("plugin stdin missing")?;
    let stdout = child.stdout.take().context("plugin stdout missing")?;
    let operation = async {
        let writer = async {
            stdin.write_all(&payload).await?;
            drop(stdin);
            Ok::<_, anyhow::Error>(())
        };
        let reader = async {
            let mut bytes = Vec::new();
            stdout
                .take((LIMIT + 1) as u64)
                .read_to_end(&mut bytes)
                .await?;
            ensure!(bytes.len() <= LIMIT, "plugin output exceeds 4 MiB");
            Ok::<_, anyhow::Error>(bytes)
        };
        let (_, bytes) = tokio::try_join!(writer, reader)?;
        ensure!(child.wait().await?.success(), "plugin process failed");
        Ok::<_, anyhow::Error>(bytes)
    };
    let bytes = tokio::time::timeout(Duration::from_secs(60), operation)
        .await
        .context("plugin timed out after 60 seconds")??;
    let response: Value = serde_json::from_slice(&bytes).context("plugin returned invalid JSON")?;
    ensure!(
        response["jsonrpc"] == "2.0"
            && response["id"] == "resolve"
            && (response.get("result").is_some() != response.get("error").is_some()),
        "invalid plugin response envelope"
    );
    if let Some(error) = response.get("error") {
        // Do not forward arbitrary subprocess text (it could contain secrets).
        let code = error["data"]["code"].as_str().unwrap_or("PLUGIN_ERROR");
        let code = if code.len() <= 64
            && !code.is_empty()
            && code
                .bytes()
                .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == b'_')
        {
            code
        } else {
            "PLUGIN_ERROR"
        };
        bail!("{code}: plugin resolver failed; check plugin configuration and source availability");
    }
    let plan: ShareManifest =
        serde_json::from_value(response["result"].clone()).context("invalid share manifest")?;
    plan.validate()?;
    for uri in plan
        .resources
        .iter()
        .chain(&plan.attachments)
        .map(|r| &r.uri)
        .chain(plan.components.iter().map(|c| &c.uri))
    {
        let loc = crate::storage::oss::Location::parse(uri)
            .context("plugins may only return OSS resources")?;
        if config.get("oss_alias").is_some() {
            ensure!(
                config["oss_alias"] == loc.alias && config["bucket"] == loc.bucket,
                "plugin returned an OSS resource outside its configured binding"
            );
        }
    }
    Ok(plan)
}
