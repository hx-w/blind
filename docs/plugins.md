# Plugins

[Documentation](../README.md#documentation)

One plugin package can provide a native share resolver, browser components, or
both. Install it on the executing Client or Server, or select a ready-configured
local directory with `--plugin ./directory`.
Installing a component does **not** activate it for every share.

```sh
blind plugin install ./example-plugin
blind share 'example://case-123' --format json
blind share report.table.json --plugin example --format json
blind share report.json --component example:table --format json
blind plugin list
```

A locally installed resolver runs as a child process on the CLI machine. Blind
sends its manifest and browser renderer snapshot to the connected Server, not its
executable or settings. If no local resolver owns the URI scheme, the connected
Server may resolve it using its own installation. A failed local resolver or
remote connection is an error, never a fallback to another implementation.

The Client preserves everything after the first `://`, including a nested URL
and query. One plugin URI is allowed per share, without label or display
overrides. `--title`, `--host`, `--ttl`, and `--format` retain their usual meanings.
`--plugin ID` or `--plugin ./directory` is repeatable and enables that package's
suffix detection for this share only. A directory package runs without installation.
Explicit `--component ID:NAME`, including component types returned by a
resolver, selects that component without enabling the package's other suffixes.
Ordinary URLs do not load installed plugins.

Clients that only use OSS or plugins can register without SSH:

```sh
blind join --stdin --client-only
```

This creates an active Client identity with no filesystem source. It cannot read
Server-local files. Existing SFTP and same-user local registrations remain valid.

## Upgrading from Blind 1.x

Blind 2 uses only TOML packages and resolver protocol 2. Repackage and reinstall
existing plugins with author metadata, declared environment variables and a
private `.env`; JSON manifests, JSON settings and interactive `configure` are
not read. Use Cyclops 0.4.0 or newer.

Saved 1.x plugin links pin native-package revisions, not browser CAS revisions.
Migrate their exact saved browser snapshots before the Server cutover, or share
those scenes again afterward. Blind 2 does not load historical native packages
to reconstruct missing browser snapshots. Ordinary links without plugin
renderers do not need this snapshot migration.

## Installation and configuration

Plugin administration manages this machine's `BLIND_CONFIG_DIR` (or normal Blind
configuration directory). `blind plugin list` combines local installations and
the connected Server catalog, including Server connection state. A Server error
returns a nonzero exit status while preserving local output.

```sh
blind plugin install ./example-plugin
blind plugin config example
blind share 'example://case-123' --plugin ./example-plugin
blind plugin remove example
```

Prepare a ready-configured directory containing `blind-plugin.toml`, declared
public files and a private `.env`. Initial installation imports `.env` into
`plugins/ID/.env` with mode 0600. Edit that private file to change configuration;
there is no interactive `configure` command. `blind plugin config example` is
read-only and shows declared environment values with secrets redacted.
Reinstallation and updates preserve
the existing `.env` byte-for-byte and validate it against the new declaration
before atomically switching `current.json`. Invalid configuration leaves the
old installation active.

For the example below, the directory's private `.env` contains:

```dotenv
OSS_ALIAS=team
BUCKET=models
API_TOKEN="your-private-token"
```

Keep `.env` out of version control, public file declarations and release archives.

Only declared files enter `plugins/ID/versions/CONTENT_HASH`. Public files cannot
include `.env` or an alias to private environment data. Package paths and symlinks
cannot escape the package. No installer hooks or package managers run.
Interpreter runtimes must already exist on the executing machine. Native
programs are trusted code running as that machine's OS user, **not sandboxed code**.

Each call captures immutable package bytes, renderer content and validated
environment values in a private execution snapshot. Native package revisions
and browser CAS records are distinct. Removed or unavailable native code is never
recovered from historical versions or browser snapshots. Removal deletes the
receipt; in-flight snapshots can finish, and existing URLs keep their Server-stored
browser content. There is no resident plugin process or reload step.

## Package manifest

```toml
id = "example"
name = "Example resolver"
version = "1.0.0"
authors = [{ name = "Example Team", url = "https://example.org" }]
description = "Resolve case metadata into OSS references"
schemes = ["example"]
protocol_versions = [2]
entrypoint = ["python3", "resolver.py"]
files = ["resolver.py"]

[env.OSS_ALIAS]
type = "string"
required = true

[env.BUCKET]
type = "string"
required = true

[env.API_TOKEN]
type = "string"
required = true
secret = true
```

