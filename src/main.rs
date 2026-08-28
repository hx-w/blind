mod config;
mod mesh;
mod network;
mod registry;
mod render;
mod scene;
mod server;
mod service;
mod token;
mod update;

use std::{path::PathBuf, time::Duration};

use anyhow::{Context, Result};
use clap::{Parser, Subcommand, ValueEnum};
use config::{Config, config_path, normalize_origin, repair_config_permissions};
use network::discover;
use registry::Registry;
use scene::SceneDescriptor;
use serde::Serialize;
use server::{
    ControlHealth, DoctorAction, DoctorRegistryReport, ShareLinks, links_for, stateless_links_for,
};
use token::TokenCodec;

#[derive(Parser)]
#[command(
    name = "blind",
    version,
    about = "Serve local PLY, STL, OBJ, and PTS geometry for instant 3D review",
    long_about = "Blind runs one local Mesh-review server and creates short-lived review links.\n\nAgent workflow:\n  1. Start once:  blind serve\n  2. Share Meshes: blind share crown.ply prep.stl --format json\n  3. Use owner_url to review and public viewer_url/image_url to share.\n  4. Stop manually: blind stop\n\nRunning `blind serve` again is safe. It exits successfully when a Blind server is already running. Source files remain on the host; deleting or changing any source invalidates both the viewer and image links. Host addresses are discovered automatically, and `--host` selects a specific origin when needed.",
    after_help = "Examples:\n  blind serve\n  blind share upper.ply lower.ply --format json\n  blind share jaw.ply margin.pts --format view\n  blind hosts\n  blind status\n  blind stop"
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    #[command(
        about = "Create configuration, PAT, and scene key",
        long_about = "Create Blind's per-user configuration if it does not exist. Initialization is optional because other commands initialize on first use. Use `--host` only when one discovered address should always be preferred. The PAT protects the control API and is never placed in a share URL."
    )]
    Init {
        #[arg(long, help = "Prefer this HTTP(S) origin when creating links")]
        host: Option<String>,
        #[arg(long, help = "Print the existing PAT")]
        show_pat: bool,
    },
    #[command(
        about = "Run the foreground server, or succeed if it is already running",
        long_about = "Run Blind in the foreground. Blind verifies the configured port through an authenticated control handshake. If the same server is already running, this command prints its PID and exits successfully, so agents may call it idempotently. A different or incompatible service on the port is reported explicitly. Press Ctrl-C or run `blind stop` from another terminal to stop a manually started server."
    )]
    Serve {
        #[arg(
            long,
            help = "Set and persist the listen address, for example 0.0.0.0:7400"
        )]
        listen: Option<String>,
    },
    #[command(
        about = "Stop the manually running server",
        long_about = "Stop the Blind server through its authenticated local control endpoint. This command also succeeds when the server is already stopped. A service installed with `blind service install` may be restarted by the service manager; use `blind service uninstall` to remove that managed service."
    )]
    Stop,
    #[command(
        about = "Create short viewer and image links for one or more Meshes",
        long_about = "Create one scene from local PLY, STL, OBJ, or Denta PTS files. PTS ordered rings render as a continuous tube with one sphere at every source point. By default Blind stores only an encrypted scene record in its bounded local registry and returns a six-character /s/ link valid for seven days. It never copies or caches source geometry or rendered images. Use `--stateless` only when a long self-contained link is preferred. Any source deletion or content change makes the entire scene return HTTP 410.\n\nUse `--format json` for agents. It includes viewer_url, image_url, owner_url, every detected Host candidate, canonical source paths, and SHA-256 revisions. Use owner_url for your own review because it enables the Complete information share option without exposing that permission in public links."
    )]
    Share {
        #[arg(
            required = true,
            help = "Local .ply, .stl, .obj, or .pts paths in the same scene"
        )]
        meshes: Vec<PathBuf>,
        #[arg(long, help = "Scene title shown above the viewer")]
        title: Option<String>,
        #[arg(
            long,
            help = "Use this HTTP(S) origin instead of the primary discovered Host"
        )]
        host: Option<String>,
        #[arg(
            long,
            help = "Create a long self-contained link without writing the scene registry"
        )]
        stateless: bool,
        #[arg(
            long,
            value_enum,
            default_value = "full",
            help = "Output one view URL, one image URL, complete text, or agent JSON"
        )]
        format: OutputFormat,
    },
    #[command(about = "List every detected Host origin and mark the primary one")]
    Hosts {
        #[arg(long)]
        json: bool,
    },
    #[command(about = "Report whether the local server is running")]
    Status {
        #[arg(long)]
        json: bool,
    },
    #[command(
        about = "Audit and repair configuration, storage, links, and image rendering",
        long_about = "Check Blind's configuration, Host discovery, SQLite integrity, every stored short link, and image rendering. Safe configuration and SQLite maintenance is applied automatically without stopping a running server. Link validity includes expiry, payload decryption, and current source revisions."
    )]
    Doctor {
        #[arg(
            long,
            conflicts_with = "clear_all",
            help = "Delete expired, tombstoned, corrupt, and source-invalid short links"
        )]
        clean_invalid: bool,
        #[arg(
            long,
            conflicts_with = "clean_invalid",
            help = "Delete every stored short link"
        )]
        clear_all: bool,
    },
    #[command(
        about = "Update Blind to the latest verified GitHub release",
        long_about = "Download the latest Blind release for this Mac, verify its SHA-256 checksum and archive contents, and atomically replace the current executable. Blind never uses sudo. If a managed background service is installed, it is reconciled with the new binary."
    )]
    Update,
    #[command(about = "Install or remove the macOS background service")]
    Service {
        #[command(subcommand)]
        command: ServiceCommand,
    },
}

