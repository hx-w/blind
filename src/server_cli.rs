use crate::{config, registry, render, server, service, update};
use std::time::Duration;

use crate::config::{Config, config_path, normalize_origin, repair_config_permissions};
use crate::lod::LodCacheStats;
use crate::network::discover;
use crate::registry::Registry;
use crate::server::{ControlHealth, DoctorAction, DoctorRegistryReport};
use anyhow::{Context, Result};
use clap::Subcommand;

#[derive(Subcommand)]
pub enum Command {
    /// Issue or revoke permanent reusable invitations.
    Invite {
        #[arg(long)]
        host: Option<String>,
        #[arg(long, conflicts_with = "host", help = "Revoke every issued invitation")]
        revoke_all: bool,
    },
    /// List registered OS-user sources or revoke one source.
    Sources {
        #[arg(long)]
        revoke: Option<String>,
    },
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
    #[command(about = "List every detected Host origin and mark the primary one")]
    Hosts {
        #[arg(long)]
        json: bool,
    },
    #[command(
        name = "server-status",
        about = "Report whether the local server is running"
    )]
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
pub enum ServiceCommand {
    #[command(about = "Install and start Blind as a per-user launchd service")]
    Install,
    #[command(about = "Stop and remove the per-user launchd service")]
    Uninstall,
    #[command(about = "Report whether the launchd service is installed")]
    Status,
}

