# Blind

[![CI](https://github.com/hx-w/blind/actions/workflows/ci.yml/badge.svg)](https://github.com/hx-w/blind/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/hx-w/blind)](https://github.com/hx-w/blind/releases/latest)
[![macOS](https://img.shields.io/badge/platform-macOS-4b5563)](https://github.com/hx-w/blind#requirements)
[![License: MIT](https://img.shields.io/github/license/hx-w/blind)](LICENSE)

Instant mobile 3D review for Meshes on your Mac.

Blind is one CLI binary that serves local PLY, STL, OBJ, and Denta PTS files through a
mobile-first 3D viewer. It discovers usable Host addresses, preserves camera
and style state behind six-character links, and can render the same scene
directly as a PNG. There is no Mesh copy or render cache; a bounded local
SQLite registry stores only encrypted scene descriptors.

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

# Mix a Mesh with a Denta ordered point ring.
blind share cropped_jaw.ply marginline.pts --format view

# Optional: emit a long self-contained link without using the registry.
blind share crown.ply --stateless --format view

# Stop a manually started server.
blind stop
```

Open `owner_url` on your phone for your own review. Give other people
`viewer_url` or `image_url`.

To keep Blind running after login:

```sh
blind service install
blind service status
```

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
- Mesh opens the object list with selection and visibility controls.
- PTS rings render as a continuous tube with a sphere at every original point.
- Style changes color, opacity, surface mode, projection, axes, and the
  gray background theme.
- On phones, Mesh uses a compact content-height sheet. Style starts at a short
  detent and expands by tapping or dragging its handle. The 3D viewport shrinks
  above the sheet so the model remains visible.

The global toolbar never assigns one Mesh name to a multi-Mesh scene and does
not duplicate visibility with a Solo mode.

## Sharing

The share action captures the current camera and presentation state, then
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
responding. Restarting the server keeps links valid; `blind key rotate`
intentionally invalidates all existing links.

`blind share --stateless` is the explicit exception: it emits a long encrypted
`/v/` URL and writes no registry row.

Interactive WebGL and offscreen WebGPU use the same matte material definition,
color-space rules, camera state, deterministic overlap bias, and light model.
The target-specific GLSL and WGSL adapters are isolated from scene handling so
future material definitions can be added without coupling them to the viewer.

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

Browser-generated shares keep the origin used to open the current page. For
remote mobile access, provide a trusted private network or HTTPS reverse proxy.
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

The installed binary embeds `web/dist` and does not require Node.js. Before a
pull request, run:

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
| `GET /api/v1/hosts` | PAT | Detected Host candidates |
| `POST /api/v1/scenes` | PAT | Create a scene from local paths |
| `GET /api/v1/scenes/:token` | Scene capability | Read validated public state |
| `GET /api/v1/scenes/:token/meshes/:index` | Scene capability | Stream a validated Mesh |
| `POST /api/v1/scenes/:token/share` | Scene capability | Capture camera and style state |
| `GET /s/:code` | Short scene capability | Open the default viewer link |
| `GET /v/:token` | Stateless scene capability | Open an explicit long link |
| `GET /i/:token.png` | Scene capability | Render a fresh PNG |

## License

[MIT](LICENSE)
