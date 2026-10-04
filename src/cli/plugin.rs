//! Plugin administration and read-only private environment inspection.
use crate::{
    plugin::{
        environment, environment_path, install_package as install, installed, installed_path, list,
        lock_admin, read_json, read_manifest, root,
    },
    runtime::files::write_private,
};
use anyhow::{Context, Result, ensure};
use clap::Subcommand;
use serde_json::json;
use std::{
    fs, io,
    path::{Path, PathBuf},
};

#[derive(Subcommand)]
pub enum Command {
    /// Install a local plugin package on this machine; repeat to upgrade.
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
    /// Show this machine's plugin settings with secrets redacted.
    Config { id: String },
    /// List local and connected Server installations, with their origins.
    List,
    /// Unregister this machine's plugin; retain configuration and existing scenes.
    Remove {
        id: String,
        /// Also discard the private .env file for a clean reinstall.
        #[arg(long)]
        purge_config: bool,
    },
}

fn install_package(dir: &Path, directory: &Path) -> Result<()> {
    let id = install(dir, directory)?;
    println!("Installed {id}.");
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
    let _lock = if matches!(&command, Command::List | Command::Config { .. }) {
        None
    } else {
        Some(lock_admin(&dir)?)
    };
    match command {
        Command::List => {
            let mut catalog = list(&dir)?;
            let plugins = catalog["plugins"]
                .as_array_mut()
                .context("invalid local plugin catalog")?;
            for plugin in plugins.iter_mut() {
                plugin["source"] = json!("local");
            }
            let remote = crate::client::remote_plugins().await.and_then(|remote| {
                if let Some(catalog) = &remote {
                    ensure!(
                        catalog["plugins"].is_array(),
                        "invalid Server plugin catalog"
                    );
                }
                Ok(remote)
            });
            let remote_error = match remote {
                Ok(Some(remote)) => {
                    for mut plugin in remote["plugins"]
                        .as_array()
                        .context("invalid Server plugin catalog")?
                        .iter()
                        .cloned()
                    {
                        plugin["source"] = json!("server");
                        plugins.push(plugin);
                    }
                    catalog["server"] = json!({"state":"connected"});
                    None
                }
                Ok(None) => {
                    catalog["server"] = json!({"state":"unconnected"});
                    None
                }
                Err(error) => {
                    catalog["server"] = json!({"state":"error","error":error.to_string()});
                    Some(error)
                }
            };
            println!("{}", serde_json::to_string_pretty(&catalog)?);
            if let Some(error) = remote_error {
                return Err(error.context("could not load connected Server plugin catalog"));
            }
        }
        Command::Install {
            directory,
            token_stdin,
        } => {
            eprintln!("Local plugin configuration: {}", dir.display());
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
                let m = read_manifest(&directory)?;
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
            eprintln!("Local plugin configuration: {}", dir.display());
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
        Command::Config { id } => {
            let i = installed(&dir, &id)?;
            let values = environment(&dir, &i.manifest)?;
            let mut v = serde_json::to_value(&values)?;
            for (key, field) in &i.manifest.env {
                if field.secret {
                    v[key] = json!(if values.contains_key(key) {
                        "[set]"
                    } else {
                        "[unset]"
                    });
                }
            }
            println!("{}", serde_json::to_string_pretty(&v)?);
        }
        Command::Remove { id, purge_config } => {
            eprintln!("Local plugin configuration: {}", dir.display());
            fs::remove_file(installed_path(&dir, &id)?)?;
            if purge_config {
                let config = environment_path(&dir, &id)?;
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
