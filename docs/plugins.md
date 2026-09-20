# Server share resolver plugins

Plugins turn one `SCHEME://INPUT` into a standard scene manifest. Install and
configure them on the Server; Clients only need Blind. For example, after a
Server administrator installs a resolver named `example`, Clients can run:

```sh
blind share 'example://case-123' --format json
blind plugin list
blind status --json
```

The Client preserves everything after the first `://`, including a nested URL
and query. One plugin URI is allowed per share, without `--label` overrides.
`--title`, `--host`, `--stateless`, and `--format` retain their usual meanings.
Unknown schemes are rejected by the target Server. A failed remote connection
never falls back to a local Server.

Clients that only use OSS or plugins can register without SSH:

```sh
blind join --stdin --client-only
```

This creates an active Client identity with no filesystem source. It cannot read
Server-local files. Existing SFTP and same-user local registrations remain valid.

## Installation and configuration

Run these commands **on the Server machine**. Mutation commands always manage
that machine's `BLIND_CONFIG_DIR` (or normal Blind config directory), regardless
of any Client connection. `plugin list` instead discovers the connected Server,
or inspects local installations when there is no Client registration.

```sh
blind plugin install ./example-plugin
blind plugin configure example
blind plugin config example
blind plugin remove example
```

`configure` prompts from the package schema, hides secret input, offers existing
OSS alias names and adopts a bucket bound to the selected alias. For automation:

```sh
blind plugin configure example --set oss_alias=team --set bucket=models --secret-stdin api_token
```

The secret is read from stdin, never argv. Config display redacts `writeOnly`
fields. Configuration verifies types, required fields, the OSS alias and its
bucket binding. It does not claim upstream connectivity until an actual share.

Installation requires a local directory containing `blind-plugin.json`. It
copies only declared files and pins the executable's absolute path. Package
file paths cannot escape the package. No installer hooks, network installation,
or package managers run. Interpreter runtimes, when used, must already exist on the Server.
Native binary packages need no language runtime. Programs are trusted administrator-
installed code running as the Server user, **not sandboxed code**.

Reinstall to upgrade. Files live under `plugins/ID/versions/CONTENT_HASH`; the
`current.json` installation receipt switches atomically after validation.
Configurations live separately in `plugin-config/ID.json` with mode 0600 inside
a 0700 directory. Each call captures one immutable package/config snapshot.
Removal deletes only the receipt: existing calls can finish, config and version
files are retained for reinstall, and already-created scenes keep working.
There is no resident plugin process or reload step.

## Package manifest

```json
{
  "id": "example",
  "name": "Example resolver",
  "version": "1.0.0",
  "description": "Resolve case metadata into OSS references",
  "schemes": ["example"],
  "protocol_versions": [1],
  "entrypoint": ["python3", "resolver.py"],
  "files": ["resolver.py"],
  "config_schema": {
    "type": "object",
    "additionalProperties": false,
    "required": ["oss_alias", "bucket", "api_token"],
    "properties": {
      "oss_alias": {"type": "string"},
      "bucket": {"type": "string"},
      "api_token": {"type": "string", "writeOnly": true}
    }
  }
}
```

`oss`, `http`, `https`, and `file` are reserved. Schemes must be lowercase URI
scheme names and must not conflict with another installed plugin. The config
schema supports a deliberately small JSON Schema subset: closed flat objects,
`required`, scalar properties (`string`, `integer`, `number`, `boolean`), `enum`,
`default`, `title`, `description`, and `writeOnly`. Unsupported validation
keywords are rejected at install instead of being silently ignored. Secret
properties are strings and cannot declare defaults.

## Resolver protocol 1

The Server starts the entrypoint without a shell, sends one UTF-8 JSON-RPC 2.0
`resolve` request followed by a newline, closes stdin, reads one JSON response,
and waits for exit. Stdout must contain only the response. The Host bounds input
and output to 4 MiB and the process lifetime to 60 seconds. At most two plugin
shares are admitted concurrently; additional calls return 429. There is no
persistent queue, operation registry, or automatic retry. Stderr is discarded
by the Host to avoid exposing plugin secrets; debug the plugin directly when
needed. Environment is cleared apart from fixed runtime necessities.

`params` contains:

- `protocol_version`: 1.
- `input`: the exact string after `SCHEME://`.
- `config`: validated plugin settings, including only this plugin's secrets.
- `context`: `server_version`, `capabilities`, and an absolute Unix `deadline`.

Use the request's `id` in the response. Return exactly one of `result` or `error`.
An error uses JSON-RPC `code`, a human `message`, and stable `data.code`.
The Host does not forward arbitrary subprocess error text. Recognized domain
codes include `INVALID_INPUT`, `ORDER_NOT_FOUND`, `UPSTREAM_AUTH_FAILED`,
`UPSTREAM_UNAVAILABLE`, and `NO_GEOMETRY`; other failures are `PLUGIN_ERROR`.

