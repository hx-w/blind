//! Server-only, one-shot share resolvers. Public scenes contain ordinary sources.
use crate::{
    config::config_path,
    source::{private_dir, write_private},
};
use anyhow::{Context, Result, bail, ensure};
use clap::Subcommand;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::HashSet,
    fs,
    io::{self, Write},
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const LIMIT: usize = 4 * 1024 * 1024;
pub const FEATURES: &[&str] = &["layout.panels", "attachments"];

#[derive(Subcommand)]
pub enum Command {
    /// Install a local plugin package on this machine's Server; repeat to upgrade.
    Install {
        /// Local package directory or github:OWNER/REPO.
        directory: PathBuf,
        /// Read and retain a private-release download token from stdin.
        #[arg(long)]
        token_stdin: bool,
    },
    /// Update an installed plugin from its declared GitHub stable release.
    Update {
        id: String,
        #[arg(long)]
        token_stdin: bool,
    },
    /// Configure this machine's installed plugin. Secrets never use argv.
    Configure {
        id: String,
        #[arg(long = "set")]
        values: Vec<String>,
        #[arg(long)]
        secret_stdin: Option<String>,
    },
    /// Show this machine's plugin settings with secrets redacted.
    Config { id: String },
    /// Discover plugins on the connected Server, or locally when unregistered.
    List,
    /// Unregister this machine's plugin; retain configuration and existing scenes.
    Remove {
        id: String,
        /// Also discard plugin settings, for an explicitly requested clean reinstall.
        #[arg(long)]
        purge_config: bool,
    },
}

