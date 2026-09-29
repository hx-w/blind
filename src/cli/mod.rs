//! Command parsing, terminal interaction, and application orchestration.
mod discovery;
mod oss;
mod plugin;
mod registration;
mod server;
mod share;
mod status;

use crate::client;
use anyhow::Result;
use clap::{Parser, Subcommand, ValueEnum};
use share::{ShareOptions, share};
use std::path::PathBuf;

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
    /// Share files or directories as scene components through the registered Blind server.
    #[command(
        long_about = "Share files or local directories with automatic display selection. Directories include supported files in the current level; add --recursive for subdirectories. Hidden entries and symbolic links inside directories are skipped. Each directory is sorted by path; duplicate paths are removed before assigning label/component indices. At most 256 resources form one scene. PLY/STL/OBJ → mesh, PTS → points, logs/text → text, Markdown → markdown, ordinary JSON → json, HTML → html, PNG/JPEG/WebP/GIF → image. Use --component INDEX=TYPE to override. All geometry in a group keeps its original relative coordinates. Groups are tiled in one scene; explicit positions use world coordinates.",
        after_help = "EXAMPLES:\n  blind share ./\n  blind share ./results --recursive --format json\n  blind share jaw.ply run.log tracing.json\n  blind share capture.json --component cyclops:trace\n  blind share jaw.ply capture.json --component 2=cyclops:trace\n  blind share --config scene.json\n  blind share --config collection.json --format json\n  generate_collection | blind share --config - --format json\n\nCONFIG:\n  {\"title\":\"Review\",\"resources\":[{\"path\":\"jaw.ply\",\"group\":\"Geometry\"},{\"path\":\"capture.json\",\"component\":\"cyclops:trace\",\"label\":\"Trace\",\"group\":\"Diagnostics\"}]}\n  {\"kind\":\"collection\",\"schema_version\":1,\"title\":\"Case review\",\"active_scene_id\":\"design\",\"scenes\":[{\"id\":\"design\",\"title\":\"Design\",\"resources\":[{\"path\":\"crown.ply\"}]},{\"id\":\"scan\",\"title\":\"Scan\",\"resources\":[{\"path\":\"scan.ply\"}]}]}\n\nResource fields: path, label?, component?, group?, position?: [x,y,z], size?: [width,height]. Paths are relative to the config, or cwd for --config -, or oss://ALIAS/BUCKET/KEY. Types: mesh, points, text, markdown, json, html, image or plugin:name. Collection children accept resources/groups or one plugin uri. Unknown fields/types fail. Existing groups with 1-based members and --label remain supported. --config owns resources, labels and title; delivery options still apply."
    )]
    Share {
        /// Files, local directories, or oss://ALIAS/BUCKET/KEY addresses, in display order.
        #[arg(required_unless_present = "config", conflicts_with = "config")]
        meshes: Vec<PathBuf>,
        /// Include subdirectories; directory scans skip hidden entries and symbolic links.
        #[arg(long, conflicts_with = "config")]
        recursive: bool,
        /// JSON scene or collection manifest; use - for stdin (paths relative to cwd).
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
    Server(crate::cli::server::Command),
}
#[derive(Clone, Copy, ValueEnum)]
enum OutputFormat {
    View,
    Image,
    Full,
    Json,
}

pub async fn run() -> Result<()> {
    match Cli::parse().command {
        ClientCommand::Server(command) => crate::cli::server::run(command).await?,
        ClientCommand::Join {
            stdin,
            local,
            client_only,
            address,
            port,
            name,
        } => registration::join(stdin, local, client_only, address, port, name).await?,
        ClientCommand::Share {
            meshes,
            recursive,
            config,
            title,
            labels,
            components,
            host,
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
                    recursive,
                    host,
                    ttl_days: ttl,
                    format,
                },
            )
            .await?
        }
        ClientCommand::Status { json: as_json } => status::run(as_json).await?,
        ClientCommand::Leave => {
            client::leave().await?;
            println!("Registration revoked; other SSH keys and users were preserved.");
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
}