#[derive(Subcommand)]
enum ServiceCommand {
    #[command(about = "Install and start Blind as a per-user launchd service")]
    Install,
    #[command(about = "Stop and remove the per-user launchd service")]
    Uninstall,
    #[command(about = "Report whether the launchd service is installed")]
    Status,
}

#[derive(Clone, Copy, ValueEnum)]
enum OutputFormat {
    View,
    Image,
    Full,
    Json,
}

#[derive(Serialize)]
struct CliShareOutput {
    #[serde(flatten)]
    links: ShareLinks,
    hosts: Vec<network::HostCandidate>,
    resources: Vec<ResourceOutput>,
}

#[derive(Serialize)]
struct ResourceOutput {
    path: String,
    revision: String,
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "blind=info,tower_http=info".into()),
        )
        .init();
    let cli = Cli::parse();
    match cli.command {
        Command::Init { host, show_pat } => init(host, show_pat)?,
        Command::Serve { listen } => {
            let (mut config, created) = Config::load_or_create()?;
            if created {
                eprintln!("Created {}", config_path()?.display());
            }
            if let Some(listen) = listen {
                listen
                    .parse::<std::net::SocketAddr>()
                    .context("--listen must be a socket address such as 0.0.0.0:7400")?;
                config.listen = listen;
                config.save()?;
            }
            if let Some(health) = server::probe(&config).await? {
                report_running(&health);
            } else {
                let port = config.port()?;
                eprintln!("Available hosts:");
                for host in discover(port, config.preferred_origin.as_deref())? {
                    eprintln!("  {}", host.origin);
                }
                let retry_config = config.clone();
                if let Err(error) = server::serve(config).await {
                    match server::probe(&retry_config).await? {
                        Some(health) => report_running(&health),
                        None => return Err(error),
                    }
                }
            }
        }
        Command::Stop => {
            let (config, _) = Config::load_or_create()?;
            println!("{}", server::stop(&config).await?);
        }
        Command::Share {
            meshes,
            title,
            host,
            stateless,
            format,
        } => share(meshes, title, host, stateless, format).await?,
        Command::Hosts { json } => hosts(json)?,
        Command::Status { json } => status(json).await?,
        Command::Doctor {
            clean_invalid,
            clear_all,
        } => doctor(clean_invalid, clear_all).await?,
        Command::Update => update_blind().await?,
        Command::Service { command } => match command {
            ServiceCommand::Install => {
                service::validate_user()?;
                let (config, _) = Config::load_or_create()?;
                let was_loaded = service::is_loaded()?;
                // Prepare and lint before unloading. KeepAlive must be unloaded
                // before requesting shutdown or launchd can race the reinstall.
                let prepared = service::prepare_install()?;
                service::unload()?;
                if let Err(stop_error) = server::stop(&config).await {
                    let restore_error = if was_loaded {
                        service::load_existing().err()
                    } else {
                        None
                    };
                    if let Some(restore_error) = restore_error {
                        anyhow::bail!(
                            "could not stop Blind: {stop_error:#}; restoring the previous service also failed: {restore_error:#}"
                        );
                    }
                    return Err(stop_error);
                }
                let committed = prepared.commit()?;
                if let Err(health_error) = server::wait_until_ready(
                    &config,
                    Some(env!("CARGO_PKG_VERSION")),
                    Duration::from_secs(30),
                )
                .await
                {
                    if let Some(rollback_error) = committed.rollback().err() {
                        anyhow::bail!(
                            "Blind service did not become healthy: {health_error:#}; restoring the previous service also failed: {rollback_error:#}"
                        );
                    }
                    return Err(health_error)
                        .context("Blind service did not become healthy and was rolled back");
                }
                let plist = committed.finish();
                println!("Installed {}", plist.display());
            }
            ServiceCommand::Uninstall => println!("Removed {}", service::uninstall()?.display()),
            ServiceCommand::Status => println!(
                "{}",
                if service::is_installed()? {
                    "installed"
                } else {
                    "not installed"
                }
            ),
        },
    }
    Ok(())
}