No Client credential, owner PAT, scene key, or OSS credential is sent to plugins.
All active Clients can invoke configured resolvers, matching the existing
trusted-team OSS model. Anonymous viewers cannot discover or invoke plugins.
Plugins may return only ordinary OSS references, never local paths, HTTP URLs,
or nested plugin URIs. If `oss_alias` is declared, all output references must
match that alias and the configured bucket. Plugins fetch their own business
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
    {"id": "crown", "uri": "oss://team/models/crown.ply", "label": "Crown"}
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

Without panels, original coordinates are used. With panels, original relative
coordinates are retained within each panel. The Server computes union bounds,
centers each panel in a grid of at most four columns with a 10% gap, then stores
each instance's translation in scene schema 4. Web and PNG apply these same
translations. Surface marks and explicit label anchors use scene world
coordinates; sharing never recomputes layout. Raw bytes remain original.

The Server hashes sources, computes geometry bounds, and persists the descriptor
without artifact copies. Repeated source URIs share initial reads. Failed
resources remain explicit warnings and cause `status: partial`; no readable
geometry is an error. Attachments are independently hashed and served through
capability-protected download endpoints. ZIPs are attachments, not recursively
expanded. Unavailable attachments remain listed. No OSS URI or secret is
exposed in public metadata. Existing revocation and source-revision semantics
continue to apply after the plugin is removed.

The same manifest is accepted by `blind share --config FILE`; local geometry
URIs in a file resolve relative to that file. Attachments must be OSS references.
Legacy unversioned `{resources:[{path,label}],groups}` files remain supported.

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
using the same implementation. Plugin `configured` means local configuration
is valid, not that an upstream token has been verified.

```sh
cargo fmt --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked
cargo build --locked
python3 tests/integration_plugins.py
python3 tests/integration_oss.py
python3 tests/integration_sftp.py
npm test --prefix web
npm run build --prefix web
npm run test:browser --prefix web
```

## GitHub Release updates

A package can opt into stable GitHub updates with:

```json
"update": { "repository": "OWNER/REPO" }
```

The repository name must match the plugin ID for initial GitHub installation:

```sh
blind plugin install github:OWNER/REPO
blind plugin update ID
# Private repositories: read a release-download token from stdin.
blind plugin install github:OWNER/REPO --token-stdin
blind plugin update ID --token-stdin
```

The Server stores the download token separately in `plugins/ID/update-auth.json`
(mode 0600); it is never included in resolver input, catalog output or scenes.
Supply a read-only token scoped to the private repository. Install/update are
explicit administrative commands on the Server machine; Clients discover the
installed version through `plugin list` and `status`.

Publish stable `vX.Y.Z` tags from the default branch through CI. Each release must
contain `ID-aarch64-apple-darwin.tar.gz`, `ID-x86_64-apple-darwin.tar.gz`,
`ID-linux-x86_64.tar.gz`, and `SHA256SUMS`. Archives contain `blind-plugin.json`
and declared files at their root, with matching ID, version and update repository.
The host validates checksums, bounded archive extraction, protocol compatibility
and existing configuration before atomically changing the installation receipt.
It preserves settings, rejects downgrades, and keeps the old package active if
validation or downloading fails. Local directory reinstall remains available.

## Partial results

Warnings persist in scenes and reshares; PNG exports include a partial-result notice. The Client prints them to stderr while
keeping JSON/link stdout machine-readable. The viewer shows a persistent notice
with details and unavailable attachments in Info. Partially readable panels retain
their captions, including when only one mesh remains. Empty panels are listed in
warnings; no readable geometry produces an error instead of an empty viewer link.
Plugins may provide safe state warnings (such as a failed upstream job with useful
remaining outputs); do not include credentials or upstream stack traces.

Configuration schema evolution should remain additive: new required fields need
defaults, and existing fields retain their meanings. An incompatible schema is
rejected before upgrade. For an intentional breaking reconfiguration, save the
values you need, run `blind plugin remove ID --purge-config`, reinstall, and run
`blind plugin configure ID`; the explicit flag discards plugin settings but keeps
the separate release-download credential and existing scenes. Administrative
commands serialize across processes; concurrent commands report busy and can be
retried after the first finishes.

A manifest may expand to at most 4,096 Mesh instances across all panels. Both plugin and direct manifest shares use the same bounded Server admission and geometry memory budget.

## Component renderers

Plugins can also register sandboxed, namespaced surface components, with pinned
package revisions and a versioned loading/state/export protocol. See
[component API](components.md#plugin-components-api-1). Business resolvers may return
`components` with `components.v1` and exact ZIP members with `archive.members`;
Blind does not interpret order, task, or trace semantics.