`authors` is required; author entries contain `name` and optional `email` and
`url`. Optional package metadata includes `license`, `repository`, `homepage`,
`keywords` and `description`. `components` and `update` are described below.
`oss`, `http`, `https`, and `file` are reserved. Schemes must be lowercase URI
scheme names and must not conflict with another installed plugin.

`env` declares uppercase variable names and supports `type` (`string`, `integer`,
`number`, `boolean`), `required`, `default`, `secret`, `description` and `enum`.
Unknown manifest fields are rejected. Secret variables cannot declare defaults.
Private `.env` values override defaults; undeclared variables, missing required
values and invalid types fail validation. Values are passed as strings in the
child environment. Dotenv quoting is literal: there is no expansion, interpolation
or host-environment fallback, and escape sequences are not decoded.
`PATH`, `PYTHONDONTWRITEBYTECODE` and `PYTHONIOENCODING` are runtime-reserved.

## Resolver protocol 2

The executing Client or Server starts the entrypoint without a shell, sends one
UTF-8 JSON-RPC 2.0 `resolve` request followed by a newline, closes stdin, reads one
JSON response, and waits for exit. Input and output are bounded to 4 MiB; process
lifetime is 60 seconds. The Server admits at most two manifest or renderer-upload
share calls concurrently; additional calls return 429. There is no persistent
queue, operation registry, or automatic retry. Stderr is discarded to avoid
exposing secrets; debug the plugin directly when needed. Environment is cleared
apart from fixed runtime necessities and the plugin's declared environment.

`params` contains:

- `protocol_version`: 2.
- `input`: the exact string after `SCHEME://`.
- `context`: `server_version`, `capabilities`, and an absolute Unix `deadline`.

There is no `config` parameter. Private values belong only in the executing
process environment.

Use the request's `id` in the response. Return exactly one of `result` or `error`.
An error uses JSON-RPC `code`, a human `message`, and stable `data.code`.
The Host does not forward arbitrary subprocess error text. Recognized domain
codes include `INVALID_INPUT`, `ORDER_NOT_FOUND`, `UPSTREAM_AUTH_FAILED`,
`UPSTREAM_UNAVAILABLE`, and `NO_GEOMETRY`; other failures are `PLUGIN_ERROR`.

No Client credential, owner PAT, scene key, or OSS credential is sent to plugins.
All active Clients can invoke configured Server resolvers, matching the trusted-
team OSS model. Anonymous viewers cannot discover or invoke plugins.
Server-executed resolvers may return only OSS references, never local paths,
HTTP URLs, or nested plugin URIs. Declared `OSS_ALIAS`/`BUCKET` bindings constrain
those outputs to the configured alias and bucket. Client-executed resolvers may
also return local paths, which must be absolute and refer to persistent files outside the private
execution snapshot. The snapshot is temporary and is removed after the call.
The Server reads local outputs through the Client's registered local/SFTP source.
A `--client-only` identity cannot share filesystem paths. Plugins fetch business
metadata; Blind alone reads artifact bytes and signs OSS requests.

## ShareManifest v1

`result` contains:

```json
{
  "schema_version": 1,
  "requires": ["layout.panels", "attachments"],
  "title": "Case review",
  "resources": [
    {"id": "jaw", "uri": "oss://team/models/jaw.ply", "label": "Jaw"},
    {"id": "crown", "uri": "oss://team/models/crown.ply", "label": "Crown", "visible": false}
  ],
  "panels": [
    {"id": "assembled", "label": "Assembly", "members": ["jaw", "crown"]},
    {"id": "detail", "label": "Crown", "members": ["crown"]}
  ],
  "attachments": [
    {"id": "log", "uri": "oss://team/models/run.zip", "label": "Run log"}
  ],
  "warnings": []
}
```

Resource IDs are unique across geometry and attachments. Panel IDs are unique;
member IDs must exist and cannot repeat within a panel. Panels must cover all
geometry resources. Reusing one resource across panels is supported. Limits:
4,096 geometry references, 4,096 attachments, 64 panels, 120 characters per label.
Warnings carry `code`, `message`, and optional `resource_id`.

