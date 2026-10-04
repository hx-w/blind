//! Execute a one-shot resolver using the installed immutable package.
use super::{FEATURES, LIMIT, PreparedPackage, ShareManifest, list, validate_binding};
use anyhow::{Context, Result, bail, ensure};
use serde_json::{Value, json};
use std::{collections::BTreeMap, path::Path, process::Stdio, time::Duration};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

pub async fn resolve(
    dir: &Path,
    uri: &str,
) -> Result<(ShareManifest, Option<super::RendererBundle>)> {
    execute(dir, uri, false).await
}

/// Same one-shot protocol and subprocess limits, with source-host absolute paths enabled.
pub async fn resolve_local(
    dir: &Path,
    uri: &str,
) -> Result<(ShareManifest, Option<super::RendererBundle>)> {
    execute(dir, uri, true).await
}

async fn execute(
    dir: &Path,
    uri: &str,
    allow_local: bool,
) -> Result<(ShareManifest, Option<super::RendererBundle>)> {
    let (scheme, _) = uri.split_once("://").context("invalid plugin URI")?;
    let catalog = list(dir)?;
    let mut matches = catalog["plugins"]
        .as_array()
        .context("invalid plugin catalog")?
        .iter()
        .filter(|p| {
            p["schemes"]
                .as_array()
                .is_some_and(|schemes| schemes.contains(&json!(scheme)))
        });
    let id = matches
        .next()
        .and_then(|p| p["id"].as_str())
        .with_context(|| format!("host has no plugin for {scheme}://"))?;
    ensure!(
        matches.next().is_none(),
        "multiple installed plugins handle {scheme}://"
    );
    let prepared = super::package::prepare_installed(dir, id)?;
    let plan = resolve_prepared(dir, &prepared, uri, allow_local).await?;
    let bundle = if prepared.manifest().components.is_empty() {
        None
    } else {
        Some(prepared.into_renderer_bundle())
    };
    Ok((plan, bundle))
}

/// Execute a captured direct-directory package without installing it.
pub async fn resolve_prepared(
    dir: &Path,
    prepared: &PreparedPackage,
    uri: &str,
    allow_local: bool,
) -> Result<ShareManifest> {
    let (scheme, input) = uri.split_once("://").context("invalid plugin URI")?;
    let i = &prepared.package;
    ensure!(
        i.manifest.schemes.iter().any(|value| value == scheme),
        "selected plugin does not handle {scheme}://"
    );
    ensure!(!i.manifest.entrypoint.is_empty(), "plugin has no resolver");
    let environment = &prepared.environment;
    if !allow_local {
        validate_binding(dir, environment)?;
    }
    let request = json!({"jsonrpc":"2.0","id":"resolve","method":"resolve","params":{"protocol_version":2,"input":input,"context":{"server_version":env!("CARGO_PKG_VERSION"),"capabilities":FEATURES,"deadline":crate::storage::sources::now()+60}}});
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
        .envs(environment)
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
    validate_output_sources(&plan, environment, allow_local)?;
    if allow_local {
        let snapshot_directory = std::fs::canonicalize(&i.directory)?;
        for uri in plan
            .resources
            .iter()
            .chain(&plan.attachments)
            .map(|resource| resource.uri.as_str())
            .chain(
                plan.components
                    .iter()
                    .map(|component| component.uri.as_str()),
            )
        {
            let path = Path::new(uri);
            if path.is_absolute() {
                let resolved = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
                ensure!(
                    !resolved.starts_with(&snapshot_directory) && !path.starts_with(&i.directory),
                    "plugin sources must persist outside the private execution snapshot"
                );
            }
        }
    }
    Ok(plan)
}