async fn update_blind() -> Result<()> {
    update::validate_user()?;
    let installation = service::installation()?;
    let service_is_loaded =
        !matches!(installation, service::Installation::None) && service::is_loaded()?;
    let service_was_loaded =
        matches!(installation, service::Installation::CurrentExecutable) && service_is_loaded;
    let (config, _) = Config::load_or_create()?;
    let running = server::probe(&config).await?;
    if running.is_some()
        && !service_was_loaded
        && !(matches!(installation, service::Installation::OtherExecutable(_)) && service_is_loaded)
    {
        anyhow::bail!(
            "Blind is running outside the managed background service; run `blind stop` before `blind update`"
        );
    }

    eprintln!("Checking for Blind updates...");
    let prepared = match update::prepare()? {
        update::PrepareOutcome::Unchanged { current, latest } => {
            report_no_update(&current, &latest);
            report_other_service(&installation);
            return Ok(());
        }
        update::PrepareOutcome::Ready(prepared) => prepared,
    };

    let committed = match prepared.commit() {
        Ok(update::CommitOutcome::Unchanged { current, latest }) => {
            report_no_update(&current, &latest);
            report_other_service(&installation);
            return Ok(());
        }
        Ok(update::CommitOutcome::Updated(committed)) => committed,
        Err(update_error) => {
            return Err(update_error).context("could not install the Blind update");
        }
    };

    let from = committed.previous_version().to_owned();
    let to = committed.to_version().to_owned();
    if service_was_loaded
        && let Err(start_error) = restart_existing_service(&config, Some(&to)).await
    {
        let rollback_error = committed.rollback().err();
        let restore_error = if rollback_error.is_none() {
            restart_existing_service(&config, None).await.err()
        } else {
            None
        };
        match (rollback_error, restore_error) {
            (Some(rollback_error), _) => anyhow::bail!(
                "Blind {to} did not become healthy: {start_error:#}; restoring {from} also failed: {rollback_error:#}"
            ),
            (None, Some(restore_error)) => anyhow::bail!(
                "Blind {to} did not become healthy and was rolled back to {from}, but the previous service did not restart: {restore_error:#}"
            ),
            (None, None) => anyhow::bail!(
                "Blind {to} did not become healthy and was rolled back to {from}: {start_error:#}"
            ),
        }
    }

    let (from, to, path) = committed.finish()?;
    println!("Updated Blind from {from} to {to} at {}.", path.display());
    if service_was_loaded {
        println!("Restarted and verified the Blind background service.");
    }
    report_other_service(&installation);
    Ok(())
}

