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

const SHARE_HELP: &str = r#"CHOOSING AN INPUT
  Files/directories: one scene, one camera, one world-space layout.
  Scene config: explicit resources, labels, groups, positions and surface sizes.
  Collection config: 2 to 16 independent scenes, each with its own camera and
  review state. The viewer can split panes, expand one scene, or switch via tabs.
  Prefer the scene/collection formats below for agent-generated plans.

EXAMPLES
  blind share ./results --recursive --format json
  blind share jaw.ply review.md report.json architecture.mmd --format json
  blind share --config scene.json --format json
  blind share --config collection.json --ttl 0 --format json
  blind share --config - --format json < collection.json
  blind share capture.json --component cyclops:trace --format json
  blind share jaw.ply capture.json --component 2=cyclops:trace --format json

SCENE CONFIG
{
  "title": "Model and review documents",
  "resources": [
    {"path": "jaw.ply"},
    {"path": "reference.ply"},
    {"path": "review.md", "label": "Review", "group": "Documents",
     "position": [140, 0, 0], "size": [120, 90]},
    {"path": "bundle.zip", "member": "reports/report.json",
     "component": "json", "group": "Diagnostics"}
  ],
  "groups": [{"label": "Reference geometry", "members": [1, 2]}]
}

RESOURCE FIELDS
  Scene fields: resources is required; title, groups and viewport are optional.
  Omit kind and schema_version for this basic scene format.
  viewport   Optional {"mode":"auto"|"board"|"spatial","board":{"center":[x,y],"scale":n}}.
             Default mode auto selects a real 2D board for coplanar surface-only
             world scenes, otherwise spatial. Board scale is CSS px/world unit,
             finite and positive; center is finite. Explicit board rejects world
             geometry, spatial plugins and noncoplanar world surfaces.
  path       Required file path or oss://ALIAS/BUCKET/KEY. Config resources are
             explicit files, not directory scans.
  label      Optional display name, 1 to 120 nonblank characters.
  component  Optional mesh|points|text|markdown|json|html|image|mermaid|dot or
             PLUGIN:NAME. Omit to infer from the filename or ZIP member name.
  member     Optional exact ZIP member path, e.g. reports/report.json. Use "/",
             no absolute paths, empty segments, "." or ".."; no recursive unpack.
             The extracted member is limited to 64 MiB.
  group      Optional flat display group, 1 to 120 nonblank characters.
  placement  Optional world|panel, default world. Panel pins a surface to the
             fixed screen-space sidebar, outside world layout/Fit. Not geometry.
  position   Optional [x,y,z] absolute world coordinates, not screen pixels.
             Each number must be finite with absolute value <= 1000000.
  size       Optional [width,height] in world units for surfaces, not geometry.
             Default [110,70]; each value must be finite and between 1 and 10000.
  Unpositioned resources are tiled in stable flat groups. Geometry in a group
  keeps its source-relative alignment. Explicit positions bypass automatic tiling.
  groups is optional: at most 64 {"label":STRING,"members":[INDEX,...]} entries.
  Members are 1-based resource indices within that scene, at least two distinct
  valid indices per group. Each resource belongs to at most one flat group;
  groups entries cannot overlap or conflict with resource.group. Repeat a source
  resource to create another instance in a different group.
  Use resource.group for ordinary flat grouping.

COLLECTION CONFIG
{
  "kind": "collection",
  "schema_version": 1,
  "title": "Review collection",
  "active_scene_id": "model",
  "scenes": [
    {"id": "model", "title": "Model",
     "resources": [{"path": "jaw.ply"}, {"path": "review.md"}]},
    {"id": "analysis", "title": "Analysis",
     "resources": [{"path": "architecture.mmd"}, {"path": "report.json"}]}
  ]
}

COLLECTION FIELDS
  kind/schema_version/title/scenes are required; use "collection" and version 1.
  Titles are 1 to 120 nonblank characters. Each scene requires id and title.
  IDs are unique, 1 to 64 ASCII lowercase letters, digits, "_" or "-".
  active_scene_id is optional, defaults to the first scene, and must name a scene.
  Each child has either resources plus optional groups (same schema as above),
  or one uri handled by an installed plugin, with no resources or groups.
  Nested collections are not supported. At most 256 explicit resources total.

PATHS, LIMITS AND CONFLICTS
  Relative paths resolve from the config file's directory; --config - uses the
  working directory. Local filesystem paths refer to this Client's machine.
  Config JSON is limited to 4 MiB. A basic scene has 1 to 256 resources.
  Unknown fields/types in the basic scene/collection formats fail. Do not add
  camera, annotations or presentation: those are viewer state, not config fields.
  --config conflicts with positional files, --recursive, --title, --label and
  --component. --plugin, --host, --ttl and --format still apply.
  Directory discovery skips hidden entries and contained symlinks, sorts each
  directory, removes duplicate canonical paths and preserves argument order.
  --label and --component indices refer to that final expanded order, starting
  at 1. --label 1,2=TEXT creates a group; one index names one resource.
  Sources remain read-only. Links bind exact revisions: changing/deleting or
  revoking a source invalidates them. Default TTL is 7 days; --ttl 0 has no time
  expiry but still needs unchanged, reachable sources and a running server.

