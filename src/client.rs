//! Short-lived CLI. Only the OS SSH service remains running on a remote source.
use crate::{
    config::{Config, config_path},
    scene::{MeshLabel, MeshLabelGroup},
    source::{Invitation, JoinRequest, JoinResponse, Source, write_private},
};
use anyhow::{Context, Result, bail};
use clap::{Parser, Subcommand, ValueEnum};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};

#[derive(Parser)]
#[command(
    name = "blind",
    version,
    about = "Share geometry through local or remote Blind sources",
    after_help = "Run blind serve on A. Join once with blind join --stdin; then use blind share model.ply --label '1=Crown' --format json. Use comma-separated indices to label a group: --label '1,2=Reference'. The Client needs no background process."
)]
struct Cli {
    #[command(subcommand)]
    command: ClientCommand,
}
#[derive(Subcommand)]
enum ClientCommand {
    /// Join using an invitation from stdin, or register with the same-user local server.
    Join {
        #[arg(long, conflicts_with = "local")]
        stdin: bool,
        #[arg(long, conflicts_with = "stdin")]
        local: bool,
        /// Address the server can use to reach this machine; default: the request's source IP.
        #[arg(long)]
        address: Option<String>,
        #[arg(long)]
        port: Option<u16>,
        #[arg(long)]
        name: Option<String>,
    },
    /// Create unchanged /s/ and /i/ links on the registered server.
    #[command(
        after_help = "Examples:\n  blind share crown.ply --label '1=Crown'\n  blind share donor-a.ply donor-b.ply --label '1=Donor A' --label '1,2=Reference pair'"
    )]
    Share {
        #[arg(required = true)]
        meshes: Vec<PathBuf>,
        #[arg(long)]
        title: Option<String>,
        /// Label one Mesh (1=TEXT) or a group (1,2,3=TEXT). Repeat as needed.
        #[arg(
            long = "label",
            value_name = "INDEX[,INDEX...]=TEXT",
            help = "Label one Mesh (1=TEXT) or a group (1,2,3=TEXT); repeat as needed"
        )]
        labels: Vec<String>,
        #[arg(long)]
        host: Option<String>,
        #[arg(long)]
        stateless: bool,
        #[arg(long, value_enum, default_value = "full")]
        format: OutputFormat,
    },
    /// Show this OS user's registration, without exposing credentials.
    Status {
        #[arg(long)]
        json: bool,
    },
    /// Revoke this registration and remove only its managed SSH authorization.
    Leave,
    #[command(flatten)]
    Server(crate::server_cli::Command),
}
#[derive(Clone, Copy, ValueEnum)]
enum OutputFormat {
    View,
    Image,
    Full,
    Json,
}
#[derive(Clone, Serialize, Deserialize)]
struct ClientConfig {
    server: String,
    credential: String,
    source: Source,
    public_key: String,
    challenge: String,
    challenge_path: Option<String>,
}
fn client_path() -> Result<PathBuf> {
    if let Some(dir) = std::env::var_os("BLIND_CLIENT_DIR") {
        return Ok(PathBuf::from(dir).join("client.json"));
    }
    Ok(config_path()?
        .parent()
        .context("config parent missing")?
        .join("client.json"))
}
fn load() -> Result<Option<ClientConfig>> {
    let path = client_path()?;
    if !path.exists() {
        return Ok(None);
    }
    Ok(Some(serde_json::from_slice(&fs::read(path)?)?))
}
fn save(c: &ClientConfig) -> Result<()> {
    crate::source::private_dir(
        client_path()?
            .parent()
            .context("missing Client directory")?,
    )?;
    write_private(&client_path()?, &serde_json::to_vec_pretty(c)?)
}
fn home() -> Result<PathBuf> {
    Ok(PathBuf::from(
        std::env::var_os("HOME").context("HOME is unset")?,
    ))
}
pub(crate) fn local_identity() -> Result<(String, String)> {
    let user = Command::new("id").arg("-un").output()?;
    let host = Command::new("hostname").output()?;
    if !user.status.success() || !host.status.success() {
        bail!("could not identify this OS user");
    }
    Ok((
        String::from_utf8(user.stdout)?.trim().to_owned(),
        String::from_utf8(host.stdout)?.trim().to_owned(),
    ))
}
fn normalize_server(server: &str) -> Result<String> {
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
async fn api(server: &str, path: &str, token: &str, body: Option<Value>) -> Result<Value> {
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
    };
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
struct ApiError {
    status: reqwest::StatusCode,
    message: String,
}
pub async fn run() -> Result<()> {
    match Cli::parse().command {
        ClientCommand::Server(command) => crate::server_cli::run(command).await?,
        ClientCommand::Join {
            stdin,
            local,
            address,
            port,
            name,
        } => join(stdin, local, address, port, name).await?,
        ClientCommand::Share {
            meshes,
            title,
            labels,
            host,
            stateless,
            format,
        } => share(meshes, title, labels, host, stateless, format).await?,
        ClientCommand::Status { json: as_json } => {
            let c =
                load()?.context("not registered; run blind join --stdin or blind join --local")?;
            let status = api(&c.server, "/api/v1/client", &c.credential, None).await?;
            if as_json {
                println!("{}", serde_json::to_string_pretty(&status)?);
            } else {
                println!(
                    "{} → {} ({})",
                    c.source.name,
                    c.server,
                    if c.source.active {
                        "registered"
                    } else {
                        "pending"
                    }
                );
            }
        }
        ClientCommand::Leave => {
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
                    return Err(error.context("local SSH authorization removed; retry blind leave when the server is reachable"));
                }
            }
            cleanup_challenge(&c);
            fs::remove_file(client_path()?)?;
            println!("Registration revoked; other SSH keys and users were preserved.");
        }
    }
    Ok(())
}
async fn join(
    stdin: bool,
    local: bool,
    address: Option<String>,
    port: Option<u16>,
    name: Option<String>,
) -> Result<()> {
    if let Some(mut c) = load()? {
        if c.source.active {
            api(&c.server, "/api/v1/client", &c.credential, None).await?;
            if address.is_some() || port.is_some() || name.is_some() {
                bail!(
                    "already registered; use blind leave before changing registration (existing links will be revoked)"
                );
            }
            eprintln!("Already registered: {} → {}", c.source.name, c.server);
            return Ok(());
        }
        finish_join(&mut c, address, port).await?;
        eprintln!("Registered: {} → {}", c.source.name, c.server);
        return Ok(());
    }
    let (user, hostname) = local_identity()?;
    let name = name.unwrap_or_else(|| format!("{user}@{hostname}"));
    let (server, response) = if local {
        let (config, _) = Config::load_or_create()?;
        let server = format!(
            "http://{}{}",
            crate::server::control_address(&config)?,
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
        if !stdin {
            bail!("use blind join --stdin and paste an invitation, or blind join --local");
        }
        let host_key = local_host_key()?;
        sftp_command()?;
        let mut input = String::new();
        use std::io::Read;
        std::io::stdin().take(16_385).read_to_string(&mut input)?;
        let invitation = Invitation::decode(&input)?;
        let server = normalize_server(&invitation.server)?;
        let req = JoinRequest {
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
    if !c.source.local {
        finish_join(&mut c, None, None).await?;
    }
    eprintln!("Registered: {} → {}", c.source.name, c.server);
    Ok(())
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
        || !crate::source::valid_id(&c.source.id)
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
    crate::source::private_dir(path.parent().unwrap())?;
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
    if c.source.local {
        Ok(())
    } else {
        edit_authorization(c, false)
    }
}
async fn share(
    meshes: Vec<PathBuf>,
    title: Option<String>,
    labels: Vec<String>,
    host: Option<String>,
    stateless: bool,
    format: OutputFormat,
) -> Result<()> {
    if load()?.is_none() {
        join(false, true, None, None, None).await?;
    }
    let c = load()?.context("not registered")?;
    let paths = meshes
        .iter()
        .map(|p| {
            fs::canonicalize(p)
                .with_context(|| format!("cannot resolve {}", p.display()))
                .map(|p| p.to_string_lossy().into_owned())
        })
        .collect::<Result<Vec<_>>>()?;
    let labels = parse_labels(&labels, paths.len())?;
    let payload=api(&c.server,"/api/v1/client/scenes",&c.credential,Some(json!({"paths":paths,"title":title,"labels":labels.meshes,"label_groups":labels.groups,"origin":host,"stateless":stateless}))).await?;
    match format {
        OutputFormat::Json => println!("{}", serde_json::to_string_pretty(&payload)?),
        OutputFormat::View => println!(
            "{}",
            payload["viewer_url"]
                .as_str()
                .context("missing viewer URL")?
        ),
        OutputFormat::Image => println!(
            "{}",
            payload["image_url"].as_str().context("missing image URL")?
        ),
        OutputFormat::Full => println!(
            "{}",
            payload["full_text"]
                .as_str()
                .context("missing full information")?
        ),
    }
    Ok(())
}

#[derive(Debug, PartialEq)]
pub struct ParsedLabels {
    pub meshes: Vec<Option<MeshLabel>>,
    pub groups: Vec<MeshLabelGroup>,
}

pub fn parse_labels(labels: &[String], count: usize) -> Result<ParsedLabels> {
    let mut meshes = vec![None; count];
    let mut groups = Vec::new();
    for label in labels {
        let (selectors, text) = label
            .split_once('=')
            .context("use --label INDEX[,INDEX...]=TEXT")?;
        let indices = selectors
            .split(',')
            .map(|value| {
                value
                    .trim()
                    .parse::<usize>()?
                    .checked_sub(1)
                    .filter(|index| *index < count)
                    .context("label index out of range")
            })
            .collect::<Result<Vec<_>>>()?;
        if indices.is_empty() {
            bail!("a label needs at least one Mesh index");
        }
        let mesh_label = MeshLabel {
            text: text.trim().into(),
            anchor: None,
        };
        mesh_label.validate()?;
        if indices.len() == 1 {
            let index = indices[0];
            if meshes[index].is_some() {
                bail!("duplicate label index");
            }
            meshes[index] = Some(mesh_label);
        } else {
            let group = MeshLabelGroup {
                text: mesh_label.text,
                meshes: indices,
            };
            group.validate(count)?;
            groups.push(group);
        }
    }
    Ok(ParsedLabels { meshes, groups })
}

#[cfg(test)]
mod tests {
    use super::*;
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
    #[test]
    fn labels_preserve_one_based_indices_and_reject_duplicates() {
        let labels = parse_labels(&["2= Preparation ".into()], 2).unwrap();
        assert!(labels.meshes[0].is_none());
        assert_eq!(labels.meshes[1].as_ref().unwrap().text, "Preparation");
        assert!(parse_labels(&["1=A".into(), "1=B".into()], 2).is_err());
    }

    #[test]
    fn one_label_can_target_a_group_and_coexist_with_mesh_labels() {
        let labels = parse_labels(&["1= Crown ".into(), "1, 2=Reference".into()], 2).unwrap();
        assert_eq!(labels.meshes[0].as_ref().unwrap().text, "Crown");
        assert_eq!(labels.groups.len(), 1);
        assert_eq!(labels.groups[0].text, "Reference");
        assert_eq!(labels.groups[0].meshes, [0, 1]);
        assert!(parse_labels(&["1,1=Duplicate".into()], 2).is_err());
        assert!(parse_labels(&["1,3=Range".into()], 2).is_err());
    }

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
