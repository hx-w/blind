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
    after_help = "Run blind serve on A. Join once with blind join --stdin; then use blind share model.ply --label '1=Crown' --format json. For large resource sets, use blind share --config scene.json. Use comma-separated indices to label a group: --label '1,2=Reference'. The Client needs no background process."
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
        /// Register for OSS and plugins without installing SSH authorization.
        #[arg(long, requires = "stdin", conflicts_with_all = ["local", "address", "port"])]
        client_only: bool,
        /// Address the server can use to reach this machine; default: the request's source IP.
        #[arg(long)]
        address: Option<String>,
        #[arg(long)]
        port: Option<u16>,
        #[arg(long)]
        name: Option<String>,
    },
    /// Share files as scene components through the registered Blind server.
    #[command(
        long_about = "Share files with automatic display selection. PLY/STL/OBJ → mesh, PTS → points, logs/text/ordinary JSON → text, HTML → html, PNG/JPEG/WebP/GIF → image. Use --component INDEX=TYPE to override. All geometry in a group keeps its original relative coordinates. Groups are tiled in one scene; explicit positions use world coordinates.",
        after_help = "EXAMPLES:\n  blind share jaw.ply run.log tracing.json\n  blind share capture.json --component cyclops:trace\n  blind share jaw.ply capture.json --component 2=cyclops:trace\n  blind share --config scene.json\n\nCONFIG:\n  {\"title\":\"Review\",\"resources\":[{\"path\":\"jaw.ply\",\"group\":\"Geometry\"},{\"path\":\"capture.json\",\"component\":\"cyclops:trace\",\"label\":\"Trace\",\"group\":\"Diagnostics\"}]}\n\nResource fields: path, label?, component?, group?, position?: [x,y,z], size?: [width,height]. Paths are relative to the config or oss://ALIAS/BUCKET/KEY. Types: mesh, points, text, html, image or plugin:name. Unknown fields/types fail. Existing groups with 1-based members and --label remain supported. --config owns resources, labels and title; delivery options still apply."
    )]
    Share {
        /// File paths or oss://ALIAS/BUCKET/KEY addresses, in display order.
        #[arg(required_unless_present = "config", conflicts_with = "config")]
        meshes: Vec<PathBuf>,
        /// JSON manifest for a large resource set; relative paths use its directory.
        #[arg(
            long,
            value_name = "FILE",
            conflicts_with_all = ["meshes", "title", "labels"]
        )]
        config: Option<PathBuf>,
        /// Scene title. With --config, put title in the JSON file instead.
        #[arg(long, conflicts_with = "config")]
        title: Option<String>,
        /// Label one Mesh (1=TEXT) or a group (1,2,3=TEXT). Repeat as needed.
        #[arg(
            long = "label",
            value_name = "INDEX[,INDEX...]=TEXT",
            conflicts_with = "config"
        )]
        labels: Vec<String>,
        /// Override automatic display selection (e.g. 2=cyclops:trace); one file also accepts just cyclops:trace.
        #[arg(
            long = "component",
            value_name = "INDEX=TYPE",
            conflicts_with = "config"
        )]
        components: Vec<String>,
        /// Public Blind origin used in generated links (for example https://blind.example.com).
        #[arg(long)]
        host: Option<String>,
        /// Emit a long self-contained /v/ link instead of storing a short-link registry row.
        #[arg(long)]
        stateless: bool,
        /// Link lifetime in whole days; 0 keeps it until its sources become invalid.
        #[arg(long, value_name = "DAYS", default_value_t = crate::scene::DEFAULT_TTL_DAYS)]
        ttl: u32,
        /// Select printed output: viewer URL, image URL, full text, or JSON.
        #[arg(long, value_enum, default_value = "full")]
        format: OutputFormat,
    },
    /// Show local Server, Client connection, target and available plugins.
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

