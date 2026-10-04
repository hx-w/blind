# HTTP API

[Documentation](../README.md#documentation)

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
| `GET /api/v1/client/plugins` | Client credential | Discover Server plugin declarations, without settings |
| `POST /api/v1/client/scenes` | Client credential | Create a scene/collection from registered paths, a manifest and optional browser snapshots |
| `GET /api/v1/scenes/:token` | Scene capability | Read validated public state |
| `GET /api/v1/scenes/:token/meshes/:index` | Scene capability | Stream a validated Mesh |
| `GET /api/v1/scenes/:token/meshes/:index/lod` | Scene capability | Generate or stream an in-memory review LOD |
| `GET /api/v1/scenes/:token/renderers/:entity` | Scene capability | Serve only this entity's pinned sandboxed HTML; collections require `?scene=ID` |
| `POST /api/v1/scenes/:token/share` | Scene capability | Capture camera and style state |
| `GET /s/:code` | Short scene capability | Open the default viewer link |
| `GET /i/:token.png` | Scene capability | Render a fresh PNG |

See [authentication](client-server.md#authentication-and-security) for credentials,
[registration endpoints](sharing.md#registration-api) for Client setup, and
[the sharing contract](sharing.md) for payloads, owner capabilities and lifecycle.

Client scene creation accepts `renderers`, an array of browser-only snapshots:
`{id, version, components, documents}`. `components` uses the
[renderer declaration schema](components.md#plugin-components-api-1);
`documents` maps each declared entrypoint to its self-contained UTF-8 HTML.
Snapshots contain no resolver executable or configuration. A collection can
share snapshots in its outer `renderers` array; children may also supply their
own. Identical snapshots are deduplicated, while different snapshots for one
plugin ID in the same request fail.

The Server authenticates Client requests before parsing JSON and limits the
body to 64 MiB. It validates versions, bindings, document paths and bounded
content before atomically registering scenes and snapshot references. See
[snapshot identity, conflicts and lifecycle](plugins.md#sharing-and-snapshot-storage).

For Agent integration, prefer the [CLI JSON contract](cli.md#agent-interface).
