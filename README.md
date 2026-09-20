# Blind

[![CI](https://github.com/hx-w/blind/actions/workflows/ci.yml/badge.svg)](https://github.com/hx-w/blind/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/hx-w/blind)](https://github.com/hx-w/blind/releases/latest)
[![macOS](https://img.shields.io/badge/platform-macOS-4b5563)](https://github.com/hx-w/blind#requirements)
[![License: MIT](https://img.shields.io/github/license/hx-w/blind)](LICENSE)

Instant mobile 3D review across your team's machines.

`blind` is one executable with separate Client and Server responsibilities.
On A, `blind serve` runs the viewer, source registry, LOD generation and PNG
renderer. On B/C, `blind join` and `blind share` are short-lived Client commands;
they do not start a background service. Supported files are PLY meshes and
point clouds, STL, OBJ, and Denta PTS.

Original files stay on their owning host or object store. The server reads remote files through
**read-only SFTP**, or reads directly when Client and Server share the same OS
user and filesystem. It never persists original geometry or rendered images;
only encrypted scene descriptors, registration metadata, and dedicated SSH keys
are stored. Derived LODs use a bounded memory cache.

### OSS sources

Blind reads private meshes from S3-compatible APIs or signed download domains.
On the **Server machine**, configure one alias per endpoint/credential pair:

```sh
blind oss set prod     # prompts: endpoint, region, Access Key, Secret Key
blind oss list        # aliases and connection metadata only; no credentials
blind oss remove prod
```

The default `--signing s3-v4` uses an HTTPS S3 API endpoint and its region.
For a private CDN using HMAC-SHA1 URL signatures:

```sh
blind oss set assets --signing hmac-sha1-url --bucket my-bucket
# prompts: HTTPS download origin, Access Key, Secret Key (no region)
```

This mode signs `https://DOMAIN/KEY?e=DEADLINE`, then appends a `token`
containing the Access Key and URL-safe Base64 HMAC-SHA1 signature. The domain
is bound to the configured bucket; other buckets are rejected. Signed URLs
are generated on the Server and never sent to the Client or viewer.
`set` also replaces an existing alias; terminal credential input is hidden.
Automation can pipe four lines on stdin for S3, or three for URL signing. Credentials are
stored only in the Server's `oss.json`, next to `config.json`, with mode 0600.
The next read picks up changes without a restart.

On a remote Client, `blind oss list` queries its connected Server and shows
the configured signing mode and bucket/region. Every active registered Client
can share these OSS aliases; discovery never returns Access Keys or Secret Keys. `set` and `remove`
always edit the local Server configuration, not the remote Server.

```sh
blind share oss://prod/my-bucket/orders/123/crown.ply --format json
blind share oss://prod/my-bucket/crown.ply oss://archive/other-bucket/jaw.stl
```

Addresses are `oss://ALIAS/BUCKET/KEY`; percent-encode reserved characters in
object keys. Each mesh selects its own alias. Local files can be mixed with OSS
addresses, and `--config` accepts these addresses in `resources[].path`.
Labels, groups, Raw/LOD, PNG and sharing work as for filesystem sources.

Any active registered Client can create OSS shares using the connected Server's
aliases. The Server reads the objects; the Client does not need storage keys or
a live SFTP connection for an OSS-only scene. The owner PAT API also supports
OSS scenes. Viewers only need the resulting Blind URL.

Blind performs signed, read-only GET requests, hashes the original bytes, and
does not save meshes to disk. Changes/deletion or alias removal invalidate
shares; temporary authentication/network failures return 503 and remain
recoverable. Reads are limited to 512 MiB per object and 120 seconds, and do
not follow redirects. HTTPS is required except for loopback test endpoints.

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

Install the same executable on A and B/C:

```sh
curl -fsSL https://raw.githubusercontent.com/hx-w/blind/main/install.sh | sh
```

`blind update` updates that executable and restarts its managed macOS
LaunchAgent or Linux systemd user service when one is installed.
`BLIND_VERSION` and `BLIND_INSTALL_DIR` select a version and installation
directory. The installer never invokes sudo. Client/Server registration is
available starting with v0.7.0.

Prebuilt releases support macOS 14+ on Apple Silicon and Intel, plus native
x86_64 Linux servers. Docker remains optional; see the
[Client/Server guide](docs/client-server.md).

## Quick start

### Central server A

```sh
blind init --host https://blind.example.com
blind serve
# In another terminal, issue one permanent reusable invitation for the team.
blind invite --host https://blind.example.com
# Revoke every issued invitation when rotating a shared invitation.
blind invite --revoke-all
```

Point your HTTPS reverse proxy at the server. Keep its configured public origin
on A; generated URLs never use the source machine's SFTP address.

### Remote Client B/C

Enable the OS OpenSSH/SFTP service once. On macOS: **System Settings → General →
Sharing → Remote Login**, allowing the current user. Then:

```sh
# Paste the invitation through stdin; do not put it in shell history.
blind join --stdin --address workstation.local --name carol
# Finish stdin with Ctrl-D. The address must be reachable from A.
blind share crown.ply preparation.stl --label '1=Crown' --format json
blind status
```

The Client installs a dedicated, forced read-only SFTP public key in this user's
`authorized_keys`; it never uploads a personal private key. Registration tests
both host identity and read-only access. There is no Client daemon. Each OS user
on B registers separately and uses an independent identity and key.

### Client and Server on the same host

```sh
blind serve
# In another terminal, under the same OS user:
blind join --local
blind share crown.ply --format json
```

SFTP is unnecessary in this case. The first `blind share` can register locally
automatically if no Client registration exists. Different OS users, or a host
Client accessing a containerized Server, use the remote SFTP flow.

Use `--stateless` for a long self-contained link. See
[registration, recovery and deployment](docs/client-server.md) for details.

Open `owner_url` on your phone for your own review. Give other people
`viewer_url` or `image_url`.

Use `--title` for a short label or a detailed, multiline scene message:

```sh
blind share crown.ply preparation.stl --title 'Crown comparison

Top: reference crowns. Bottom: generated results.
Review the cusps, grooves, and marginal ridges from the same view.' --format json
```

Scene information includes the source hostname, OS user, and registration name by default. The panel is hidden by default. Open **ⓘ 信息** in the bottom toolbar
to read it in a bottom sheet on phones or the side panel on desktop. Messages
preserve line breaks and wrap long words. Long messages scroll without
truncation, while the close control and Mesh statistics remain visible. The
information panel and Mesh details share the same space and can be switched
directly from the toolbar.

Attach labels with repeated `--label INDEX[,INDEX...]=TEXT` options. Indices
start at 1 and follow the input file order. One index labels one Mesh; multiple
indices label a group:

```sh
blind share crown.ply donor-a.ply donor-b.ply \
  --label '1=生成牙冠' --label '2,3=参考牙' --format json
```

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
`--label`; `--host`, `--stateless`, and `--format` still apply. Unknown JSON
fields, empty resources, bad labels, duplicate group members, and out-of-range
indices fail before any scene is registered. See `blind share --help` for the
complete contract.

In the interactive viewer, choose a Mesh in **详情** and edit **3D 标注**.
Labels use a small leader and an attachment dot, follow the Mesh in 3D, and keep
a readable screen size as the camera moves. Placement prefers space outside
Mesh bounds and avoids other labels and controls where space permits.
During camera motion, each label retains its placement
relative to its projected anchor so it does not jump between sides. Hidden
Meshes hide their labels. Clear the text to remove a label; share the current
view to save edits in a new link. Existing links keep their original labels.
Group labels draw a restrained corner frame around visible members and can be
selected to fit the whole group. Per-Mesh labels can coexist with group labels.
Each label accepts up to 120 characters. Labels appear in interactive links;
server-rendered PNG links currently include geometry and screen strokes only.

To keep Blind running after login:

```sh
blind service install
blind service status
```

Install the service as the logged-in user. Do not use `sudo`: Blind installs a
per-user LaunchAgent on macOS or a systemd user service on Linux and rejects
root rather than target the wrong user session.

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
- `source` identifies the owning host, OS user, and registration name.

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
  LODs. At most four Meshes are requested concurrently, and a single large Mesh
  remains indeterminate until meshoptimizer returns. Individual failures are
  reported without discarding Meshes that already loaded successfully.
- Vertex-only or zero-face PLY files render as circular GPU point sprites with
  sphere-like lighting. They are not expanded into sphere triangle Meshes.
- PTS rings render as smooth, continuous curves through the original ordered samples, without point markers.
- Details also changes surface mode, projection, axes, and the gray background
  theme.
- Annotation → Screen brush enters a touch-locked screen-markup mode with four high-contrast
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
PTS previews preserve ordered source samples when the curve budget permits,
and otherwise resample the smooth curve by arc length before building its tube.
Raw retains the full curve detail. Generated binary PLY bytes are cached in memory
up to 256 MiB and disappear when the server exits; neither LODs nor Raw source
copies are written to disk. Raw is fetched only after a client explicitly
selects it, except for a bounded compatibility fallback: at most 32 MiB for one
Mesh and 64 MiB for the whole scene. The fixed bandwidth-oriented profile
targets 150,000 primitives per scene, clamps each resource to 1 through 50,000
triangles or points, and uses 0.002 relative simplification error for triangle
Meshes. There is no explicit Mesh-count ceiling; request, encrypted-descriptor,
and per-file limits remain practical bounds. The profile is intentionally not
exposed as a setting.

## Surface annotations

Open **标注** in the bottom dock and choose **点** or **线**. Points follow the
Mesh; lines accept clicks or a continuous drag. Sparse handles guide a smooth
curve sampled onto the visible surface. Release a drag to finish one line; the
next drag creates another. For click-to-connect, use **完成线** or **闭合**.
New points and completed lines keep their name field available until another
mark or tool is chosen. **选择** lets you rename, recolor, move handles or delete.
Canvas labels show annotation names directly; click a label to edit its mark.
When the viewport has room, an annotation list opens alongside the scene for
selection and visibility controls. Compact viewports keep the canvas clear of
this list. Closing the list preserves marks, labels and the current selection.
Labels follow camera movement in the same render frame.
Undo and redo include each complete gesture; interrupted touches are cancelled.

Drawing owns the pointer. **选择** finishes the current line and restores camera
gestures on ordinary canvas drags; dragging a selected mark edits its handles.
Colors remain visible in the toolbar. The visible surface under the pointer
chooses the target automatically, independent of the selected Mesh. Every line
belongs to one Mesh. Gaps, hidden surfaces and other Meshes cannot receive samples.
Surface tools require triangle geometry; point clouds and PTS remain viewable.
The target loads Raw on demand; annotated Meshes stay Raw to keep geometry stable.

Sharing captures frozen 3D samples, editing handles, names, colors and visibility.
Reopening never refits the path. View and PNG links include the marks; camera
movement keeps them attached and hidden Meshes hide their marks. Editing produces
a new share without changing the original. PNG exports include points, paths and name labels, with Chinese and
Latin text rendered using the bundled font. Original Mesh files are never modified.
The **画笔** tool retains view-dependent screen markup. All annotation tools
share one dock, color palette, selection list, and undo/redo history. Moving the
camera clears screen strokes, including their undo copies.

## Doctor and link maintenance

`blind doctor` repairs safe local invariants and audits every SQLite-backed
short link without stopping a running server. It restores private config and
registry permissions, verifies the schema, index, WAL, and SQLite integrity,
checks that the configured internal scene key matches the registry, then reports
this distribution:

- valid: the payload decrypts, has not expired, and every source revision still
  matches;
- expired: the configured lifetime has ended;
- source gone: a source was deleted, moved, replaced, changed, or was revoked;
- unavailable: the source host is offline, authentication fails, or access is temporarily denied; these links are retained by `--clean-invalid`;
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
link without extending its expiry. `--stateless` also honors `--ttl` for newly
created links; older stateless links keep their original no-expiry behavior.
Non-default lifetimes require a server that confirms TTL support.

The share action captures the current camera, presentation state, and visible
screen markup, then
offers three outputs:

1. **View link** restores the interactive scene at the captured view.
2. **Image link** returns an immediate `image/png` render of that state.
3. **Complete information** contains all source paths plus both links. It is
   available only from `owner_url`.

The scene descriptor is compressed, encrypted, and authenticated with
XChaCha20-Poly1305, then stored in a local bounded registry. The default link
has an absolute seven-day lifetime unless `--ttl` overrides it. Blind reuses the code for an identical
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
derives a mobile-visible tube width from the ring bounds and limits
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

The Server control API requires its private PAT. Remote Clients use their own registration credentials for scene creation and cannot choose another user's source.
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
| `POST /api/v1/scenes` | PAT | Create a scene from local paths or OSS addresses |
| `GET /api/v1/client/oss` | Client credential | Discover OSS aliases and sharing authority, without credentials |
| `GET /api/v1/scenes/:token` | Scene capability | Read validated public state |
| `GET /api/v1/scenes/:token/meshes/:index` | Scene capability | Stream a validated Mesh |
| `GET /api/v1/scenes/:token/meshes/:index/lod` | Scene capability | Generate or stream an in-memory review LOD |
| `POST /api/v1/scenes/:token/share` | Scene capability | Capture camera and style state |
| `GET /s/:code` | Short scene capability | Open the default viewer link |
| `GET /v/:token` | Stateless scene capability | Open an explicit long link |
| `GET /i/:token.png` | Scene capability | Render a fresh PNG |

## License

[MIT](LICENSE)

## Server plugins

Server-side resolvers extend `blind share SCHEME://INPUT` without installing
plugins on Clients. See [plugin installation, configuration and protocol](docs/plugins.md).
`blind status` now reports both the local Server and the current Client connection.

### Scene components

Share geometry, text, HTML and images in one grouped scene. Installed plugins add
other components; Cyclops provides order resolution and trace analysis:

```sh
blind share jaw.ply run.log tracing.json
blind share capture.json --component cyclops:trace
```

See [component selection, layout and interaction](docs/components.md) for the common
component contract, `--config` examples and display boundaries.
