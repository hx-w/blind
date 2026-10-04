# Sharing from the CLI

[Documentation](../README.md#documentation)

Share one file, a directory, a group of files, or several independent scenes. The CLI is also
the Agent interface; `blind share --help` describes its complete input contract.

```sh
blind share model.ply
blind share model.ply notes.md metrics.json --format json
blind share --config scene.json --format json
```

Files are displayed by extension. See [scene components](components.md) for
Markdown, text, JSON, HTML, images, geometry and renderer overrides.

## Directories

```sh
blind share ./
blind share ./results --format json
blind share ./results --recursive --title 'Run review'
blind share ./geometry ./reports extra.log
```

Each directory expands to its supported files and produces **one scene link**
for the combined inputs. By default only the directory's current level is scanned;
`--recursive` includes subdirectories. Discovery uses built-in component
extensions plus renderer extensions explicitly enabled with repeatable
`--plugin ID` or `--plugin ./directory` (without installation), case-insensitively.
Packages installed locally or on the connected
Server are not activated merely by installation. Unsupported files,
hidden entries (names starting with `.`), and symbolic links inside directories
are skipped. An explicitly supplied directory may itself be a symbolic link.

Arguments retain their order. Each directory's files are sorted by path, with
duplicate canonical paths removed across the expanded inputs (first occurrence
wins). `--label` and `--component` indices refer to this final order. Explicit
files are retained even with unknown extensions, allowing component overrides.
Empty results, unreadable directories, missing inputs, or more than 256 resources
fail before creating a link; oversized scans are never silently truncated.

The resource list is captured when the command runs: new files require another
`share`. Existing source validation still applies to changed or deleted files.

Use `blind share ./reports --plugin example` to include that package's supported
files. `--component INDEX=ID:NAME` selects a component for an explicit file without
enabling its package's other suffixes. `plugin list` combines local installations
and the connected Server catalog, with Server connection state. Server errors
return a nonzero exit status while preserving local output.
Directory discovery does not apply to `--config` resources or OSS/plugin URIs;
`--recursive` cannot be combined with `--config`. It does not apply `.gitignore`
rules, so choose the directory whose supported files you intend to share.

## Titles and scene information

Use `--title` for a short label or a detailed, multiline scene message:

```sh
blind share crown.ply preparation.stl --title 'Crown comparison

Top: reference crowns. Bottom: generated results.
Review the cusps, grooves, and marginal ridges from the same view.' --format json
```

Scene information includes the source hostname, OS user, and registration name by default.
Open the scene list and choose its **ⓘ 信息** tab. Messages preserve line breaks,
wrap long words and scroll without truncation. The same tab shows the selected
entity and Mesh Raw/LOD controls.

## Labels and groups

Attach labels with repeated `--label INDEX[,INDEX...]=TEXT` options. Indices
start at 1 and follow the input file order. One index labels one Mesh; multiple
indices label a group:

```sh
blind share crown.ply donor-a.ply donor-b.ply \
  --label '1=生成牙冠' --label '2,3=参考牙' --format json
```

## Scene configuration

For a large or persistent resource list, put the scene definition in JSON and
run `blind share --config scene.json`. Relative resource paths are resolved
from the config file's directory; group members are 1-based resource indices:

```json
{
  "title": "Case review",
  "resources": [
    { "path": "meshes/crown.ply", "label": "生成牙冠" },
    { "path": "meshes/donor-a.ply" },
    { "path": "meshes/donor-b.ply" }
  ],
  "groups": [
    { "label": "参考牙", "members": [2, 3] }
  ]
}
```

`--config` is mutually exclusive with positional Meshes, `--title`, and
`--label`; `--host` and `--format` still apply. Unknown JSON
fields, empty resources, bad labels, duplicate group members, and out-of-range
indices fail before any scene is registered. See `blind share --help` for the
complete contract.

## Collections

To share several independent scenes under one link, use a collection config:

```json
{
  "kind": "collection",
  "schema_version": 1,
  "title": "Case review",
  "active_scene_id": "design",
  "scenes": [
    { "id": "design", "title": "Design", "resources": [{ "path": "crown.ply" }] },
    { "id": "scan", "title": "Scan", "resources": [{ "path": "scan.ply" }] }
  ]
}
```

Run `blind share --config collection.json --format json` to receive one
collection URL, a composite image URL, and scene-specific view and image URLs. An agent can pipe JSON
directly into `blind share --config - --format json`; relative paths then use
the current directory. Each child has its own camera, selection, and styles.
The viewer splits when every pane fits, otherwise it shows scene tabs. Its
single toolbar acts on the focused scene. Collections use short links. See
[the sharing contract](sharing.md) for the full schema and reshare API.

## Links and lifetimes

Set a link's lifetime in whole days with `--ttl` (default: `7`). Use `0` for
a permanent link:

```sh
blind share model.ply --ttl 30
blind share model.ply --ttl 0
blind share --config scene.json --ttl 0 --format json
```

Permanent links have no time expiry. They remain subject to source validation:
deleted, changed or revoked sources invalidate the link, while temporary network
or authentication failures preserve it. Automatic expiry and capacity cleanup
never evict a valid permanent scene. Explicit `doctor --clear-all` still removes
all short links, including permanent ones. Permanent scenes count toward the
active-scene limit; reaching that limit rejects new links instead of evicting old ones.

Browser reshares inherit the lifetime setting and preserve annotations. A changed
snapshot starts its own lifetime; sharing an identical active snapshot reuses its
link without extending its expiry.
Non-default lifetimes require a server that confirms TTL support.

The share action captures the current camera, presentation state, and visible
screen markup, then
offers three outputs:

1. **View link** restores the interactive scene at the captured view.
2. **Image link** returns an immediate `image/png` render of that state.
3. **Complete information** contains all source paths plus both links. It is
   available only from `owner_url`.

See [the sharing contract](sharing.md) for source revisions, storage limits and exact restore semantics.

## Agent interface

The CLI is the canonical Agent interface. `blind --help` describes the full
workflow and every command has focused help.

```sh
blind serve
blind share /absolute/crown.ply /absolute/preparation.stl --format json
```

The JSON result contains:

```json
{
  "viewer_url": "http://host:7400/s/aB3_xZ",
  "image_url": "http://host:7400/i/aB3_xZ.png",
  "owner_url": "http://host:7400/s/aB3_xZ#owner=q7_Kp2",
  "hosts": [],
  "resources": [
    {
      "path": "/absolute/crown.ply",
      "revision": "sha256:..."
    }
  ]
}
```

- `owner_url` enables the Complete information share option and must stay
  private.
- `viewer_url` is the read-only interactive scene capability.
- `image_url` renders a fresh PNG on each request.
- `hosts` lists detected origins and marks the primary candidate.
- `resources` gives the canonical source paths and revisions to the Agent.
- `source` identifies the owning host, OS user, and registration name.

A Skill is useful for teaching an Agent when to invoke Blind. An MCP adapter
can wrap the CLI for clients that require tool discovery, but it should call
this contract instead of reimplementing scene or lifecycle logic.