async fn restart_existing_service(config: &Config, expected_version: Option<&str>) -> Result<()> {
    service::restart()?;
    server::wait_until_ready(config, expected_version, Duration::from_secs(30)).await?;
    Ok(())
}

fn report_no_update(current: &str, latest: &str) {
    if current == latest {
        println!("Blind is already up to date ({current}).");
    } else {
        println!(
            "This Blind build ({current}) is newer than the latest release ({latest}); no update was performed."
        );
    }
}

fn report_other_service(installation: &service::Installation) {
    if let service::Installation::OtherExecutable(path) = installation {
        eprintln!(
            "The background service uses {} and was left unchanged.",
            path.display()
        );
    }
}

fn report_running(health: &ControlHealth) {
    println!(
        "Blind server is already running (PID {}). Skip this command or run `blind stop` first.",
        health.pid
    );
}

fn init(host: Option<String>, show_pat: bool) -> Result<()> {
    let (mut config, created) = Config::load_or_create()?;
    if let Some(host) = host {
        config.preferred_origin = Some(normalize_origin(&host)?);
        config.save()?;
    }
    println!("Config: {}", config_path()?.display());
    println!("Listen: {}", config.listen);
    if created || show_pat {
        println!("PAT: {}", config.pat);
    }
    for host in discover(config.port()?, config.preferred_origin.as_deref())? {
        println!("Host: {}", host.origin);
    }
    Ok(())
}

async fn share(
    meshes: Vec<PathBuf>,
    title: Option<String>,
    host: Option<String>,
    stateless: bool,
    format: OutputFormat,
) -> Result<()> {
    let (config, _) = Config::load_or_create()?;
    if server::probe(&config).await?.is_none() {
        anyhow::bail!("Blind server is not running; run `blind serve` first");
    }
    let scene = SceneDescriptor::create(&meshes, title).await?;
    let hosts = discover(config.port()?, config.preferred_origin.as_deref())?;
    let origin = match host {
        Some(host) => normalize_origin(&host)?,
        None => hosts
            .first()
            .context("no usable Host found")?
            .origin
            .clone(),
    };
    let links = if stateless {
        stateless_links_for(
            &TokenCodec::new(config.secret_bytes()?),
            &scene,
            &origin,
            true,
        )?
    } else {
        links_for(&Registry::open(&config)?, &scene, &origin, true)?
    };
    match format {
        OutputFormat::View => println!("{}", links.viewer_url),
        OutputFormat::Image => println!("{}", links.image_url),
        OutputFormat::Full => println!("{}", links.full_text.as_deref().unwrap_or_default()),
        OutputFormat::Json => {
            let output = CliShareOutput {
                links,
                hosts,
                resources: scene
                    .meshes
                    .iter()
                    .map(|mesh| ResourceOutput {
                        path: mesh.path.clone(),
                        revision: mesh.revision.clone(),
                    })
                    .collect(),
            };
            println!("{}", serde_json::to_string_pretty(&output)?);
        }
    }
    Ok(())
}

fn hosts(json: bool) -> Result<()> {
    let (config, _) = Config::load_or_create()?;
    let hosts = discover(config.port()?, config.preferred_origin.as_deref())?;
    if json {
        println!("{}", serde_json::to_string_pretty(&hosts)?);
    } else {
        for host in hosts {
            println!(
                "{}\t{}\t{}",
                if host.primary { "*" } else { " " },
                host.scope,
                host.origin
            );
        }
    }
    Ok(())
}

async fn status(json: bool) -> Result<()> {
    let (config, _) = Config::load_or_create()?;
    let port = config.port()?;
    let health = server::probe(&config).await?;
    let online = health.is_some();
    let pid = health.map(|health| health.pid);
    if json {
        println!(
            "{}",
            serde_json::json!({ "status": if online { "running" } else { "stopped" }, "pid": pid, "configured_port": port })
        );
    } else {
        println!(
            "{} on port {port}",
            if online { "running" } else { "stopped" }
        );
    }
    Ok(())
}

