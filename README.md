# Blind

[![CI](https://github.com/hx-w/blind/actions/workflows/ci.yml/badge.svg)](https://github.com/hx-w/blind/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/hx-w/blind)](https://github.com/hx-w/blind/releases/latest)
[![macOS](https://img.shields.io/badge/platform-macOS-4b5563)](https://github.com/hx-w/blind#requirements)
[![License: MIT](https://img.shields.io/github/license/hx-w/blind)](LICENSE)

Instant mobile 3D review for Meshes on your Mac.

Blind is one CLI binary that serves local PLY, STL, and OBJ files through a
mobile-first 3D viewer. It discovers usable Host addresses, preserves camera
and style state inside encrypted links, and can render the same scene directly
as a PNG. There is no Mesh copy, scene database, or render cache.

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
curl -fsSL https://raw.githubusercontent.com/hx-w/blind/main/install.sh | BLIND_VERSION=0.1.0 sh

# Select an installation directory already on PATH.
curl -fsSL https://raw.githubusercontent.com/hx-w/blind/main/install.sh | BLIND_INSTALL_DIR="$HOME/.local/bin" sh
```

## Quick start

```sh
# Start once. Repeating this is safe and exits successfully.
blind serve

# Create one scene from one or more local Meshes.
blind share crown.ply preparation.stl --format json

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
  "viewer_url": "http://host:7400/v/...",
  "image_url": "http://host:7400/i/....png",
  "owner_url": "http://host:7400/v/...#owner=...",
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

- One finger or primary drag rotates.
- Two fingers pinch to zoom and move together to pan.
- Fit frames all visible Meshes.
- The axis control selects canonical front, back, left, right, top, or bottom
  views.
- Mesh opens the object list with selection and visibility controls.
- Style changes color, opacity, surface mode, projection, grid, axes, and the
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
XChaCha20-Poly1305. It contains no PAT and no Mesh bytes. Every route verifies
the SHA-256 revision of every source before responding. Restarting the server
keeps links valid because the scene key persists; `blind key rotate`
intentionally invalidates all existing links.

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
legacy browser fallback and reports if copying is unavailable.

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
| `GET /api/v1/hosts` | PAT | Detected Host candidates |
| `POST /api/v1/scenes` | PAT | Create a scene from local paths |
| `GET /api/v1/scenes/:token` | Scene capability | Read validated public state |
| `GET /api/v1/scenes/:token/meshes/:index` | Scene capability | Stream a validated Mesh |
| `POST /api/v1/scenes/:token/share` | Scene capability | Capture camera and style state |
| `GET /v/:token` | Scene capability | Open the viewer |
| `GET /i/:token.png` | Scene capability | Render a fresh PNG |

## License

[MIT](LICENSE)