Geometry `resources` and all `components` accept optional boolean `visible`;
omission means `true`. Each panel instance inherits its referenced resource's
visibility. Distinct IDs can reference the same URI with different visibility,
without allowing a cached source read to overwrite either instance's selection.
Native and plugin surfaces can also start hidden. Hidden resources still undergo
source observation, registration and revision pinning, and retain complete scene
metadata. Download-only `attachments` reject `visible`, including `true`, because
they have no scene visibility. Collection plugin children preserve these fields.

Geometry `resources` and geometry `components` accept optional `quality` with
`"raw"` or `"lod"`; omission retains the LOD default. Repeated source URIs can
have different selections under distinct resource IDs. Panel instances inherit
their referenced resource's selection. Attachments and nongeometry components
reject quality. Raw uses original geometry on initial viewer load and PNG export;
LOD can generate a derived approximation on demand. Each final LOD geometry
entity reports `LOD_SELECTED`, without claiming generation has already happened
or changing source bytes/revisions. These selection warnings are informational:
only other warnings make a share partial.


Without panels, original coordinates are used. With panels, original relative
coordinates are retained within each panel. The Server computes union bounds,
centers each panel in a grid of at most four columns with a 10% gap, then stores
each instance's translation in scene schema 4. Web and PNG apply these same
translations. Surface marks and explicit label anchors use scene world
coordinates; sharing never recomputes layout. Raw bytes remain original.

The Server hashes sources, computes geometry bounds, and persists the descriptor
without artifact copies. Repeated source URIs share initial reads. Failed
resources remain explicit warnings and cause `status: partial`; no readable
geometry or component is an error. Attachments are independently hashed and served
through capability-protected download endpoints. ZIPs are attachments, not
recursively expanded. Unavailable attachments remain listed. No storage URI or secret is
exposed in public metadata. Existing revocation and source-revision semantics
continue to apply after the plugin is removed.

Missing source files are allowed in manifests: readable resources can still
produce a partial share. This does not permit missing declared package files.

The same manifest is accepted by `blind share --config FILE`; relative geometry,
component and attachment paths resolve from that file's directory. OSS references
retain their meaning. Filesystem access still requires a registered source.
Unversioned `{resources:[{path,label}],groups}` files remain supported.

Package version, protocol version and manifest version are separate. Optional
additive wire fields are ignored. Required behavior belongs in `requires`:
unknown capabilities fail explicitly, never silently flatten or drop content.
Changes to required fields or existing meanings need a new major version.
Human configuration fields remain strict to catch misspellings.

## Status and verification

`status --json` returns schema 1 with `local_server`, `connection`, `target`, and
`plugins`. It never creates config, starts a Server or registers a Client.
Local absence and remote connectivity are independent. Connection failures are
reported separately from invalid credentials. `server-status` is a hidden alias
using the same implementation. Plugin `configured` means its declared environment
is valid, not that an upstream token has been verified.

```sh
cargo fmt --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked
cargo build --locked
python3 tests/integration_plugins.py
python3 tests/integration_plugin_bundles.py
python3 tests/integration_oss.py
python3 tests/integration_sftp.py
npm test --prefix web
npm run build --prefix web
npm run test:browser --prefix web
```

## GitHub Release updates

A package can opt into stable GitHub updates with:

```toml
[update]
repository = "OWNER/REPO"
```

The repository name must match the plugin ID for initial GitHub installation:

```sh
blind plugin install github:OWNER/REPO
blind plugin update ID
# Private repositories: read a release-download token from stdin.
blind plugin install github:OWNER/REPO --token-stdin
blind plugin update ID --token-stdin
```

The installing machine stores the download token separately in
`plugins/ID/update-auth.json` (mode 0600); it is never included in resolver input,
catalog output, renderer snapshots or scenes. Supply a read-only token scoped to
the private repository. Install/update explicitly manage the local installation;
`plugin list` also discovers Server installations.

Publish stable `vX.Y.Z` tags from the default branch through CI. Each release must
contain `ID-aarch64-apple-darwin.tar.gz`, `ID-x86_64-apple-darwin.tar.gz`,
`ID-linux-x86_64.tar.gz`, and `SHA256SUMS`. Archives contain `blind-plugin.toml`
and declared public files at their root, with matching ID, version and update
repository. Never include `.env` or private data in release archives.
The host validates checksums, bounded extraction, protocol compatibility and
the existing environment before atomically changing the installation receipt.
It preserves `.env` byte-for-byte, rejects downgrades, and keeps the old package
active if validation or downloading fails. Local directory reinstall remains available.