#[derive(Clone, Serialize, Deserialize)]
pub struct Manifest {
    pub id: String,
    pub name: String,
    pub version: String,
    #[serde(default)]
    pub description: String,
    pub schemes: Vec<String>,
    pub protocol_versions: Vec<u32>,
    pub entrypoint: Vec<String>,
    pub files: Vec<String>,
    pub config_schema: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub update: Option<UpdateSource>,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct UpdateSource {
    pub repository: String,
}
#[derive(Serialize, Deserialize)]
struct Installed {
    directory: PathBuf,
    executable: PathBuf,
    manifest: Manifest,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Resource {
    pub id: String,
    pub uri: String,
    pub label: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Panel {
    pub id: String,
    pub label: String,
    pub members: Vec<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Warning {
    pub code: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resource_id: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ShareManifest {
    pub schema_version: u32,
    #[serde(default)]
    pub requires: Vec<String>,
    pub title: Option<String>,
    pub resources: Vec<Resource>,
    #[serde(default)]
    pub panels: Vec<Panel>,
    #[serde(default)]
    pub attachments: Vec<Resource>,
    #[serde(default)]
    pub warnings: Vec<Warning>,
}

pub fn scheme(input: &str) -> Option<&str> {
    let (scheme, _) = input.split_once("://")?;
    (!scheme.is_empty()
        && scheme.bytes().enumerate().all(|(i, c)| {
            c.is_ascii_lowercase()
                || (i > 0 && (c.is_ascii_digit() || matches!(c, b'+' | b'-' | b'.')))
        }))
    .then_some(scheme)
}
pub fn is_plugin(input: &str) -> bool {
    scheme(input).is_some_and(|s| s != "oss")
}
fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-' || c == b'_')
}
fn root() -> Result<PathBuf> {
    Ok(config_path()?
        .parent()
        .context("missing config directory")?
        .to_owned())
}
fn installed_path(dir: &Path, id: &str) -> Result<PathBuf> {
    ensure!(valid_id(id), "invalid plugin ID");
    Ok(dir.join("plugins").join(id).join("current.json"))
}
fn settings_path(dir: &Path, id: &str) -> Result<PathBuf> {
    ensure!(valid_id(id), "invalid plugin ID");
    Ok(dir.join("plugin-config").join(format!("{id}.json")))
}
fn read_json(path: &Path) -> Result<Value> {
    let bytes = fs::read(path)?;
    ensure!(bytes.len() <= LIMIT, "configuration exceeds 4 MiB");
    Ok(serde_json::from_slice(&bytes)?)
}
fn installed(dir: &Path, id: &str) -> Result<Installed> {
    serde_json::from_value(read_json(&installed_path(dir, id)?)?)
        .context("invalid plugin installation")
}
fn settings(dir: &Path, m: &Manifest) -> Result<Value> {
    let path = settings_path(dir, &m.id)?;
    let mut v = if path.exists() {
        read_json(&path)?
    } else {
        json!({})
    };
    ensure!(v.is_object(), "plugin config must be an object");
    for (k, p) in properties(m)? {
        if v.get(k).is_none()
            && let Some(default) = p.get("default")
        {
            v[k] = default.clone();
        }
    }
    Ok(v)
}
fn properties(m: &Manifest) -> Result<&serde_json::Map<String, Value>> {
    m.config_schema["properties"]
        .as_object()
        .context("config_schema.properties must be an object")
}
fn validate_config(m: &Manifest, v: &Value) -> Result<()> {
    let props = properties(m)?;
    for (key, value) in v.as_object().context("config must be an object")? {
        let p = props
            .get(key)
            .with_context(|| format!("unknown config field: {key}"))?;
        let valid = match p["type"].as_str() {
            Some("string") => value.is_string(),
            Some("integer") => value.is_i64() || value.is_u64(),
            Some("number") => value.is_number(),
            Some("boolean") => value.is_boolean(),
            _ => false,
        };
        ensure!(valid, "invalid type for config field: {key}");
        if let Some(options) = p.get("enum").and_then(Value::as_array) {
            ensure!(
                options.contains(value),
                "invalid choice for config field: {key}"
            );
        }
    }
    for required in m.config_schema["required"].as_array().into_iter().flatten() {
        let key = required
            .as_str()
            .context("required fields must be strings")?;
        ensure!(
            v.get(key)
                .is_some_and(|x| !x.is_null() && x.as_str() != Some("")),
            "missing config field: {key}"
        );
    }
    Ok(())
}
fn validate_binding(dir: &Path, v: &Value) -> Result<()> {
    if let Some(alias) = v.get("oss_alias") {
        let alias = alias.as_str().context("oss_alias must be a string")?;
        let bucket = v["bucket"]
            .as_str()
            .context("bucket is required with oss_alias")?;
        crate::oss::Location::parse(&format!("oss://{alias}/{bucket}/check"))?;
        let store = crate::oss::list(dir)?
            .into_iter()
            .find(|s| s.alias == alias)
            .context("configured OSS alias does not exist on this Server")?;
        ensure!(
            store.bucket.as_deref().is_none_or(|b| b == bucket),
            "bucket differs from OSS alias binding"
        );
    }
    Ok(())
}
fn validate_manifest(m: &Manifest) -> Result<()> {
    ensure!(valid_id(&m.id), "invalid plugin ID");
    if let Some(update) = &m.update {
        crate::plugin_update::validate_repository(&update.repository)?;
    }
    ensure!(
        !m.name.is_empty() && !m.version.is_empty(),
        "name and version are required"
    );
    ensure!(
        m.protocol_versions.contains(&1),
        "plugin has no compatible protocol (Host supports 1)"
    );
    ensure!(
        !m.schemes.is_empty() && !m.entrypoint.is_empty(),
        "schemes and entrypoint are required"
    );
    let mut seen = HashSet::new();
    for s in &m.schemes {
        ensure!(
            scheme(&format!("{s}://x")) == Some(s.as_str())
                && !["oss", "http", "https", "file"].contains(&s.as_str())
                && seen.insert(s),
            "invalid, reserved or repeated plugin scheme"
        );
    }
    ensure!(
        m.config_schema["type"] == "object" && m.config_schema["additionalProperties"] == false,
        "config schema must be a closed object"
    );
    for key in m
        .config_schema
        .as_object()
        .context("invalid schema")?
        .keys()
    {
        ensure!(
            [
                "type",
                "additionalProperties",
                "properties",
                "required",
                "description",
                "title",
                "$schema"
            ]
            .contains(&key.as_str()),
            "unsupported config schema keyword: {key}"
        );
    }
    let props = properties(m)?;
    for p in props.values() {
        ensure!(
            ["string", "integer", "number", "boolean"].contains(&p["type"].as_str().unwrap_or("")),
            "config supports scalar properties only"
        );
        for key in p.as_object().context("invalid property schema")?.keys() {
            ensure!(
                [
                    "type",
                    "default",
                    "description",
                    "title",
                    "writeOnly",
                    "enum"
                ]
                .contains(&key.as_str()),
                "unsupported config property keyword: {key}"
            );
        }
        if p["writeOnly"] == true {
            ensure!(
                p["type"] == "string" && p.get("default").is_none(),
                "secrets must be strings without defaults"
            );
        }
    }
    for k in m.config_schema["required"]
        .as_array()
        .context("required must be an array")?
    {
        ensure!(
            k.as_str().is_some_and(|k| props.contains_key(k)),
            "unknown required property"
        );
    }
    Ok(())
}

pub fn list(dir: &Path) -> Result<Value> {
    let mut result = Vec::new();
    let path = dir.join("plugins");
    if !path.exists() {
        return Ok(json!({"plugins":result}));
    }
    for entry in fs::read_dir(path)? {
        let entry = entry?;
        let id = entry.file_name().to_string_lossy().into_owned();
        if !entry.path().join("current.json").exists() {
            continue;
        }
        match installed(dir, &id) {
            Ok(i) => {
                let ready = settings(dir, &i.manifest)
                    .and_then(|v| {
                        validate_config(&i.manifest, &v)?;
                        validate_binding(dir, &v)
                    })
                    .is_ok();
                result.push(json!({"id":id,"name":i.manifest.name,"version":i.manifest.version,"description":i.manifest.description,"schemes":i.manifest.schemes,"state":if ready{"configured"}else{"unconfigured"}}));
            }
            Err(_) => result.push(json!({"id":id,"state":"invalid"})),
        }
    }
    result.sort_by_key(|v| v["id"].as_str().unwrap_or("").to_owned());
    Ok(json!({"plugins":result}))
}
fn executable(command: &str, package: &Path) -> Result<PathBuf> {
    let path = Path::new(command);
    let resolved = if path.is_absolute() {
        path.to_owned()
    } else if command.contains('/') {
        package.join(path)
    } else {
        std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())
            .map(|p| p.join(command))
            .find(|p| p.is_file())
            .with_context(|| {
                format!("runtime {command} not found; install it on the Server first")
            })?
    };
    let resolved = fs::canonicalize(resolved)?;
    ensure!(
        resolved.is_file(),
        "plugin entrypoint must be a regular file"
    );
    #[cfg(unix)]
    if !resolved.starts_with(package) {
        use std::os::unix::fs::PermissionsExt;
        ensure!(
            fs::metadata(&resolved)?.permissions().mode() & 0o111 != 0,
            "plugin runtime is not executable"
        );
    }
    Ok(resolved)
}
fn install_package(dir: &Path, directory: &Path) -> Result<()> {
    let package = fs::canonicalize(directory)?;
    let m: Manifest = serde_json::from_value(read_json(&package.join("blind-plugin.json"))?)?;
    validate_manifest(&m)?;
    for p in list(dir)?["plugins"]
        .as_array()
        .context("invalid plugin list")?
    {
        if p["id"] != m.id {
            for s in &m.schemes {
                ensure!(
                    !p["schemes"]
                        .as_array()
                        .is_some_and(|v| v.contains(&json!(s))),
                    "scheme {s} is already registered"
                );
            }
        }
    }
    let mut files = Vec::new();
    let mut hash_input = serde_json::to_vec(&m)?;
    for file in &m.files {
        let relative = Path::new(file);
        ensure!(
            !relative.is_absolute()
                && relative
                    .components()
                    .all(|p| matches!(p, std::path::Component::Normal(_))),
            "package paths must be relative without traversal"
        );
        let canonical = fs::canonicalize(package.join(relative))?;
        ensure!(
            canonical.starts_with(&package) && canonical.is_file(),
            "package file escapes package"
        );
        let bytes = fs::read(canonical)?;
        ensure!(bytes.len() <= 64 * 1024 * 1024, "plugin file too large");
        hash_input.extend_from_slice(file.as_bytes());
        hash_input.extend_from_slice(&bytes);
        files.push((file, bytes));
    }
    let runtime = executable(&m.entrypoint[0], &package)?;
    let config = settings(dir, &m)?;
    if settings_path(dir, &m.id)?.exists() {
        validate_config(&m, &config)?;
        validate_binding(dir, &config)?;
    }
    let hash = crate::scene::hash_bytes(&hash_input);
    let destination = dir.join("plugins").join(&m.id).join("versions").join(hash);
    if !destination.exists() {
        let versions = destination.parent().unwrap();
        private_dir(versions)?;
        let staging = tempfile::tempdir_in(versions)?;
        for (name, bytes) in &files {
            let target = staging.path().join(name);
            write_private(&target, bytes)?;
        }
        write_private(
            &staging.path().join("blind-plugin.json"),
            &serde_json::to_vec_pretty(&m)?,
        )?;
        fs::rename(staging.path(), &destination)?;
    }
    for (name, bytes) in &files {
        ensure!(
            fs::read(destination.join(name))? == *bytes,
            "installed package integrity check failed"
        );
    }
    let runtime = if runtime.starts_with(&package) {
        let relative = runtime.strip_prefix(&package)?;
        ensure!(
            m.files.iter().any(|f| Path::new(f) == relative),
            "packaged executable must appear in files"
        );
        let target = destination.join(relative);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&target, fs::Permissions::from_mode(0o700))?;
        }
        target
    } else {
        runtime
    };
    let id = m.id.clone();
    let receipt = Installed {
        directory: destination,
        executable: runtime,
        manifest: m,
    };
    private_dir(installed_path(dir, &id)?.parent().unwrap())?;
    write_private(
        &installed_path(dir, &id)?,
        &serde_json::to_vec_pretty(&receipt)?,
    )?;
    println!("Installed {id}. Configure with: blind plugin configure {id}");
    Ok(())
}
fn update_token(
    dir: &Path,
    id: &str,
    repository: &str,
    from_stdin: bool,
) -> Result<Option<String>> {
    if from_stdin {
        use std::io::Read;
        let mut token = String::new();
        io::stdin().take(8193).read_to_string(&mut token)?;
        let token = token.trim().to_owned();
        ensure!(
            !token.is_empty() && token.len() <= 8192 && !token.chars().any(char::is_control),
            "invalid release token"
        );
        return Ok(Some(token));
    }
    let path = installed_path(dir, id)?.with_file_name("update-auth.json");
    if !path.exists() {
        return Ok(None);
    }
    let auth = read_json(&path)?;
    ensure!(
        auth["repository"] == repository,
        "update repository changed; supply a new token with --token-stdin"
    );
    Ok(auth["token"].as_str().map(str::to_owned))
}
fn save_update_token(dir: &Path, id: &str, repository: &str, token: Option<&str>) -> Result<()> {
    if let Some(token) = token {
        let path = installed_path(dir, id)?.with_file_name("update-auth.json");
        write_private(
            &path,
            &serde_json::to_vec(&json!({"repository":repository,"token":token}))?,
        )?;
    }
    Ok(())
}
fn lock_admin(dir: &Path) -> Result<fs::File> {
    private_dir(dir)?;
    let path = dir.join("plugins.lock");
    let mut options = fs::OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let file = options.open(path)?;
    #[cfg(unix)]
    {
        use std::os::fd::AsRawFd;
        ensure!(
            unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0,
            "another plugin administration command is running; retry after it finishes"
        );
    }
    Ok(file)
}
pub async fn run(command: Command) -> Result<()> {
    let dir = root()?;
    // Serialize administrative mutations across processes, including the whole
    // download/validate/publish sequence. Resolve calls retain immutable versions.
    let _lock = if matches!(&command, Command::List) {
        None
    } else {
        Some(lock_admin(&dir)?)
    };
    match command {
        Command::List => {
            if let Some(v) = crate::client::remote_plugins().await? {
                println!("{}", serde_json::to_string_pretty(&v)?);
            } else {
                println!("{}", serde_json::to_string_pretty(&list(&dir)?)?);
            }
        }
        Command::Install {
            directory,
            token_stdin,
        } => {
            eprintln!("Local Server configuration: {}", dir.display());
            let source = directory.to_string_lossy();
            if let Some(repo) = source.strip_prefix("github:") {
                crate::plugin_update::validate_repository(repo)?;
                let id = repo.rsplit('/').next().unwrap();
                let token = update_token(&dir, id, repo, token_stdin)?;
                let current = installed(&dir, id).ok();
                let version = current.as_ref().map(|i| i.manifest.version.as_str());
                if let Some(package) =
                    crate::plugin_update::fetch_package(repo, id, version, token.as_deref()).await?
                {
                    install_package(&dir, package.path())?;
                } else {
                    println!("{id} is up to date.");
                }
                save_update_token(&dir, id, repo, token.as_deref())?;
            } else {
                let m: Manifest =
                    serde_json::from_value(read_json(&directory.join("blind-plugin.json"))?)?;
                let token = if token_stdin {
                    let repo = &m
                        .update
                        .as_ref()
                        .context("package has no update repository")?
                        .repository;
                    update_token(&dir, &m.id, repo, true)?
                } else {
                    None
                };
                install_package(&dir, &directory)?;
                if let Some(source) = &m.update {
                    save_update_token(&dir, &m.id, &source.repository, token.as_deref())?;
                }
            }
        }
        Command::Update { id, token_stdin } => {
            eprintln!("Local Server configuration: {}", dir.display());
            let current = installed(&dir, &id)?;
            let repo = &current
                .manifest
                .update
                .as_ref()
                .context("plugin has no GitHub update source; reinstall a local package")?
                .repository;
            let token = update_token(&dir, &id, repo, token_stdin)?;
            let package = crate::plugin_update::fetch_package(
                repo,
                &id,
                Some(&current.manifest.version),
                token.as_deref(),
            )
            .await?;
            if let Some(package) = package {
                install_package(&dir, package.path())?;
            } else {
                println!("{id} {} is up to date.", current.manifest.version);
            }
            save_update_token(&dir, &id, repo, token.as_deref())?;
        }
        Command::Configure {
            id,
            values,
            secret_stdin,
        } => {
            eprintln!("Local Server configuration: {}", dir.display());
            let i = installed(&dir, &id)?;
            let mut v = settings(&dir, &i.manifest)?;
            let props = properties(&i.manifest)?;
            let interactive = values.is_empty() && secret_stdin.is_none();
            for pair in values {
                let (k, val) = pair.split_once('=').context("--set requires KEY=VALUE")?;
                let p = props.get(k).context("unknown config field")?;
                ensure!(
                    p["writeOnly"] != true,
                    "secrets must use --secret-stdin or interactive input"
                );
                v[k] = if p["type"] == "string" {
                    json!(val)
                } else {
                    serde_json::from_str(val).context("invalid scalar value")?
                };
            }
            if let Some(key) = secret_stdin {
                ensure!(
                    props.get(&key).is_some_and(|p| p["writeOnly"] == true),
                    "field is not a declared secret"
                );
                use std::io::Read;
                let mut input = String::new();
                io::stdin().take(65537).read_to_string(&mut input)?;
                ensure!(input.len() <= 65536, "secret too large");
                v[&key] = json!(input.trim_end_matches(['\r', '\n']));
            }
            if interactive {
                if props.contains_key("oss_alias") {
                    eprintln!("Available OSS aliases:");
                    for store in crate::oss::list(&dir)? {
                        eprintln!("  {} {}", store.alias, store.bucket.unwrap_or_default());
                    }
                }
                let mut keys: Vec<_> = props.keys().collect();
                keys.sort_by_key(|k| match k.as_str() {
                    "oss_alias" => 0,
                    "bucket" => 1,
                    _ => 2,
                });
                for key in keys {
                    let p = &props[key];
                    if key == "bucket"
                        && let Some(alias) = v["oss_alias"].as_str()
                        && let Some(bucket) = crate::oss::list(&dir)?
                            .into_iter()
                            .find(|s| s.alias == alias)
                            .and_then(|s| s.bucket)
                    {
                        v[key] = json!(bucket);
                        eprintln!("bucket: {} (bound by OSS alias)", v[key]);
                        continue;
                    }
                    let secret = p["writeOnly"] == true;
                    let default = if secret {
                        if v.get(key).is_some() {
                            "[set]".to_owned()
                        } else {
                            String::new()
                        }
                    } else {
                        v.get(key)
                            .map(|v| {
                                v.as_str()
                                    .map(str::to_owned)
                                    .unwrap_or_else(|| v.to_string())
                            })
                            .unwrap_or_default()
                    };
                    let input = if secret {
                        rpassword::prompt_password(format!("{key} [{default}]: "))?
                    } else {
                        eprint!("{key} [{default}]: ");
                        io::stderr().flush()?;
                        let mut s = String::new();
                        io::stdin().read_line(&mut s)?;
                        s.trim_end().to_owned()
                    };
                    if !input.is_empty() {
                        v[key] = if p["type"] == "string" {
                            json!(input)
                        } else {
                            serde_json::from_str(&input)?
                        };
                    }
                }
            }
            validate_config(&i.manifest, &v)?;
            validate_binding(&dir, &v)?;
            private_dir(&dir.join("plugin-config"))?;
            write_private(&settings_path(&dir, &id)?, &serde_json::to_vec_pretty(&v)?)?;
            println!("Configured {id}; upstream access is checked when sharing.");
        }
        Command::Config { id } => {
            let i = installed(&dir, &id)?;
            let mut v = settings(&dir, &i.manifest)?;
            for (k, p) in properties(&i.manifest)? {
                if p["writeOnly"] == true {
                    v[k] = json!(if v.get(k).is_some() {
                        "[set]"
                    } else {
                        "[unset]"
                    });
                }
            }
            println!("{}", serde_json::to_string_pretty(&v)?);
        }
        Command::Remove { id, purge_config } => {
            eprintln!("Local Server configuration: {}", dir.display());
            fs::remove_file(installed_path(&dir, &id)?)?;
            if purge_config {
                let config = settings_path(&dir, &id)?;
                if config.exists() {
                    fs::remove_file(config)?;
                }
                println!(
                    "Removed {id} and its configuration; installed versions and existing scenes retained."
                );
            } else {
                println!(
                    "Removed {id}; configuration, installed versions and existing scenes retained."
                );
            }
        }
    }
    Ok(())
}

impl ShareManifest {
    pub fn validate(&self) -> Result<()> {
        ensure!(
            self.schema_version == 1,
            "unsupported share manifest version"
        );
        ensure!(
            self.requires.iter().all(|r| FEATURES.contains(&r.as_str())),
            "unsupported required share capability"
        );
        ensure!(
            self.panels.is_empty() || self.requires.iter().any(|s| s == "layout.panels"),
            "panels require layout.panels capability"
        );
        ensure!(
            self.attachments.is_empty() || self.requires.iter().any(|s| s == "attachments"),
            "attachments require attachments capability"
        );
        ensure!(
            !self.resources.is_empty()
                && self.resources.len() <= 4096
                && self.attachments.len() <= 4096
                && self.panels.len() <= 64,
            "share manifest exceeds resource/panel limits"
        );
        ensure!(
            self.panels.iter().map(|p| p.members.len()).sum::<usize>() <= 4096,
            "share manifest exceeds expanded mesh instance limit"
        );
        let mut ids = HashSet::new();
        for r in self.resources.iter().chain(&self.attachments) {
            ensure!(
                !r.id.is_empty() && r.id.len() <= 128 && ids.insert(&r.id),
                "empty or duplicate resource ID"
            );
            ensure!(!r.uri.is_empty(), "empty resource URI");
            if let Some(label) = &r.label {
                crate::scene::MeshLabel {
                    text: label.clone(),
                    anchor: None,
                }
                .validate()?;
            }
        }
        let resources: HashSet<_> = self.resources.iter().map(|r| &r.id).collect();
        let mut panels = HashSet::new();
        let mut used = HashSet::new();
        for p in &self.panels {
            ensure!(
                !p.id.is_empty() && panels.insert(&p.id) && !p.members.is_empty(),
                "invalid or duplicate panel"
            );
            crate::scene::MeshLabel {
                text: p.label.clone(),
                anchor: None,
            }
            .validate()?;
            let mut members = HashSet::new();
            for r in &p.members {
                ensure!(
                    resources.contains(r) && members.insert(r),
                    "invalid or repeated panel member"
                );
                used.insert(r);
            }
        }
        ensure!(
            self.panels.is_empty() || used == resources,
            "panels must cover every geometry resource"
        );
        Ok(())
    }
}

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
    let request = json!({"jsonrpc":"2.0","id":"resolve","method":"resolve","params":{"protocol_version":1,"input":input,"config":config,"context":{"server_version":env!("CARGO_PKG_VERSION"),"capabilities":FEATURES,"deadline":crate::source::now()+60}}});
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
        let message = match code {
            "ORDER_NOT_FOUND" => "ORDER_NOT_FOUND: order does not exist",
            "UPSTREAM_AUTH_FAILED" => "UPSTREAM_AUTH_FAILED: order API rejected plugin credentials",
            "INVALID_INPUT" => "INVALID_INPUT: invalid order URL or UUID",
            "NO_GEOMETRY" => {
                "NO_GEOMETRY: order has no referenced geometry yet; retry after artifacts are generated"
            }
            "ORDER_FAILED_NO_GEOMETRY" => {
                "ORDER_FAILED_NO_GEOMETRY: order failed and has no geometry to display; inspect the order logs"
            }
            "UPSTREAM_RATE_LIMITED" => "UPSTREAM_RATE_LIMITED: order API rate limited; retry later",
            "INVALID_CONFIG" => "INVALID_CONFIG: check the Server plugin configuration",
            "INVALID_MANIFEST" => {
                "INVALID_MANIFEST: order API returned an invalid artifact manifest"
            }
            "LIMIT_EXCEEDED" => "LIMIT_EXCEEDED: order manifest exceeds supported limits",
            "UPSTREAM_UNAVAILABLE" => "UPSTREAM_UNAVAILABLE: order API unavailable",
            _ => "PLUGIN_ERROR: resolver failed",
        };
        bail!("{message}");
    }
    let plan: ShareManifest =
        serde_json::from_value(response["result"].clone()).context("invalid share manifest")?;
    plan.validate()?;
    for r in plan.resources.iter().chain(&plan.attachments) {
        let loc =
            crate::oss::Location::parse(&r.uri).context("plugins may only return OSS resources")?;
        if config.get("oss_alias").is_some() {
            ensure!(
                config["oss_alias"] == loc.alias && config["bucket"] == loc.bucket,
                "plugin returned an OSS resource outside its configured binding"
            );
        }
    }
    Ok(plan)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn entrypoint_and_administration_boundaries() {
        let dir = tempfile::tempdir().unwrap();
        assert!(executable(dir.path().to_str().unwrap(), dir.path()).is_err());
        let lock = lock_admin(dir.path()).unwrap();
        assert!(lock_admin(dir.path()).is_err());
        drop(lock);
        assert!(lock_admin(dir.path()).is_ok());
    }
    #[test]
    fn panel_expansion_has_a_scene_wide_limit() {
        let resources: Vec<_> = (0..100)
            .map(|i| Resource {
                id: format!("r{i}"),
                uri: "oss://x/b/a.ply".into(),
                label: None,
            })
            .collect();
        let panels: Vec<_> = (0..42)
            .map(|i| Panel {
                id: format!("p{i}"),
                label: "Panel".into(),
                members: resources.iter().map(|r| r.id.clone()).collect(),
            })
            .collect();
        let mut plan = ShareManifest {
            schema_version: 1,
            requires: vec!["layout.panels".into()],
            title: None,
            resources,
            panels,
            attachments: vec![],
            warnings: vec![],
        };
        assert!(plan.validate().is_err());
        plan.panels.truncate(40);
        plan.validate().unwrap();
    }
    #[test]
    fn nested_url_and_capability_compatibility() {
        assert_eq!(
            scheme("example://https://example.test/a?b=c"),
            Some("example")
        );
        assert!(!is_plugin("oss://team/bucket/a.ply"));
        let value = json!({"schema_version":1,"resources":[{"id":"a","uri":"oss://team/bucket/a.ply"}],"future_optional":{"a":1}});
        let mut plan: ShareManifest = serde_json::from_value(value).unwrap();
        plan.validate().unwrap();
        plan.requires.push("future.layout".into());
        assert!(plan.validate().is_err());
        plan.requires = vec!["layout.panels".into()];
        plan.panels.push(Panel {
            id: "p".into(),
            label: "Pair".into(),
            members: vec!["a".into(), "missing".into()],
        });
        assert!(plan.validate().is_err());
    }
    #[test]
    fn layout_cannot_silently_omit_or_duplicate_members() {
        let mut plan:ShareManifest=serde_json::from_value(json!({"schema_version":1,"requires":["layout.panels"],"resources":[{"id":"a","uri":"oss://x/b/a.ply"},{"id":"b","uri":"oss://x/b/b.ply"}],"panels":[{"id":"p","label":"Panel","members":["a"]}]})).unwrap();
        assert!(plan.validate().is_err());
        plan.panels[0].members.push("b".into());
        plan.validate().unwrap();
        plan.panels[0].members.push("b".into());
        assert!(plan.validate().is_err());
    }
}