async fn doctor(clean_invalid: bool, clear_all: bool) -> Result<()> {
    let (mut config, _) = Config::load_or_create()?;
    let permissions_repaired = repair_config_permissions()?;
    println!(
        "ok  config  {}{}",
        config_path()?.display(),
        if permissions_repaired {
            " (permissions repaired)"
        } else {
            ""
        }
    );
    println!("ok  listen  {}", config.listen);
    let hosts = discover(config.port()?, config.preferred_origin.as_deref())?;
    println!("ok  hosts   {} detected", hosts.len());
    let action = if clean_invalid {
        DoctorAction::CleanInvalid
    } else if clear_all {
        DoctorAction::ClearAll
    } else {
        DoctorAction::Audit
    };
    let (report, through_server, repaired_secret) =
        match server::doctor_registry(&config, action).await? {
            Some(report) => (report, true, false),
            None => {
                let _lease = server::acquire_offline_maintenance_lease()?;
                match Registry::open(&config) {
                    Err(error) if clear_all && config.secret_bytes().is_err() => {
                        let removed = Registry::clear_without_key().with_context(|| {
                            format!("could not clear registry after invalid scene key: {error:#}")
                        })?;
                        config.repair_invalid_secret()?;
                        let registry = Registry::open(&config)?;
                        registry.repair()?;
                        (
                            DoctorRegistryReport {
                                valid: 0,
                                expired: 0,
                                source_gone: 0,
                                tombstoned: 0,
                                corrupt: removed,
                                removed,
                                preserved: 0,
                                key_repaired: false,
                            },
                            false,
                            true,
                        )
                    }
                    Err(error) if clear_all && registry::is_key_mismatch(&error) => {
                        let removed = Registry::clear_without_key()?;
                        let registry = Registry::open(&config)?;
                        registry.repair()?;
                        (
                            DoctorRegistryReport {
                                valid: 0,
                                expired: 0,
                                source_gone: 0,
                                tombstoned: 0,
                                corrupt: removed,
                                removed,
                                preserved: 0,
                                key_repaired: false,
                            },
                            false,
                            false,
                        )
                    }
                    Err(error) => return Err(error),
                    Ok(registry) => {
                        registry.repair()?;
                        let audit = registry.audit().await?;
                        let removed = match action {
                            DoctorAction::Audit => 0,
                            DoctorAction::CleanInvalid => registry.clean_invalid(&audit).await?,
                            DoctorAction::ClearAll => registry.clear()?,
                        };
                        (DoctorRegistryReport::new(&audit, removed), false, false)
                    }
                }
            }
        };
    println!(
        "ok  sqlite  integrity, schema, index, WAL, and permissions ready at {}{}",
        config::registry_path()?.display(),
        if through_server { " (live server)" } else { "" }
    );
    println!(
        "ok  links   {} valid, {} invalid, {} total",
        report.valid,
        report.invalid(),
        report.total()
    );
    println!("    valid         {}", report.valid);
    println!("    expired       {}", report.expired);
    println!("    source gone   {}", report.source_gone);
    println!("    tombstoned    {}", report.tombstoned);
    println!("    corrupt       {}", report.corrupt);
    if report.key_repaired {
        println!("ok  config  restored the running server's internal scene key");
    } else if repaired_secret {
        println!("ok  config  regenerated an invalid internal scene key");
    }
    if clean_invalid {
        println!("ok  clean   removed {} invalid links", report.removed);
        if report.preserved > 0 {
            println!(
                "ok  clean   preserved {} links that changed during the audit",
                report.preserved
            );
        }
    } else if clear_all {
        println!("ok  clear   removed {} links", report.removed);
    }
    render::Renderer::new()
        .await
        .context("image renderer is unavailable")?;
    println!("ok  render  graphics adapter ready");
    Ok(())
}