PLUGINS AND ADVANCED MANIFESTS
  Run blind plugin list to discover the actual local/Server plugin IDs, URI
  schemes, component names, filename suffixes, descriptions and readiness.
  Do not invent a plugin URI syntax; use its advertised description.
  Installing a plugin does not activate its filename suffixes. Use repeatable
  --plugin ID or --plugin ./directory to enable inference; an explicit
  --component INDEX=PLUGIN:NAME selects only that resource's renderer.
  Run blind plugin --help or blind oss --help for configuration commands.
  Plugins may return a versioned resolver manifest, also accepted by --config:
  schema_version: 1; resources: [{id,uri,label?}]; optional title, requires,
  components, panels, attachments and warnings.
  viewport uses the same state as basic scene config; each collection child
  can specify viewport independently, including plugin-uri children.
  components: [{id,uri,label,component?,placement?,member?,group?,position?,size?}].
  panels: [{id,label,members:[RESOURCE_ID,...],group?}], flat geometry assemblies,
  not independent collection scenes. If present, they cover every geometry
  resource; members within one panel are distinct existing resource IDs.
  attachments use the same {id,uri,label?} schema as resources.
  warnings: [{code,message,resource_id?}].
  requires advertises capabilities: layout.panels for panels; layout.panel-groups
  for panel.group; components.v1 for components; archive.members for component
  members; attachments for attachments. Unsupported required capabilities fail.
  Resource/attachment IDs are unique nonempty strings up to 128 bytes; component
  IDs follow the collection ID rules and cannot collide with any resource ID.
  Panel IDs are unique nonempty strings. Labels use the 1 to 120 character limit.
  Limits: 4096 geometry resources, 4096 attachments, 256 components, 64 panels,
  4096 expanded panel members. At least one resource or component is required.
  Manifest uris are local paths or OSS, not nested plugin or HTTP URLs.
  No renderer code or private plugin settings belong in a share manifest.

LIVE VIEWER AND COMPONENT CONTROL
  The CLI creates and shares scenes. Control a loaded viewer through
  window.blind.catalog(), execute(operation, params), and subscribe(listener).
  The catalog declares JSON schemas, permissions and current availability.
  Browser components use API 1 blind:init and its private MessagePort, with
  capabilities.host_space and exact capabilities.operations grants.
  The legacy blind:scene-command transport is removed. Protocol details:
  https://github.com/hx-w/blind/blob/main/docs/components.md#public-operations
  https://github.com/hx-w/blind/blob/main/docs/components.md#plugin-components-api-1

DOCUMENTATION
  CLI configuration and agent output:
  https://github.com/hx-w/blind/blob/main/docs/cli.md
  Board viewport and fixed panel placement:
  https://github.com/hx-w/blind/blob/main/docs/components.md#groups-and-layout
  Viewer gestures, reading and annotations:
  https://github.com/hx-w/blind/blob/main/docs/viewer.md
  Resolver packages and plugin administration:
  https://github.com/hx-w/blind/blob/main/docs/plugins.md

OUTPUT AND FAILURE CONTRACT
  Use --format json for agents: stdout contains one JSON result on success.
  viewer_url is the interactive capability; image_url renders a fresh PNG.
  owner_url includes a private owner capability: do not publish it.
  ttl_days confirms the lifetime; hosts lists candidate origins.
  resources lists geometry paths and source revisions, not a complete inventory
  of native content. source identifies the owning registration. Collection
  results also contain active_scene_id and scenes, each with id, viewer_url,
  image_url, resources and warnings.
  Diagnostics and warnings go to stderr. Inspect warnings (including each
  scene's warnings): an issued link does not guarantee every resource is available.
  Invalid input or failed registration exits nonzero; stderr explains the cause.
  Correct the named field/path or inspect blind status --json before retrying.
  No Skill, repository checkout or direct Server API call is needed to construct
  the scene and collection inputs described here."#;

const ROOT_HELP: &str = r#"GET STARTED
  Check connection: blind status --json
  Local hosting: blind serve
  Remote registration: blind join --stdin < invitation.json
  Share read-only sources: blind share model.ply review.md --format json

HELP AND COMMAND GROUPS
  Use blind --help, blind <command> --help, or -h for brief help.
  Plugin administration: blind plugin <command> --help
  Object storage: blind oss <command> --help
  Background service: blind service <command> --help
  There is no help subcommand. The Client needs no background process.

COMPLEX SCENES
  blind share --help gives complete scene/collection JSON fields, examples,
  limits, plugin discovery, link lifetimes and the agent output/error contract.
  Generate a config and submit it with blind share --config - --format json.

DOCUMENTATION
  CLI: https://github.com/hx-w/blind/blob/main/docs/cli.md
  Viewer operations: https://github.com/hx-w/blind/blob/main/docs/components.md#public-operations
  Plugins: https://github.com/hx-w/blind/blob/main/docs/plugins.md"#;

#[derive(Parser)]
#[command(
    name = "blind",
    version,
    disable_help_subcommand = true,
    about = "Share 3D models, documents and independent scenes through Blind sources",
    after_help = ROOT_HELP
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
        long_about = "Share files or directories as native scene components through the registered Server. PLY/STL/OBJ → mesh, PTS → points, TXT/LOG/JSONL/CSV → text, MD/Markdown → markdown, JSON → json, HTML/HTM → html, PNG/JPEG/WebP/GIF → image, MMD/Mermaid → mermaid, DOT/GV → dot. Files in one scene share a camera and layout; a collection gives each scene independent review state. Use --config for explicit layouts or several scenes. Source files are never edited.",
        after_help = "Use blind share --help for complete scene/collection JSON schemas, examples and constraints.\nConfiguration: https://github.com/hx-w/blind/blob/main/docs/cli.md\nViewer operations: https://github.com/hx-w/blind/blob/main/docs/components.md#public-operations",
        after_long_help = SHARE_HELP
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
        /// Enable an installed plugin ID or a package directory (./, ../, or absolute).
        #[arg(long = "plugin", value_name = "ID|DIRECTORY")]
        plugins: Vec<String>,
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
            plugins,
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
                    plugins,
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