pub async fn run(command: Command) -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "blind=info,tower_http=info".into()),
        )
        .init();
    match command {
        Command::Invite { host, revoke_all } => {
            let sources = crate::source::Sources::open(
                config_path()?.parent().context("config parent missing")?,
            )?;
            if revoke_all {
                println!("revoked {} invitation(s)", sources.revoke_invitations()?);
                return Ok(());
            }
            let (config, _) = Config::load_or_create()?;
            let origin = host
                .or(config.preferred_origin.clone())
                .or_else(|| {
                    discover(config.port().ok()?, None, config.base_path().as_deref())
                        .ok()?
                        .first()
                        .map(|h| h.origin.clone())
                })
                .context("no server origin")?;
            let origin = config.normalize_share_origin(&origin)?;
            println!("{}", sources.invite(origin)?.encode()?);
        }
        Command::Sources { revoke } => {
            let sources = crate::source::Sources::open(
                config_path()?.parent().context("config parent missing")?,
            )?;
            if let Some(id) = revoke {
                sources.revoke(&id)?;
            }
            println!("{}", serde_json::to_string_pretty(&sources.list()?)?);
        }
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
                for host in discover(
                    port,
                    config.preferred_origin.as_deref(),
                    config.base_path().as_deref(),
                )? {
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
    for host in discover(
        config.port()?,
        config.preferred_origin.as_deref(),
        config.base_path().as_deref(),
    )? {
        println!("Host: {}", host.origin);
    }
    Ok(())
}

fn hosts(json: bool) -> Result<()> {
    let (config, _) = Config::load_or_create()?;
    let hosts = discover(
        config.port()?,
        config.preferred_origin.as_deref(),
        config.base_path().as_deref(),
    )?;
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
    let hosts = discover(
        config.port()?,
        config.preferred_origin.as_deref(),
        config.base_path().as_deref(),
    )?;
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
                        (DoctorRegistryReport::cleared(removed), false, true)
                    }
                    Err(error) if clear_all && registry::is_key_mismatch(&error) => {
                        let removed = Registry::clear_without_key()?;
                        let registry = Registry::open(&config)?;
                        registry.repair()?;
                        (DoctorRegistryReport::cleared(removed), false, false)
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
    println!("    unavailable   {}", report.unavailable);
    println!("    tombstoned    {}", report.tombstoned);
    println!("    corrupt       {}", report.corrupt);
    for line in lod_cache_lines(report.lod_cache.as_ref(), through_server) {
        println!("{line}");
    }
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

fn lod_cache_lines(stats: Option<&LodCacheStats>, through_server: bool) -> Vec<String> {
    let Some(stats) = stats else {
        return vec![if through_server {
            "--  lod     cache statistics unavailable from running server".into()
        } else {
            "ok  lod     cache inactive (server not running)".into()
        }];
    };
    let noun = if stats.entries == 1 {
        "entry"
    } else {
        "entries"
    };
    let mut lines = vec![format!(
        "ok  lod     {} {noun}, {} / {} resident",
        stats.entries,
        format_bytes(stats.resident_bytes),
        format_bytes(stats.capacity_bytes)
    )];
    if stats.entries > 0 {
        let comparison = if stats.raw_bytes >= stats.resident_bytes {
            let saved = stats.raw_bytes - stats.resident_bytes;
            let percent = if stats.raw_bytes == 0 {
                0
            } else {
                (saved as f64 / stats.raw_bytes as f64 * 100.0).round() as u64
            };
            format!("{} saved, {percent}%", format_bytes(saved))
        } else {
            format!(
                "{} larger",
                format_bytes(stats.resident_bytes - stats.raw_bytes)
            )
        };
        lines.push(format!(
            "    payload       {} Raw -> {} LOD ({comparison})",
            format_bytes(stats.raw_bytes),
            format_bytes(stats.resident_bytes)
        ));
        if stats.source_triangles > 0 {
            lines.push(format!(
                "    triangles     {} source -> {} LOD",
                stats.source_triangles, stats.lod_triangles
            ));
        }
        if stats.source_points > 0 {
            lines.push(format!(
                "    points        {} source -> {} LOD",
                stats.source_points, stats.lod_points
            ));
        }
    }
    lines
}

fn format_bytes(bytes: usize) -> String {
    const KIB: usize = 1024;
    const MIB: usize = 1024 * KIB;
    if bytes >= MIB {
        format!("{:.1} MiB", bytes as f64 / MIB as f64)
    } else if bytes >= KIB {
        format!("{:.1} KiB", bytes as f64 / KIB as f64)
    } else {
        format!("{bytes} B")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn doctor_lod_cache_lines_report_usage_and_savings() {
        let stats = LodCacheStats {
            entries: 2,
            resident_bytes: 3 * 1024 * 1024,
            capacity_bytes: 256 * 1024 * 1024,
            raw_bytes: 12 * 1024 * 1024,
            source_triangles: 1_200_000,
            lod_triangles: 100_000,
            source_points: 300_000,
            lod_points: 50_000,
        };
        assert_eq!(
            lod_cache_lines(Some(&stats), true),
            vec![
                "ok  lod     2 entries, 3.0 MiB / 256.0 MiB resident",
                "    payload       12.0 MiB Raw -> 3.0 MiB LOD (9.0 MiB saved, 75%)",
                "    triangles     1200000 source -> 100000 LOD",
                "    points        300000 source -> 50000 LOD",
            ]
        );
    }

    #[test]
    fn doctor_lod_cache_lines_distinguish_offline_and_legacy_server() {
        assert_eq!(
            lod_cache_lines(None, false),
            vec!["ok  lod     cache inactive (server not running)"]
        );
        assert_eq!(
            lod_cache_lines(None, true),
            vec!["--  lod     cache statistics unavailable from running server"]
        );
    }

    #[test]
    fn doctor_lod_cache_lines_report_point_clouds_without_empty_triangle_line() {
        let stats = LodCacheStats {
            entries: 1,
            resident_bytes: 12,
            capacity_bytes: 256 * 1024 * 1024,
            raw_bytes: 24,
            source_triangles: 0,
            lod_triangles: 0,
            source_points: 4_000,
            lod_points: 2_000,
        };
        let lines = lod_cache_lines(Some(&stats), true);
        assert!(
            lines
                .iter()
                .any(|line| line.contains("4000 source -> 2000 LOD"))
        );
        assert!(lines.iter().all(|line| !line.contains("triangles")));
    }
}
