//! Outbound API access and source-machine registration.
mod config;
pub(crate) mod control;
mod http;
use crate::{
    protocol::registration::{Invitation, JoinRequest, JoinResponse},
    runtime::config::Config,
    runtime::files::write_private,
};
use anyhow::{Context, Result, bail};
pub(crate) use config::load;
use config::{ClientConfig, client_path, save};
use http::normalize_server;
pub(crate) use http::{ApiError, api};
use serde_json::{Value, json};
use std::{
    fs,
    path::{Path, PathBuf},
};

fn home() -> Result<PathBuf> {
    Ok(PathBuf::from(
        std::env::var_os("HOME").context("HOME is unset")?,
    ))
}
pub(crate) struct JoinResult {
    pub name: String,
    pub server: String,
    pub already_registered: bool,
}

pub(crate) async fn join(
    invitation: Option<Invitation>,
    local: bool,
    client_only: bool,
    address: Option<String>,
    port: Option<u16>,
    name: Option<String>,
) -> Result<JoinResult> {
    if let Some(mut c) = load()? {
        if c.source.active {
            api(&c.server, "/api/v1/client", &c.credential, None).await?;
            if address.is_some() || port.is_some() || name.is_some() {
                bail!(
                    "already registered; use blind leave before changing registration (existing links will be revoked)"
                );
            }
            return Ok(JoinResult {
                name: c.source.name,
                server: c.server,
                already_registered: true,
            });
        }
        finish_join(&mut c, address, port).await?;
        return Ok(JoinResult {
            name: c.source.name,
            server: c.server,
            already_registered: false,
        });
    }
    let (user, hostname) = crate::runtime::identity::local_identity()?;
    let name = name.unwrap_or_else(|| format!("{user}@{hostname}"));
    let (server, response) = if local {
        let (config, _) = Config::load_or_create()?;
        let server = format!(
            "http://{}{}",
            crate::runtime::config::control_address(&config)?,
            config.base_path().unwrap_or_default()
        );
        let response = api(
            &server,
            "/api/v1/control/sources/local",
            &config.pat,
            Some(json!({"name":name,"host":hostname,"user":user})),
        )
        .await?;
        (server, serde_json::from_value::<JoinResponse>(response)?)
    } else {
        let invitation = invitation
            .context("use blind join --stdin and paste an invitation, or blind join --local")?;
        let host_key = if client_only {
            String::new()
        } else {
            sftp_command()?;
            local_host_key()?
        };
        let server = normalize_server(&invitation.server)?;
        let req = JoinRequest {
            client_only,
            name,
            hostname,
            host: address.unwrap_or_default(),
            port: port.unwrap_or(22),
            user,
            host_key,
        };
        let response = api(
            &server,
            "/api/v1/clients/join",
            &invitation.token,
            Some(serde_json::to_value(req)?),
        )
        .await?;
        (server, serde_json::from_value::<JoinResponse>(response)?)
    };
    let mut c = ClientConfig {
        server,
        credential: response.credential,
        source: response.source,
        public_key: response.public_key,
        challenge: response.challenge,
        challenge_path: None,
    };
    // Persist the pending receipt before touching SSH so an interrupted join can resume.
    save(&c)?;
    if !c.source.active {
        finish_join(&mut c, None, None).await?;
    }
    Ok(JoinResult {
        name: c.source.name,
        server: c.server,
        already_registered: false,
    })
}
async fn finish_join(
    c: &mut ClientConfig,
    address: Option<String>,
    port: Option<u16>,
) -> Result<()> {
    install_authorization(c)?;
    let challenge_path = client_path()?
        .parent()
        .unwrap()
        .join(format!("verify-{}", c.source.id));
    write_private(&challenge_path, c.challenge.as_bytes())?;
    c.challenge_path = Some(challenge_path.to_string_lossy().into_owned());
    save(c)?;
    match api(
        &c.server,
        "/api/v1/client/activate",
        &c.credential,
        Some(json!({"challenge_path":c.challenge_path,"host":address,"port":port})),
    )
    .await
    {
        Ok(value) => {
            c.source = serde_json::from_value(value)?;
            cleanup_challenge(c);
            c.challenge_path = None;
            c.challenge.clear();
            save(c)?;
            Ok(())
        }
        Err(error) => {
            remove_authorization(c)?;
            cleanup_challenge(c);
            Err(error.context("registration remains pending for 10 minutes; check SSH/SFTP, then retry blind join --address HOST. After 10 minutes, run blind leave and reuse the invitation; if it was revoked, request the current invitation"))
        }
    }
}
fn cleanup_challenge(c: &ClientConfig) {
    if let Some(path) = &c.challenge_path {
        let _ = fs::remove_file(path);
    }
}
fn local_host_key() -> Result<String> {
    for name in [
        "ssh_host_ed25519_key.pub",
        "ssh_host_ecdsa_key.pub",
        "ssh_host_rsa_key.pub",
    ] {
        if let Ok(value) = fs::read_to_string(Path::new("/etc/ssh").join(name)) {
            if let Some(key) = value.split_whitespace().nth(1) {
                return Ok(key.to_owned());
            }
        }
    }
    bail!(
        "SSH host key not found. On macOS enable System Settings → General → Sharing → Remote Login and allow this user, then retry."
    )
}
fn sftp_command() -> Result<&'static str> {
    for path in [
        "/usr/libexec/sftp-server",
        "/usr/lib/openssh/sftp-server",
        "/usr/lib/ssh/sftp-server",
        "/usr/libexec/openssh/sftp-server",
    ] {
        if Path::new(path).is_file() {
            return Ok(path);
        }
    }
    bail!(
        "OpenSSH SFTP server is not installed; enable the operating system SSH/SFTP service first"
    )
}
fn authorized_path() -> Result<PathBuf> {
    Ok(home()?.join(".ssh/authorized_keys"))
}
fn authorized_line(c: &ClientConfig) -> Result<String> {
    let mut parts = c.public_key.split_whitespace();
    let kind = parts.next().context("missing key type")?;
    let key = parts.next().context("missing key")?;
    if kind != "ssh-ed25519"
        || base64::Engine::decode(&base64::engine::general_purpose::STANDARD, key).is_err()
        || !crate::storage::sources::valid_id(&c.source.id)
    {
        bail!("invalid server public key");
    }
    Ok(format!(
        "restrict,command=\"{} -R\" {kind} {key} blind:{}",
        sftp_command()?,
        c.source.id
    ))
}
fn edit_authorization(c: &ClientConfig, add: bool) -> Result<()> {
    let path = authorized_path()?;
    crate::runtime::files::private_dir(path.parent().unwrap())?;
    // Lock our own editing operations and preserve unrelated authorized_keys bytes.
    let lock_path = path.with_file_name("blind-authorized-keys.lock");
    let lock = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(lock_path)?;
    #[cfg(unix)]
    {
        use std::os::fd::AsRawFd;
        if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX) } != 0 {
            return Err(std::io::Error::last_os_error().into());
        }
    }
    let path = if path
        .symlink_metadata()
        .is_ok_and(|m| m.file_type().is_symlink())
    {
        fs::canonicalize(&path)?
    } else {
        path
    };
    let old = match fs::read_to_string(&path) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(e.into()),
    };
    let line = authorized_line(c)?;
    let mut result = old
        .split_inclusive('\n')
        .filter(|s| s.trim_end_matches(['\r', '\n']) != line)
        .collect::<String>();
    if add {
        if !result.is_empty() && !result.ends_with('\n') {
            result.push('\n');
        }
        result.push_str(&line);
        result.push('\n');
    }
    write_private(&path, result.as_bytes())?;
    drop(lock);
    Ok(())
}
fn install_authorization(c: &ClientConfig) -> Result<()> {
    edit_authorization(c, true)
}
fn remove_authorization(c: &ClientConfig) -> Result<()> {
    if c.source.local || c.source.client_only {
        Ok(())
    } else {
        edit_authorization(c, false)
    }
}
pub(crate) async fn remote_plugins() -> Result<Option<Value>> {
    match load()? {
        Some(c) => Ok(Some(
            api(&c.server, "/api/v1/client/plugins", &c.credential, None).await?,
        )),
        None => Ok(None),
    }
}

