//! Plugin administration commands and interactive configuration.
use crate::{
    plugin::{
        Manifest, install_package as install, installed, installed_path, list, lock_admin,
        properties, read_json, root, settings, settings_path, validate_binding, validate_config,
    },
    runtime::files::{private_dir, write_private},
};
use anyhow::{Context, Result, ensure};
use clap::Subcommand;
use serde_json::json;
use std::{
    fs,
    io::{self, Write},
    path::{Path, PathBuf},
};

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

fn install_package(dir: &Path, directory: &Path) -> Result<()> {
    let id = install(dir, directory)?;
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
                crate::plugin::update::validate_repository(repo)?;
                let id = repo.rsplit('/').next().unwrap();
                let token = update_token(&dir, id, repo, token_stdin)?;
                let current = installed(&dir, id).ok();
                let version = current.as_ref().map(|i| i.manifest.version.as_str());
                if let Some(package) =
                    crate::plugin::update::fetch_package(repo, id, version, token.as_deref())
                        .await?
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
            let package = crate::plugin::update::fetch_package(
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
                    for store in crate::storage::oss::list(&dir)? {
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
                        && let Some(bucket) = crate::storage::oss::list(&dir)?
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