## Partial results

Warnings persist in scenes and reshares; PNG exports include a partial-result notice. The Client prints them to stderr while
keeping JSON/link stdout machine-readable. The viewer shows a persistent notice
with details and unavailable attachments in Info. Partially readable panels retain
their captions, including when only one mesh remains. Empty panels are listed in
warnings; no readable geometry produces an error instead of an empty viewer link.
Plugins may provide safe state warnings (such as a failed upstream job with useful
remaining outputs); do not include credentials or upstream stack traces.

Environment schema evolution should remain additive: new required variables need
defaults, and existing variables retain their meanings. An incompatible schema is
rejected before upgrade. For intentional breaking reconfiguration, save the
values you need, run `blind plugin remove ID --purge-config`, prepare a new `.env`
and reinstall. The flag discards the private environment but keeps the separate
release-download credential and existing scenes. Administrative commands serialize
across processes; concurrent commands report busy and can be retried afterward.

A manifest may expand to at most 4,096 Mesh instances across all panels. Both plugin and direct manifest shares use the same bounded Server admission and geometry memory budget.

## Component renderers

Plugins register sandboxed, namespaced components with immutable browser
snapshots and a versioned loading/state/export protocol. See
[component API](components.md#plugin-components-api-1). Business resolvers may return
`components` with `components.v1` and exact ZIP members with `archive.members`;
Blind does not interpret order, task, or trace semantics.

### Sharing and snapshot storage

```text
Local package -> CLI resolver -> manifest + browser snapshot -> Server registry
                                    |                              |
                             private environment stays local immutable share URL
                                                                   |
                                                        Viewer / PNG sandbox
```

A browser snapshot contains only plugin ID, version, component declarations and
self-contained HTML. Its separate SHA-256 digest includes those fields and bytes,
with canonical declaration ordering and length-framed fields. Native executables,
environment declarations, private values and release credentials are excluded.
Different Clients with the same browser content and version share one SQLite CAS
record, even if their native builds differ. A version change produces a different
snapshot even when HTML is unchanged.

Each scene stores immutable renderer bindings and references the CAS record.
Collections retain each child's bindings; reshares retain the exact snapshot and
component state. Local uninstall or update cannot change an existing URL.
The Server serves renderer bytes only through the URL's scene/entity capability;
it never executes an uploaded native program.

Scene registration, snapshot insertion and reference insertion commit together.
Source revocation immediately releases references belonging only to revoked
entries, including permanent links; a mixed-source collection retains its live
children and their snapshots. Expiry and explicit cleanup also release references;
the last reference allows snapshot deletion. Server startup and its 60-second
maintenance cycle prune unused snapshots. `doctor --clean-invalid` and
`doctor --clear-all` also collect them. Temporary source failures retain scenes
and references.
Persisted browser content is independent of native installations. Missing CAS
content fails explicitly; there is no historical native installation fallback.
Native installation versions are not CAS garbage.

### Conflict rules and limits

- An installed URI scheme has one owner per machine; reserved schemes cannot be
  registered. A local resolver takes precedence over a Server resolver.
- Components are namespaced as `ID:NAME`; duplicate names inside one package fail.
  Built-in geometry suffixes remain reserved.
- Only explicitly enabled packages participate in suffix inference. The longest
  matching suffix wins; equally specific owners fail before creating a link.
  Select `--component ID:NAME` to resolve that ambiguity; load order never wins.
- Two different snapshots for the same plugin ID in one scene or collection fail.
  Different URLs and Clients may use different revisions independently.
- Unsupported protocols, unknown required capabilities, invalid bindings,
  missing HTML and package escapes fail explicitly before registration.

Limits: 64 components per package; 4 MiB per UTF-8 HTML document; 8 MiB total HTML
and 1 MiB renderer metadata per share; 64 renderer bundles per share. Native
packages allow 64 MiB per non-HTML file and 256 MiB total. Client scene request
bodies are bounded to 64 MiB and authenticated before JSON parsing.
