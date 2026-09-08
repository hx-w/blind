# Blind

[![CI](https://github.com/hx-w/blind/actions/workflows/ci.yml/badge.svg)](https://github.com/hx-w/blind/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/hx-w/blind)](https://github.com/hx-w/blind/releases/latest)
[![macOS](https://img.shields.io/badge/platform-macOS-4b5563)](https://github.com/hx-w/blind#requirements)
[![License: MIT](https://img.shields.io/github/license/hx-w/blind)](LICENSE)

Instant mobile 3D review for Meshes and point clouds on your Mac.

Blind is one CLI binary that serves local PLY Meshes and point clouds, STL, OBJ,
and Denta PTS files through a mobile-first 3D viewer. It discovers usable Host
addresses, preserves camera and style state behind six-character links, and can
render the same scene directly as a PNG. There is no on-disk Mesh copy or
persistent render cache; a
bounded local SQLite registry stores only encrypted scene descriptors, while
derived review LODs live only in a bounded process-memory cache.

## Why Blind

When an Agent produces a Mesh and you only have a phone, screenshots and 2D
renders hide the details you need to inspect. Blind keeps the original 3D
interaction available: rotate, pan, zoom, fit, switch views, compare multiple
Meshes, hide individual objects, and adjust presentation without returning to
the workstation.

The source file remains the lifecycle owner. Delete or change any Mesh in a
scene and every view or image link for that scene immediately returns
`410 Gone`.

## Install

### Requirements

- macOS 14 or newer
- Apple Silicon or Intel

Install the latest release:

```sh
curl -fsSL https://raw.githubusercontent.com/hx-w/blind/main/install.sh | sh
```

Run the same command again to update. The installer selects the correct macOS
binary, verifies it against the release checksum, and replaces the existing
installation atomically. It never invokes `sudo`. To inspect before running:

```sh
curl -fsSLO https://raw.githubusercontent.com/hx-w/blind/main/install.sh
less install.sh
sh install.sh
```

After Blind is installed, update it in place with the same checksum and archive
validation:

```sh
blind update
```

If the current Blind executable is running as the managed background service,
Blind restarts it and verifies the new version after a successful update. A
service using another Blind installation is left unchanged. Otherwise the
update does not enable automatic startup.

Optional controls:

```sh
# Install a specific release.
curl -fsSL https://raw.githubusercontent.com/hx-w/blind/main/install.sh | BLIND_VERSION=0.2.0 sh

# Select an installation directory already on PATH.
curl -fsSL https://raw.githubusercontent.com/hx-w/blind/main/install.sh | BLIND_INSTALL_DIR="$HOME/.local/bin" sh
```

## Quick start

```sh
# Start once. Repeating this is safe and exits successfully.
blind serve

# Create one scene from one or more local Meshes.
blind share crown.ply preparation.stl --format json

# Vertex-only PLY files are detected and rendered as point clouds.
blind share scan-cloud.ply --format view

# Mix a Mesh with a Denta ordered point ring.
blind share cropped_jaw.ply marginline.pts --format view

# Optional: emit a long self-contained link without using the registry.
blind share crown.ply --stateless --format view

# Stop a manually started server.
blind stop
```

Open `owner_url` on your phone for your own review. Give other people
`viewer_url` or `image_url`.

Use `--title` for a short label or a detailed, multiline scene message:

```sh
blind share crown.ply preparation.stl --title 'Crown comparison

Top: reference crowns. Bottom: generated results.
Review the cusps, grooves, and marginal ridges from the same view.' --format json
```

Scene information is hidden by default. Open **ⓘ 信息** in the bottom toolbar
to read it in a bottom sheet on phones or the side panel on desktop. Messages
preserve line breaks and wrap long words. Long messages scroll without
truncation, while the close control and Mesh statistics remain visible. The
information panel and Mesh details share the same space and can be switched
directly from the toolbar.

Attach labels to individual Meshes with repeated `--label INDEX=TEXT` options
(indices start at 1 and follow the input file order):

```sh
blind share donor-a.ply donor-b.ply --label '1=供体 A' --label '2=供体 B' --format json
```

In the interactive viewer, choose a Mesh in **详情** and edit **3D 标注**.
Labels use a small leader and an attachment dot, follow the Mesh in 3D, and keep
a readable screen size as the camera moves. Placement prefers space outside
Mesh bounds and avoids other labels and controls where space permits.
During camera motion, each label retains its placement
relative to its projected anchor so it does not jump between sides. Hidden
Meshes hide their labels. Clear the text to remove a label; share the current
view to save edits in a new link. Existing links keep their original labels.
Each label accepts up to 120 characters. Labels appear in interactive links;
server-rendered PNG links currently include geometry and screen strokes only.

To keep Blind running after login:

```sh
blind service install
blind service status
```

Install the service as the logged-in user. Do not use `sudo`: Blind installs a
per-user LaunchAgent and will reject root rather than target the wrong GUI
login domain.

Remove the background service with `blind service uninstall`.

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

A Skill is useful for teaching an Agent when to invoke Blind. An MCP adapter
can wrap the CLI for clients that require tool discovery, but it should call
this contract instead of reimplementing scene or lifecycle logic.

## Viewer interaction

- One finger or primary drag uses a full arcball rotation without polar limits.
- Two fingers pinch to zoom and move together to pan.
- Fit frames all visible Meshes.
- The axis control selects canonical front, back, left, right, top, or bottom
  views.
- Details selects the current Mesh and keeps visibility, opacity, color, and
  presentation controls together.
- Each Mesh loads as LOD by default. Details can switch it to Raw without
  changing the camera and reports Raw size, LOD size, saved bytes, and the
  saving percentage.
- Shared view snapshots preserve the selected Raw or LOD quality for every
  Mesh. Legacy links without this state still open as LOD.
- The first cold load shows completed Mesh count while the server generates
  LODs. A single large Mesh remains indeterminate until meshoptimizer returns.
- Vertex-only or zero-face PLY files render as circular GPU point sprites with
  sphere-like lighting. They are not expanded into sphere triangle Meshes.
- PTS rings render as a continuous tube with a sphere at every original point.
- Details also changes surface mode, projection, axes, and the gray background
  theme.
- Brush enters a touch-locked screen-markup mode with four high-contrast
  colors, undo, and clear. Strokes can cross Meshes and empty canvas space.
- Screen markup belongs to the captured view. Any later rotate, pan, zoom,
  Fit, canonical-view, or projection action hides it immediately.
- On phones, Details starts at a compact detent and expands by tapping or
  dragging its handle. The sheet overlays a stable 3D viewport so the model
  remains visible.

The global toolbar never assigns one Mesh name to a multi-Mesh scene and does
not duplicate visibility with a Solo mode.

LOD generation uses meshoptimizer for PLY, STL, and OBJ triangle geometry.
PLY point clouds are deterministically sampled across the full source order;
PTS previews preserve every ordered source point and reduce only the procedural
tube and marker tessellation. Generated binary PLY bytes are cached in memory
up to 256 MiB and disappear when the server exits; neither LODs nor Raw source
copies are written to disk. Raw is fetched only after a client explicitly
selects it. The fixed bandwidth-oriented profile targets 150,000 primitives per
scene, clamps each resource to 2,000 through 50,000 triangles or points, and
uses 0.002 relative simplification error for triangle Meshes. It is
intentionally not exposed as a setting.

## Doctor and link maintenance

`blind doctor` repairs safe local invariants and audits every SQLite-backed
short link without stopping a running server. It restores private config and
registry permissions, verifies the schema, index, WAL, and SQLite integrity,
checks that the configured internal scene key matches the registry, then reports
this distribution:

- valid: the payload decrypts, has not expired, and every source revision still
  matches;
- expired: the absolute seven-day lifetime has ended;
- source gone: a source was deleted, moved, replaced, changed, or became
  unreadable;
- tombstoned: Blind previously detected an invalid source;
- corrupt: required fields or the encrypted payload cannot be read.

When the server is running, `blind doctor` also reports the in-memory LOD cache:
entry count, resident bytes versus the 256 MiB limit, Raw-to-LOD payload savings,
and source-to-LOD triangle and point counts. With no server running it reports
the cache as inactive because derived LODs never persist to disk.

Invalid or all SQLite-backed short links can be deleted while Blind continues
serving other requests:

```sh
blind doctor --clean-invalid
blind doctor --clear-all
```

These actions affect `/s/` short links. Stateless `/v/` links have no SQLite
row to list or delete.

## Sharing

The share action captures the current camera, presentation state, and visible
screen markup, then
offers three outputs:

1. **View link** restores the interactive scene at the captured view.
2. **Image link** returns an immediate `image/png` render of that state.
3. **Complete information** contains all source paths plus both links. It is
   available only from `owner_url`.

The scene descriptor is compressed, encrypted, and authenticated with
XChaCha20-Poly1305, then stored in a local bounded registry. The default link
has an absolute seven-day lifetime. Blind reuses the code for an identical
active scene, permits at most 10,000 active scenes, and caps retained rows at
12,000 so SQLite cannot grow without bound. It contains no PAT and no Mesh
bytes. Every route verifies the SHA-256 revision of every source before
responding. Restarting the server keeps links valid. The internal scene key
encrypts link payloads; it is not a login credential and has no routine
user-facing maintenance command. The PAT remains the credential for control
API operations.

`blind share --stateless` is the explicit exception: it emits a long encrypted
`/v/` URL and writes no registry row.

Interactive WebGL and offscreen WebGPU use the same matte material definition,
color-space rules, camera state, deterministic overlap bias, and light model.
The target-specific GLSL and WGSL adapters are isolated from scene handling so
future material definitions can be added without coupling them to the viewer.
The browser draws screen markup in a dedicated 2D layer. The image renderer
composites the same normalized strokes after the 3D pass, so a view link and
its image link show the same captured marks.

For PTS, Blind accepts Denta's `BEGIN`/`END`, numbered marker variants, and
bare finite `x y z` rows. The ordered points form a closed ring;
`SELECTION_SEED` metadata is retained in the source but is not rendered. Blind
derives a mobile-visible tube and point size from the ring bounds and limits
one PTS resource to 4,096 points.

See [the sharing contract](docs/sharing.md) for the exact capability and
lifecycle semantics.

## Host discovery and access

Blind listens on `0.0.0.0:7400` by default and detects addresses from active
network interfaces. Several private, local, or global origins may be returned.
The first is used unless you choose one explicitly:

```sh
blind hosts
blind init --host https://mesh.example.test
blind share model.ply --host http://10.0.0.8:7400
```

Browser-generated shares initially keep the origin used to open the current
page. The Share sheet lists every detected Host and can regenerate the view,
image, and Complete information links with another selected origin.

For CLI automation, `--host` always wins. Without it, Blind uses a configured
origin from `blind init --host` when present; otherwise it prefers private IPv4
addresses in `100.64.0.0/10`, LAN IPv4, private IPv6, other IPv4, then other
IPv6. Interface name and address break ties, and loopback is last. `blind hosts`
shows the current order and marks the default with `*`.

For remote mobile access, provide a trusted private network or HTTPS reverse proxy.
Plain HTTP may prevent browser clipboard APIs, in which case Blind uses a
visible, preselected text field for manual copying. Blind only reports an
automatic copy after the browser confirms the clipboard write.

## Authentication and security

The control API that creates scenes and lists Host interfaces requires a PAT.
Initialize and print it locally:

```sh
blind init --show-pat
```

Send it only as `Authorization: Bearer blind_pat_...`. Viewer URLs are bearer
capabilities. Anyone with a public URL can read that exact scene and create a
new public snapshot while the sources match. Public scene responses expose
file names but not absolute paths. Keep `owner_url` private because it can copy
source paths.

Blind is intended for trusted private networks. Do not expose it directly to
the public internet. See [SECURITY.md](SECURITY.md) for reporting and deployment
guidance.

## Build from source

Requirements are Rust 1.85 or newer, Node.js 24, and npm.

```sh
npm ci --prefix web
npm run build --prefix web
cargo build --locked --release
```

The installed binary embeds the generated `web/dist` and does not require
Node.js. The directory is intentionally excluded from version control. Before
a pull request, run:

```sh
cargo fmt --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked
```

## API

| Route | Access | Purpose |
| --- | --- | --- |
| `GET /api/v1/health` | Public | Version and renderer readiness |
| `GET /api/v1/control/health` | PAT | Verify this configured Blind instance |
| `POST /api/v1/control/stop` | PAT | Gracefully stop the server |
| `GET /api/v1/control/doctor` | PAT | Audit and repair the live short-link registry |
| `POST /api/v1/control/doctor/clean-invalid` | PAT | Remove invalid short links from the live registry |
| `POST /api/v1/control/doctor/clear-all` | PAT | Remove every short link from the live registry |
| `GET /api/v1/hosts` | PAT | Detected Host candidates |
| `POST /api/v1/scenes` | PAT | Create a scene from local paths |
| `GET /api/v1/scenes/:token` | Scene capability | Read validated public state |
| `GET /api/v1/scenes/:token/meshes/:index` | Scene capability | Stream a validated Mesh |
| `GET /api/v1/scenes/:token/meshes/:index/lod` | Scene capability | Generate or stream an in-memory review LOD |
| `POST /api/v1/scenes/:token/share` | Scene capability | Capture camera and style state |
| `GET /s/:code` | Short scene capability | Open the default viewer link |
| `GET /v/:token` | Stateless scene capability | Open an explicit long link |
| `GET /i/:token.png` | Scene capability | Render a fresh PNG |

## License

[MIT](LICENSE)
