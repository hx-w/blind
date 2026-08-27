mod config;
mod mesh;
mod network;
mod render;
mod scene;
mod server;
mod service;
mod token;

use std::path::PathBuf;

use anyhow::{Context, Result};
use clap::{Parser, Subcommand, ValueEnum};
use config::{Config, config_path, normalize_origin};
use network::discover;
use scene::SceneDescriptor;
use serde::Serialize;
use server::{ControlHealth, ShareLinks, links_for};
use token::TokenCodec;

#[derive(Parser)]
#[command(
    name = "blind",
    version,
    about = "Serve local PLY, STL, and OBJ Meshes for instant 3D review",
    long_about = "Blind runs one local Mesh-review server and creates stateless review links.\n\nAgent workflow:\n  1. Start once:  blind serve\n  2. Share Meshes: blind share crown.ply prep.stl --format json\n  3. Use owner_url to review and public viewer_url/image_url to share.\n  4. Stop manually: blind stop\n\nRunning `blind serve` again is safe. It exits successfully when a Blind server is already running. Source files remain on the host; deleting or changing any source invalidates both the viewer and image links. Host addresses are discovered automatically, and `--host` selects a specific origin when needed.",
    after_help = "Examples:\n  blind serve\n  blind share upper.ply lower.ply --format json\n  blind share model.obj --format view\n  blind hosts\n  blind status\n  blind stop"
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
        about = "Create stateless viewer and image links for one or more Meshes",
        long_about = "Create one scene from local PLY, STL, or OBJ files. Blind stores no Mesh copy and no scene record. The encrypted links carry camera and style state while the source paths stay on this host. Any source deletion or content change makes the entire scene return HTTP 410.\n\nUse `--format json` for agents. It includes viewer_url, image_url, owner_url, every detected Host candidate, canonical source paths, and SHA-256 revisions. Use owner_url for your own review because it enables the Complete information share option without exposing that permission in public links."
    )]
    Share {
        #[arg(
            required = true,
            help = "Local .ply, .stl, or .obj paths in the same scene"
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
    #[command(about = "Check configuration, Host discovery, and image rendering")]
    Doctor,
    #[command(about = "Manage the encryption key used by all scene links")]
    Key {
        #[command(subcommand)]
        command: KeyCommand,
    },
    #[command(about = "Install or remove the macOS background service")]
    Service {
        #[command(subcommand)]
        command: ServiceCommand,
    },
}

#[derive(Subcommand)]
enum KeyCommand {
    #[command(about = "Rotate the scene key and invalidate every existing link")]
    Rotate,
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
            format,
        } => share(meshes, title, host, format).await?,
        Command::Hosts { json } => hosts(json)?,
        Command::Status { json } => status(json).await?,
        Command::Doctor => doctor().await?,
        Command::Key {
            command: KeyCommand::Rotate,
        } => {
            let (mut config, _) = Config::load_or_create()?;
            config.rotate_key()?;
            println!("Rotated the scene key. Existing links are now invalid.");
        }
        Command::Service { command } => match command {
            ServiceCommand::Install => {
                let (config, _) = Config::load_or_create()?;
                let _ = server::stop(&config).await?;
                println!("Installed {}", service::install()?.display());
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
    let links = links_for(
        &TokenCodec::new(config.secret_bytes()?),
        &scene,
        &origin,
        true,
    )?;
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

async fn doctor() -> Result<()> {
    let (config, _) = Config::load_or_create()?;
    println!("ok  config  {}", config_path()?.display());
    println!("ok  listen  {}", config.listen);
    let hosts = discover(config.port()?, config.preferred_origin.as_deref())?;
    println!("ok  hosts   {} detected", hosts.len());
    render::Renderer::new()
        .await
        .context("image renderer is unavailable")?;
    println!("ok  render  graphics adapter ready");
    Ok(())
}