struct ShareOptions {
    host: Option<String>,
    stateless: bool,
    ttl_days: u32,
    format: OutputFormat,
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

/// Return false when this process manages local Server configuration.
pub(crate) async fn list_remote_oss() -> Result<bool> {
    let Some(c) = load()? else {
        return Ok(false);
    };
    if c.source.local {
        return Ok(false);
    }
    let payload = api(&c.server, "/api/v1/client/oss", &c.credential, None).await?;
    let stores: Vec<crate::oss::StoreInfo> = serde_json::from_value(payload["stores"].clone())
        .context("Server does not support OSS discovery")?;
    crate::oss::print_list(&stores, payload["can_share"].as_bool().unwrap_or(false));
    Ok(true)
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
            client_only,
            address,
            port,
            name,
        } => join(stdin, local, client_only, address, port, name).await?,
        ClientCommand::Share {
            meshes,
            config,
            title,
            labels,
            components,
            host,
            stateless,
            ttl,
            format,
        } => {
            share(
                meshes,
                config,
                title,
                labels,
                components,
                ShareOptions {
                    host,
                    stateless,
                    ttl_days: ttl,
                    format,
                },
            )
            .await?
        }
        ClientCommand::Status { json: as_json } => status(as_json).await?,
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
    client_only: bool,
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
        let host_key = if client_only {
            String::new()
        } else {
            sftp_command()?;
            local_host_key()?
        };
        let mut input = String::new();
        use std::io::Read;
        std::io::stdin().take(16_385).read_to_string(&mut input)?;
        let invitation = Invitation::decode(&input)?;
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
    if c.source.local || c.source.client_only {
        Ok(())
    } else {
        edit_authorization(c, false)
    }
}
const MAX_SHARE_CONFIG_BYTES: u64 = 4 * 1024 * 1024;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ShareConfig {
    title: Option<String>,
    resources: Vec<ShareResource>,
    #[serde(default)]
    groups: Vec<ShareGroup>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ShareResource {
    #[serde(default)]
    member: Option<String>,
    path: PathBuf,
    label: Option<String>,
    component: Option<crate::component::ComponentKind>,
    group: Option<String>,
    position: Option<[f32; 3]>,
    size: Option<[f32; 2]>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ShareGroup {
    label: String,
    members: Vec<usize>,
}

#[derive(Debug, PartialEq)]
pub struct ParsedLabels {
    pub meshes: Vec<Option<MeshLabel>>,
    pub groups: Vec<MeshLabelGroup>,
}

struct ShareInput {
    display: Vec<crate::component::DisplayOptions>,
    manifest: Option<crate::plugin::ShareManifest>,
    meshes: Vec<PathBuf>,
    title: Option<String>,
    labels: ParsedLabels,
}

fn read_share_config(path: &Path) -> Result<ShareInput> {
    let config_path = fs::canonicalize(path)
        .with_context(|| format!("cannot resolve share config {}", path.display()))?;
    let metadata = fs::metadata(&config_path)?;
    if !metadata.is_file() {
        bail!("share config {} is not a file", path.display());
    }
    if metadata.len() > MAX_SHARE_CONFIG_BYTES {
        bail!("share config exceeds 4 MiB");
    }
    let value: Value = serde_json::from_slice(&fs::read(&config_path)?)?;
    if value.get("schema_version").is_some() {
        let mut manifest: crate::plugin::ShareManifest = serde_json::from_value(value)?;
        manifest.validate()?;
        for resource in &mut manifest.resources {
            anyhow::ensure!(
                !crate::plugin::is_plugin(&resource.uri),
                "versioned manifests cannot contain plugin URIs"
            );
            if !crate::oss::is_oss(&resource.uri) {
                let path = Path::new(&resource.uri);
                resource.uri = fs::canonicalize(if path.is_absolute() {
                    path.to_owned()
                } else {
                    config_path.parent().unwrap().join(path)
                })?
                .to_string_lossy()
                .into_owned();
            }
        }
        for attachment in &manifest.attachments {
            crate::oss::Location::parse(&attachment.uri)?;
        }
        return Ok(ShareInput {
            display: Vec::new(),
            meshes: manifest
                .resources
                .iter()
                .map(|r| PathBuf::from(&r.uri))
                .collect(),
            title: None,
            labels: ParsedLabels {
                meshes: Vec::new(),
                groups: Vec::new(),
            },
            manifest: Some(manifest),
        });
    }
    let config: ShareConfig = serde_json::from_slice(&fs::read(&config_path)?)
        .with_context(|| format!("invalid share config {}", path.display()))?;
    if config.resources.is_empty() {
        bail!("share config resources must contain at least one item");
    }
    let base = config_path.parent().context("share config has no parent")?;
    let mut meshes = Vec::with_capacity(config.resources.len());
    let mut display = Vec::with_capacity(config.resources.len());
    let mut mesh_labels = Vec::with_capacity(config.resources.len());
    for (index, resource) in config.resources.into_iter().enumerate() {
        let options = crate::component::DisplayOptions {
            component: resource.component,
            member: resource.member,
            group: resource.group,
            position: resource.position,
            size: resource.size,
        };
        options.validate()?;
        display.push(options);
        if resource.path.as_os_str().is_empty() {
            bail!("resources[{}].path must not be empty", index + 1);
        }
        meshes.push(
            if crate::plugin::scheme(&resource.path.to_string_lossy()).is_some()
                || resource.path.is_absolute()
            {
                resource.path
            } else {
                base.join(resource.path)
            },
        );
        let label = resource
            .label
            .map(|text| {
                let label = MeshLabel {
                    text: text.trim().into(),
                    anchor: None,
                };
                label.validate()?;
                Ok::<MeshLabel, anyhow::Error>(label)
            })
            .transpose()
            .with_context(|| format!("invalid resources[{}].label", index + 1))?;
        mesh_labels.push(label);
    }
    let mesh_count = meshes.len();
    let groups = config
        .groups
        .into_iter()
        .enumerate()
        .map(|(group_index, group)| {
            let meshes = group
                .members
                .into_iter()
                .enumerate()
                .map(|(member_index, member)| {
                    member
                        .checked_sub(1)
                        .filter(|index| *index < mesh_count)
                        .with_context(|| {
                            format!(
                                "groups[{}].members[{}] must be between 1 and {mesh_count}",
                                group_index + 1,
                                member_index + 1
                            )
                        })
                })
                .collect::<Result<Vec<_>>>()?;
            let group = MeshLabelGroup {
                text: group.label.trim().into(),
                meshes,
            };
            group
                .validate(mesh_count)
                .with_context(|| format!("invalid groups[{}]", group_index + 1))?;
            Ok(group)
        })
        .collect::<Result<Vec<_>>>()?;
    if groups.len() > crate::scene::MAX_LABEL_GROUPS {
        bail!(
            "share config has too many groups; maximum is {}",
            crate::scene::MAX_LABEL_GROUPS
        );
    }
    Ok(ShareInput {
        display,
        manifest: None,
        meshes,
        title: config.title,
        labels: ParsedLabels {
            meshes: mesh_labels,
            groups,
        },
    })
}

async fn share(
    meshes: Vec<PathBuf>,
    config: Option<PathBuf>,
    title: Option<String>,
    labels: Vec<String>,
    components: Vec<String>,
    options: ShareOptions,
) -> Result<()> {
    let ShareOptions {
        host,
        stateless,
        ttl_days,
        format,
    } = options;
    let config_mode = config.is_some();
    let input = match config {
        Some(path) => read_share_config(&path)?,
        None => {
            let labels = parse_labels(&labels, meshes.len())?;
            let display = parse_components(&components, meshes.len())?;
            ShareInput {
                display,
                manifest: None,
                meshes,
                title,
                labels,
            }
        }
    };
    if input
        .meshes
        .iter()
        .any(|p| crate::plugin::is_plugin(&p.to_string_lossy()))
    {
        anyhow::ensure!(
            input.meshes.len() == 1
                && input.labels.meshes.iter().all(Option::is_none)
                && input.labels.groups.is_empty()
                && input.display.iter().all(|o| o.component.is_none()
                    && o.group.is_none()
                    && o.position.is_none()
                    && o.size.is_none()),
            "a plugin share accepts one URI and no --label overrides"
        );
    }
    if load()?.is_none() {
        join(false, true, false, None, None, None).await?;
    }
    let c = load()?.context("not registered")?;
    let paths = input
        .meshes
        .iter()
        .map(|p| {
            if crate::plugin::is_plugin(&p.to_string_lossy()) {
                return Ok(p.to_string_lossy().into_owned());
            }
            if crate::oss::is_oss(&p.to_string_lossy()) {
                let address = p.to_string_lossy().into_owned();
                crate::oss::Location::parse(&address)?;
                return Ok(address);
            }
            fs::canonicalize(p)
                .with_context(|| format!("cannot resolve {}", p.display()))
                .map(|p| p.to_string_lossy().into_owned())
        })
        .collect::<Result<Vec<_>>>()?;
    if config_mode {
        eprintln!(
            "Blind: registering {} resources from the config; the first share hashes every source once and a multi-gigabyte scene may take several minutes.",
            paths.len()
        );
    }
    let payload=api(&c.server,"/api/v1/client/scenes",&c.credential,Some(json!({"display":input.display,"paths":if input.manifest.is_some(){Vec::<String>::new()}else{paths},"manifest":input.manifest,"title":input.title,"labels":input.labels.meshes,"label_groups":input.labels.groups,"origin":host,"stateless":stateless,"ttl_days":ttl_days}))).await?;
    let confirmed_ttl = payload["ttl_days"].as_u64();
    if confirmed_ttl.is_some_and(|days| days != u64::from(ttl_days))
        || (confirmed_ttl.is_none() && (ttl_days != crate::scene::DEFAULT_TTL_DAYS || stateless))
    {
        bail!(
            "Server did not confirm the requested link lifetime; update the Blind server and retry"
        );
    }
    for warning in payload["warnings"].as_array().into_iter().flatten() {
        if let Some(message) = warning["message"].as_str() {
            eprintln!("Blind: {message}");
        }
    }
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

fn parse_components(
    values: &[String],
    count: usize,
) -> Result<Vec<crate::component::DisplayOptions>> {
    let mut display = vec![crate::component::DisplayOptions::default(); count];
    let mut seen = std::collections::HashSet::new();
    for value in values {
        let (index, kind) = if let Some((index, kind)) = value.split_once('=') {
            (index.parse::<usize>()?, kind)
        } else if count == 1 {
            (1, value.as_str())
        } else {
            bail!("use --component INDEX=TYPE for multiple files");
        };
        anyhow::ensure!(index > 0 && index <= count, "component index out of range");
        anyhow::ensure!(
            seen.insert(index),
            "component specified twice for resource {index}"
        );
        display[index - 1].component = Some(
            serde_json::from_value(serde_json::Value::String(kind.into()))
                .context("component must be mesh, points, text, html, image or plugin:name")?,
        );
    }
    Ok(display)
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

pub(crate) async fn remote_plugins() -> Result<Option<Value>> {
    match load()? {
        Some(c) => Ok(Some(
            api(&c.server, "/api/v1/client/plugins", &c.credential, None).await?,
        )),
        None => Ok(None),
    }
}

pub(crate) async fn status(as_json: bool) -> Result<()> {
    let path = config_path()?;
    let mut local = json!({"state":"unconfigured"});
    let mut local_target = None;
    if path.exists() {
        match fs::read(&path)
            .map_err(anyhow::Error::from)
            .and_then(|b| Ok(serde_json::from_slice::<Config>(&b)?))
        {
            Ok(config) => {
                let probe = tokio::time::timeout(
                    std::time::Duration::from_secs(5),
                    crate::server::probe(&config),
                )
                .await;
                local = match probe {
                    Ok(Ok(Some(health))) => {
                        local_target = Some(format!(
                            "http://{}{}",
                            crate::server::control_address(&config)?,
                            config.base_path().unwrap_or_default()
                        ));
                        json!({"state":"running","pid":health.pid,"version":health.version})
                    }
                    Ok(Ok(None)) => json!({"state":"stopped"}),
                    _ => json!({"state":"probe_failed"}),
                };
            }
            Err(_) => local = json!({"state":"invalid_config"}),
        }
    }
    let mut connection = json!({"state":"not_connected"});
    let mut target = local_target
        .clone()
        .map(|server| json!({"kind":"local","server":server}));
    let mut plugins = json!([]);
    match load() {
        Ok(Some(c)) => {
            target =
                Some(json!({"kind":if c.source.local{"local"}else{"remote"},"server":c.server}));
            let result = tokio::time::timeout(
                std::time::Duration::from_secs(5),
                api(&c.server, "/api/v1/client", &c.credential, None),
            )
            .await;
            let state = match result {
                Ok(Ok(ref v)) if v["active"] == true => "connected",
                Ok(Ok(_)) => "pending",
                Ok(Err(ref e))
                    if e.downcast_ref::<ApiError>()
                        .is_some_and(|e| e.status == reqwest::StatusCode::UNAUTHORIZED) =>
                {
                    if c.source.active {
                        "credential_invalid"
                    } else {
                        "pending"
                    }
                }
                _ => "unreachable",
            };
            connection = json!({"state":state,"server":c.server,"source_id":c.source.id,"name":c.source.name});
            if state == "connected" {
                plugins = match tokio::time::timeout(
                    std::time::Duration::from_secs(5),
                    api(&c.server, "/api/v1/client/plugins", &c.credential, None),
                )
                .await
                {
                    Ok(Ok(v)) => v["plugins"].clone(),
                    _ => json!({"state":"unavailable"}),
                };
            }
        }
        Ok(None) if local_target.is_some() => {
            plugins = crate::plugin::list(path.parent().unwrap())?["plugins"].clone()
        }
        Ok(None) => {}
        Err(_) => connection = json!({"state":"invalid_config"}),
    }
    let report = json!({"schema_version":1,"local_server":local,"connection":connection,"target":target,"plugins":plugins});
    if as_json {
        println!("{}", serde_json::to_string_pretty(&report)?);
    } else {
        println!(
            "Local Server: {}",
            report["local_server"]["state"].as_str().unwrap()
        );
        println!(
            "Client: {}",
            report["connection"]["state"].as_str().unwrap()
        );
        if let Some(target) = report["target"].as_object() {
            println!(
                "Target: {} ({})",
                target["server"].as_str().unwrap(),
                target["kind"].as_str().unwrap()
            );
        } else {
            println!("Target: none");
        }
        if let Some(plugins) = report["plugins"].as_array() {
            for p in plugins {
                println!(
                    "Plugin: {} {} ({})",
                    p["id"].as_str().unwrap_or("?"),
                    p["version"].as_str().unwrap_or(""),
                    p["state"].as_str().unwrap_or("unknown")
                );
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn share_ttl_accepts_whole_days_and_defaults_to_seven() {
        for (args, expected) in [
            (vec!["blind", "share", "mesh.ply"], 7),
            (vec!["blind", "share", "mesh.ply", "--ttl", "0"], 0),
            (
                vec!["blind", "share", "--config", "scene.json", "--ttl", "30"],
                30,
            ),
            (
                vec!["blind", "share", "mesh.ply", "--stateless", "--ttl", "1"],
                1,
            ),
        ] {
            let ClientCommand::Share { ttl, .. } = Cli::try_parse_from(args).unwrap().command
            else {
                panic!("expected share")
            };
            assert_eq!(ttl, expected);
        }
        for invalid in ["-1", "1.5", "days", "4294967296"] {
            assert!(Cli::try_parse_from(["blind", "share", "mesh.ply", "--ttl", invalid]).is_err());
        }
    }

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
    fn share_config_resolves_relative_resources_and_group_members() {
        let directory = tempfile::tempdir().unwrap();
        let config_path = directory.path().join("scene.json");
        fs::write(
            &config_path,
            r#"{
              "title": "Large review",
              "resources": [
                {"path": "meshes/crown.ply", "label": " Crown "},
                {"path": "/data/donor-a.ply"},
                {"path": "meshes/donor-b.ply"}
              ],
              "groups": [{"label": " References ", "members": [2, 3]}]
            }"#,
        )
        .unwrap();
        let input = read_share_config(&config_path).unwrap();
        assert_eq!(input.title.as_deref(), Some("Large review"));
        assert_eq!(
            input.meshes[0],
            fs::canonicalize(directory.path())
                .unwrap()
                .join("meshes/crown.ply")
        );
        assert_eq!(input.meshes[1], PathBuf::from("/data/donor-a.ply"));
        assert_eq!(input.labels.meshes[0].as_ref().unwrap().text, "Crown");
        assert_eq!(input.labels.groups[0].text, "References");
        assert_eq!(input.labels.groups[0].meshes, [1, 2]);
    }

    #[test]
    fn share_config_rejects_unknown_fields_and_invalid_groups() {
        let directory = tempfile::tempdir().unwrap();
        let config_path = directory.path().join("scene.json");
        fs::write(
            &config_path,
            r#"{"resources":[{"path":"a.ply","typo":"ignored"}]}"#,
        )
        .unwrap();
        assert!(read_share_config(&config_path).is_err());
        fs::write(
            &config_path,
            r#"{"resources":[{"path":"a.ply"},{"path":"b.ply"}],"groups":[{"label":"bad","members":[1,1]}]}"#,
        )
        .unwrap();
        assert!(read_share_config(&config_path).is_err());
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