pub(crate) async fn leave() -> Result<()> {
    let c = load()?.context("not registered")?;
    remove_authorization(&c)?;
    let result = api(
        &c.server,
        "/api/v1/client/revoke",
        &c.credential,
        Some(json!({})),
    )
    .await;
    if let Err(error) = result {
        if !error
            .downcast_ref::<ApiError>()
            .is_some_and(|e| e.status == reqwest::StatusCode::UNAUTHORIZED)
        {
            return Err(error.context(
                "local SSH authorization removed; retry blind leave when the server is reachable",
            ));
        }
    }
    cleanup_challenge(&c);
    fs::remove_file(client_path()?)?;
    Ok(())
}

/// None means this process manages local Server configuration.
pub(crate) async fn remote_oss() -> Result<Option<(Vec<crate::storage::oss::StoreInfo>, bool)>> {
    let Some(c) = load()? else {
        return Ok(None);
    };
    if c.source.local {
        return Ok(None);
    }
    let payload = api(&c.server, "/api/v1/client/oss", &c.credential, None).await?;
    let stores: Vec<crate::storage::oss::StoreInfo> =
        serde_json::from_value(payload["stores"].clone())
            .context("Server does not support OSS discovery")?;
    Ok(Some((
        stores,
        payload["can_share"].as_bool().unwrap_or(false),
    )))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::registration::Source;
    #[test]
    fn authorization_is_readonly_and_cannot_open_shell_or_forward() {
        let c = ClientConfig {
            server: "http://a".into(),
            credential: "not-a-real-credential".into(),
            source: Source {
                id: "abc123".into(),
                name: "Carol".into(),
                host: "B".into(),
                hostname: "B".into(),
                port: 22,
                user: "carol".into(),
                host_key: String::new(),
                local: false,
                client_only: false,
                active: false,
            },
            public_key: "ssh-ed25519 YWJjZA== test".into(),
            challenge: String::new(),
            challenge_path: None,
        };
        let line = authorized_line(&c).unwrap();
        assert!(line.starts_with("restrict,command=\""));
        assert!(line.contains("sftp-server -R\" ssh-ed25519"));
        assert!(line.ends_with("blind:abc123"));
    }
}
