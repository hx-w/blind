# Scene components

[Documentation](../README.md#documentation)

Within each scene, Blind shares files as entities. A component is a renderer
type; an entity is one placed instance of that type bound to a source. Flat
groups organize entities. There is no separate timeline or nested scene. All geometry in a group
retains its relative coordinates. Content surfaces occupy world-space rectangles
and participate in camera projection and Fit.

## Share without configuration

```sh
blind share jaw.ply margin.pts run.log tracing.json
blind share capture.json --component cyclops:trace
blind share jaw.ply capture.json --component 2=cyclops:trace
```

`--component INDEX=TYPE` uses the same one-based resource order as `--label`.
For a single file, the index can be omitted. Repeated overrides for one index,
unknown types, incompatible geometry formats and out-of-range indices fail.
Explicit component selection always wins over filename inference.

| File | Default component |
| --- | --- |
| `.ply`, `.stl`, `.obj` | `mesh` |
| `.pts` | `points` (existing ordered-point/curve rendering) |
| `.log`, `.txt`, `.csv`, `.jsonl` | `text` |
| `.md`, `.markdown` | `markdown` |
| ordinary `.json` | `json` |
| `trace.json`, `tracing.json`, `*.trace.json` with Cyclops installed | `cyclops:trace` |
| `.html`, `.htm` | `html` |
| `.png`, `.jpg`, `.jpeg`, `.webp`, `.gif` | `image` |
| `.mmd`, `.mermaid` | `mermaid` |
| `.dot`, `.gv` | `dot` (Graphviz) |

Matching is case-insensitive and uses the source filename, including OSS keys.
Unknown extensions require an explicit component. JSON is not guessed from its
contents: `execution.json` uses the collapsible JSON viewer; use `--component cyclops:trace` for a trace with
another filename. File contents must still be valid for the chosen renderer.

## Markdown

```sh
blind share review.md
blind share jaw.ply review.md
blind share notes.txt --component markdown
blind share review.md --component text  # inspect the original syntax
```

The `markdown` component renders headings, emphasis, lists, read-only task lists,
quotes, fenced code, links and GitHub-style tables. `mermaid`, `dot`, `gv` and
`graphviz` fences render real SVG diagrams. Documents follow the Viewer theme
and support spatial reading, selection, content marks, fullscreen and PNG export.
Wide code, tables and diagrams use the document's reading window rather than
nested gesture owners.
See [the example document](../tests/fixtures/review.md).

Markdown must be UTF-8. Preview is limited to 1 MiB; larger documents show a
link to the original attachment. HTML is sanitized to document elements; scripts,
styles, frames and interactive forms are removed. HTTP(S) and mailto links open
separately. Relative links and fragment navigation are not resolved. Only embedded
base64 PNG/JPEG/GIF/WebP images render; remote images, sibling file assets and
images that fail to decode are shown as alt text, keeping reading and isolated
exports self-contained. Math typesetting and code syntax highlighting are not included.

## Native reading and diagrams

Text, Markdown, JSON, images, Mermaid and DOT use native DOM/SVG in the same
3D scene, not flattened screenshots or Mesh substitutes. Drag, wheel, touchpad
and one-finger body gestures scroll content. Titles and scene background navigate
the camera. A gesture stays with its original owner at content scroll boundaries;
two fingers navigate the spatial camera.
Ctrl/Meta+wheel zooms standalone diagrams around the reading target without also
scrolling the content window or navigating the scene camera.

The compact name row provides **全屏** and **更多** with 42px screen-space hit areas.
Content mark dots and labels also compensate for CSS3D scale.
The latter menu exposes selection,
focus, content annotation and screen brush; image/diagram zoom and genuine graph
groups appear only when relevant. **选择文字** enables native selection and normal
copy. The source remains read-only and the entity position stays fixed.

Spatial, focused and fullscreen presentations reparent the same content. Returning
keeps the source target reached while reading, including after viewport reflow.
Entity state binds reading and marks to a SHA-256 source identity: source lines
and character offsets for text, blocks for Markdown, JSON pointers, original-image
coordinates and semantic SVG node/edge/group targets. Inline Markdown images and
diagrams also retain source-relative visual anchors.

```sh
blind share architecture.mmd
blind share dependencies.dot review.md
```

Mermaid and Graphviz render locally with bundled libraries; Graphviz WASM requires
no CDN or external service. Diagram sources must be UTF-8 and at most 2 MiB.
DOT admits at most 1,000 distinct nodes and 10,000 expanded edge requests;
duplicate strict edges and later subgraph additions count conservatively.
It also limits input to 100,000 tokens, 64 nested scopes and 1,000 named subgraphs.
One same-origin bundled worker runs at a time, with up to eight queued requests,
a 20-second execution deadline and an 8 MiB SVG output limit. Disposing a surface
cancels its queued or running DOT work. These bounds are not a total-memory sandbox.
External images, active SVG and resource-bearing diagram styles are rejected.
Syntax and complexity failures remain explicit and fail image export.

Grouped standalone diagrams additionally offer **语义深度**: an orthographic
projection of deterministic planes derived from real source groups, with
cross-plane edges and semantic marks retained. The default is the complete flat
SVG. Actual group focus, zoom and the selected depth presentation survive reshares
and PNG export; this does not convert the document into editable 3D geometry.

## Groups and layout

```json
{
  "title": "Case review",
  "resources": [
    {"path": "jaw.ply", "label": "Jaw", "group": "Geometry"},
    {"path": "margin.pts", "label": "Margin", "group": "Geometry"},
    {"path": "run.log", "label": "Worker log", "group": "Diagnostics"},
    {"path": "capture.json", "component": "cyclops:trace", "group": "Diagnostics"}
  ]
}
```

```sh
blind share --config scene.json
```

`member` selects an exact ZIP member path (no recursive unpacking, maximum 64 MiB).
`path` is required. Optional resource fields are `component`, `label`, `group`,
`position: [x,y,z]` and `size: [width,height]`. Paths resolve relative to the config;
absolute local paths and configured `oss://ALIAS/BUCKET/KEY` references work too.
Unknown fields are rejected. Labels and group names contain 1–120 characters.
At most 256 resources are accepted. Surface files are limited to 64 MiB.

Unpositioned entities are arranged in stable, flat groups in the XY plane.
Geometry keeps its internal relative alignment; surfaces sit beside geometry.
Explicit positions are absolute world-space coordinates and are never tiled.
`size` applies only to surfaces, in scene units; default is `[110,70]`.
The `groups: [{"label":"Reference", "members":[1,2]}]` form and grouped
`--label` syntax also map to flat groups. A resource belongs to one group; repeat
its path for an additional instance. A scene may consist entirely of surfaces.

## Interaction

The [Viewer guide](viewer.md) covers scene navigation, labels, visibility,
opacity, surface expansion, annotations, observation tools and sections.
Each component uses the same scene list and sharing controls. Native content owns
body reading in every presentation; geometry and opaque previews retain scene navigation.

## Renderer contract

`web/src/scene-components.ts` defines the shared entity schema,
`ComponentCapabilities`, `ComponentRuntime` and `ComponentRegistry`. Each
renderer registers its type and declares supported presentations (`spatial`,
`focus`, `fullscreen` for earlier plugins), movement, and input ownership by presentation.
The protocol still accepts `resizable` for older plugins, but the Viewer ignores it
and has no drag resize control. A plugin declaring only `fullscreen` opens
in the focus dialog without requesting browser fullscreen.
The host owns grouping, selection, scene list, layout, focus container and sharing.
Renderers implement bounds, position, visibility, opacity, label, presentation, focus,
selection and disposal. Geometry adapters retain the existing mesh loader, LOD,
materials, picking and annotations. Surface adapters share a frame; their content
factories own loading, interaction and cleanup.

The serialized descriptor separates `entities` from source storage. Every entity
binds to `{kind:"mesh"|"attachment",index:N}`; source
paths and credentials are never sent in this binding. Source URLs remain revision
checked by the server. Viewer updates accept **only** ID and mutable presentation
fields; a viewer cannot replace a source or type through a layout update.
Stored descriptors named `components` remain readable at the server boundary;
share updates also accept that older field name. Public scene payloads always
expose `entities`. Older geometry-only descriptors synthesize an entity per
Mesh or PTS resource on the server.

## Plugin components (API 1)

Use a renderer from a Blind plugin installed on a Client or Server, or directly
from `--plugin ./directory` without installation.
No Viewer core edit is required. Component types are namespaced (`example:table`).
Each share pins a versioned browser-content hash in the Server registry; updates
and local uninstall do not change existing URLs. Only that URL's selected
components load, each inside an opaque-origin sandbox. Installation alone does
not enable a renderer.

Add to `blind-plugin.toml` (alongside required package metadata):

```toml
files = ["components/table.html"]

[[components]]
name = "table"
api_version = 1
entrypoint = "components/table.html"
extensions = ["table.json"]
frame_origins = []

[components.capabilities]
presentations = ["spatial", "focus"]
movable = false
resizable = false
```

The entrypoint is self-contained HTML with inline scripts/styles. A renderer-only
package may use empty `schemes` and `entrypoint` arrays. Other manifest fields and
installation checks are unchanged. `blind plugin list` combines local and Server
components and reports Server connection state; Server errors preserve local
output but return a nonzero exit status.

```sh
blind share report.table.json --plugin example
blind share report.json --component example:table
```

`--plugin ID` or `--plugin ./directory` enables suffix detection only for this share
and may be repeated.
Explicit `--component ID:NAME` selects that component without enabling its other
suffixes. A local installation is preferred; explicitly selected Server
components remain available. Longest matching suffix wins; equally specific
matches fail and require `--component`. Built-in geometry suffixes are reserved.
Bare JSON uses the built-in viewer unless an enabled renderer matches. Plugin
code never replaces core code in the parent.

The CLI sends only versioned declarations and self-contained HTML, not native
executables or secrets. The Server deduplicates snapshots across Clients and
serves them through each scene/entity capability. Component state and exact
revisions survive reshares, collections and PNG export. Different snapshots of
one plugin ID cannot coexist in a single scene or collection; separate URLs can
pin different revisions. See [snapshot lifecycle and limits](plugins.md#sharing-and-snapshot-storage).

The host sends `blind:init` through `postMessage` with `version:1`, source `buffer`
(ArrayBuffer), `label`, `state`, `presentation`, `exporting`, and a private
`MessagePort` in `event.ports[0]`. Verify `event.source === parent` and the protocol.
Use that port thereafter:

| Direction | Message | Meaning |
| --- | --- | --- |
| Component → host | `{version:1,type:"ready"}` | Initial/export content has finished drawing |
| Component → host | `{version:1,type:"error",message:"…"}` | Loading/rendering failed; export fails explicitly |
| Component → host | `{version:1,type:"state",state:{…}}` | Save serializable UI state, up to 64 KiB |
| Host → component | `{version:1,type:"presentation",presentation:"focus"}` | Input/space presentation changed |

Resources, credentials and absolute storage paths are not exposed to the component.
The renderer receives only its resource bytes. External frames require explicit
HTTPS origins in the package; network fetch, external scripts, navigation and forms
are blocked. Cleanup timers/listeners and close the port on `pagehide`. Host disposal
aborts reads and removes the iframe. A reload reinitializes with saved state.

For an external application requiring its own browser storage, request
`{version:1,type:"frame:open",url:"https://declared-origin/..."}` on the port.
The host checks the pinned origin allowlist, creates an isolated cross-origin iframe
in the expanded content area below the component's 44px toolbar, and relays only
messages from that exact frame as `frame:message` (`data`). Send `frame:post` (`data`)
to reply; `frame:close` removes it. The host emits `frame:loaded`, `frame:closed` or
`frame:error`. The component implements the application's protocol. These frames
are disabled in spatial/export mode; the component must supply an export-ready
preview. Page CSP is restricted to the origins declared by that scene's pinned
components, without global business-specific exceptions.


Resolver manifests can return `components` alongside geometry `resources`,
`panels` and downloadable `attachments`. Require `components.v1`, plus
`archive.members` if used. Each component has `id`, `uri`, `label`, `component`,
optional `member`, `group`, `position` and `size`. Example:

```json
{"id":"worker-log","uri":"oss://team/bucket/run.zip","member":"run.log",
 "label":"Worker log","component":"text","group":"Worker"}
```

Resolvers own business meaning and default grouping. Blind owns source reads,
revision validation, bounded ZIP member extraction and generic layout. Explicit
positions always win over automatic group layout. Geometry panels may declare a
flat `group` with the `layout.panel-groups` capability: panels tile as independent
assemblies inside that group while keeping each assembly's relative coordinates.
Content components use the same group string. Groups pack in reading order using
the viewport aspect ratio, rather than forcing all groups into equal-size cells. Missing component resources
produce named warnings without discarding readable geometry.

## Image export and content boundaries

PNG export uses the formal Viewer for scenes using the component contract,
including their position, opacity, labels, reading window and content marks. It awaits
text/Markdown loads, SVG diagram rendering, image decode, HTML load, fonts and each visible plugin's `ready` message. Failed
or timed-out components fail export explicitly. Hidden components are not awaited.
Geometry scenes without stored entities use the native renderer; component groups use the Viewer
even when they contain only geometry, keeping automatic layout consistent.

Component-scene export requires Chrome/Chromium on the Server (included in the Docker
image), or `BLIND_RENDER_BROWSER=/absolute/path/to/chromium`. It starts an isolated
headless process with a temporary profile, bounded concurrency and a 75-second
limit. Export requests are restricted to the current scene and embedded Viewer
assets, including isolated frames. Bundled diagram workers are resumed with all
subsequent network requests blocked; their renderer and WASM are self-contained.
The Docker deployment limits the whole service to 4 GiB; native Linux
services can use `systemctl --user set-property blind.service MemoryMax=4G`.
This is a service-wide limit, not a per-component JavaScript memory quota.
It never connects to a user's browser. The frame uses saved canvas dimensions.
HTML's load event cannot prove completion of arbitrary asynchronous application
code; use the plugin readiness protocol for such content.

Text renders as text, never HTML. JSON renders as a collapsible, escaped tree.
The JSON preview is limited to 4 MiB and 5,000 nodes; larger files remain available
through a link to the original attachment. Long string values are shortened in the preview.
HTML supports self-contained sandboxed documents with embedded data/blob images;
relative asset bundles are not expanded. CSS 3D surfaces share the camera with
WebGL; the compositor interleaves content planes and geometry bands for depth and
opacity. Frame labels have no external leader lines.

Blind has nine built-ins: `mesh`, `points`, `text`, `markdown`, `json`, `html`, `image`, `mermaid`, `dot`. Order/task naming,
trace recognition and Perfetto integration belong to Cyclops. Cyclops provides an
exportable Chrome Trace JSON preview and optional Perfetto analysis in the expanded
component; no second scene-level timeline is introduced.

## Verification

```sh
npm test --prefix web
npm run build --prefix web
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test --locked
cargo build --locked
npm run test:content --prefix web
npm run test:collection --prefix web
python3 tests/integration_components.py
python3 tests/integration_plugin_bundles.py
```

Build the Viewer before Rust: the binary embeds `web/dist`. No private test order,
log, trace, generated link or local credentials belong in the repository.