fn validate_output_sources(
    plan: &ShareManifest,
    environment: &BTreeMap<String, String>,
    allow_local: bool,
) -> Result<()> {
    for uri in plan
        .resources
        .iter()
        .chain(&plan.attachments)
        .map(|r| r.uri.as_str())
        .chain(plan.components.iter().map(|c| c.uri.as_str()))
    {
        ensure!(!uri.contains('\0'), "invalid plugin source path");
        if allow_local && Path::new(uri).is_absolute() {
            continue;
        }
        let loc = crate::storage::oss::Location::parse(uri).context(if allow_local {
            "plugins may only return OSS resources or absolute local paths"
        } else {
            "plugins may only return OSS resources"
        })?;
        if let Some(alias) = environment.get("OSS_ALIAS") {
            ensure!(
                *alias == loc.alias
                    && environment
                        .get("BUCKET")
                        .is_some_and(|bucket| *bucket == loc.bucket),
                "plugin returned an OSS resource outside its configured binding"
            );
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn plan(uri: &str) -> ShareManifest {
        serde_json::from_value(json!({"schema_version":1,"resources":[{"id":"a","uri":uri}]}))
            .unwrap()
    }
    #[test]
    fn resolver_sources_are_host_specific_and_non_recursive() {
        for uri in [
            "https://example.test/a.ply",
            "example://nested",
            "file:///tmp/a.ply",
            "relative/a.ply",
        ] {
            assert!(validate_output_sources(&plan(uri), &BTreeMap::new(), true).is_err());
            assert!(validate_output_sources(&plan(uri), &BTreeMap::new(), false).is_err());
        }
        validate_output_sources(&plan("/tmp/a.ply"), &BTreeMap::new(), true).unwrap();
        assert!(validate_output_sources(&plan("/tmp/a.ply"), &BTreeMap::new(), false).is_err());
        validate_output_sources(&plan("oss://team/bucket/a.ply"), &BTreeMap::new(), false).unwrap();
        assert!(
            validate_output_sources(
                &plan("oss://other/bucket/a.ply"),
                &BTreeMap::from([
                    ("OSS_ALIAS".into(), "team".into()),
                    ("BUCKET".into(), "bucket".into())
                ]),
                true
            )
            .is_err()
        );
        assert!(validate_output_sources(&plan("/tmp/a\0.ply"), &BTreeMap::new(), true).is_err());
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn directory_resolver_captures_bytes_and_injects_only_protocol_two_environment() {
        let host = tempfile::tempdir().unwrap();
        let source = tempfile::tempdir().unwrap();
        std::fs::write(
            source.path().join("blind-plugin.toml"),
            r#"
id = "demo"
name = "Demo"
version = "1.0.0"
authors = [{name = "Demo Team"}]
schemes = ["demo"]
entrypoint = ["/bin/sh", "resolver.sh"]
files = ["resolver.sh"]
[env.TOKEN]
required = true
secret = true
[env.COUNT]
type = "integer"
default = 7
"#,
        )
        .unwrap();
        std::fs::write(source.path().join(".env"), "TOKEN=private\n").unwrap();
        std::fs::write(source.path().join("resolver.sh"), r#"
read -r request
case "$request" in *'"protocol_version":2'*) ;; *) exit 1;; esac
case "$request" in *'"config":'*) exit 2;; esac
[ "$TOKEN" = private ] && [ "$COUNT" = 7 ] && [ -z "${HOME+x}" ] || exit 3
printf '%s\n' '{"jsonrpc":"2.0","id":"resolve","result":{"schema_version":1,"resources":[{"id":"a","uri":"/tmp/snapshot.ply"}]}}'
"#).unwrap();
        let prepared = super::super::prepare_directory(source.path()).unwrap();
        std::fs::write(source.path().join("resolver.sh"), "exit 9\n").unwrap();
        std::fs::write(source.path().join(".env"), "TOKEN=changed\n").unwrap();
        let plan = resolve_prepared(host.path(), &prepared, "demo://input", true)
            .await
            .unwrap();
        assert_eq!(plan.resources[0].uri, "/tmp/snapshot.ply");
        assert!(!host.path().join("plugins/demo/current.json").exists());
        assert!(
            resolve_prepared(host.path(), &prepared, "other://input", true)
                .await
                .is_err()
        );
    }
}
