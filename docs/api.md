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

Scene creation `display` entries accept optional `quality: "raw"|"lod"`.
Entries align with `paths`; the server rejects quality unless the resolved
component is mesh or points (including inferred types). Omission preserves LOD.
Basic CLI configs carry the same field per resource and Collection child;
advanced/plugin manifests accept it on geometry `resources` and `components`,
never attachments. Public scene `meshes[].quality` records the initial selection:
raw loads source geometry directly in the viewer and PNG path, while LOD may
request derived approximation generation. Source identity remains unchanged.
Share JSON exposes `LOD_SELECTED` warnings per geometry entity; Collection
results preserve them in each child's `warnings`. These informational warnings
alone leave `status: "complete"`; unavailable resources still make it partial.

Scene creation `display` entries also accept optional boolean `visible`, defaulting
to `true`, for both geometry and surfaces. Basic config resources, Collection child
resources and advanced/plugin `resources` and `components` carry the same field.
The initial value is reflected in both `meshes[].visible` and `entities[].visible`
for geometry, and `entities[].visible` for surfaces. Repeated sources may differ
per instance. Hidden sources still have complete revision metadata and capability
endpoints, with unchanged registration, source identity and revocation checks.
Download-only manifest `attachments` reject `visible` rather than ignoring it.

Surface `display` entries accept `panel_height`, a finite positive preferred outer
pane height in CSS pixels, or omission/null for automatic allocation. Basic config
resources, Collection children and manifest components use the same field;
geometry rejects explicit heights. Public entity descriptors and full reshare
entity updates carry the preference independently of world-space `size`.
Actual viewport clamps do not alter the saved value. An omitted/null height in a
full entity update resets that entity to automatic allocation.


For Agent integration, prefer the [CLI JSON contract](cli.md#agent-interface).

For a running viewer, use the [public operation catalog](components.md#public-operations):
`window.blind` and the component's private port expose the same typed semantic
operations used by UI and Collection. This interface operates on loaded scene
state, with exact operation grants and structured errors; it is not a DOM-control
or arbitrary HTTP proxy.
