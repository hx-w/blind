# Scene components

Blind shares files into **one scene**. A component is a renderer type; an entity
is one placed instance of that type bound to a source. Flat groups organize
entities. There is no separate timeline or nested scene. All geometry in a group
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
| `.log`, `.txt`, `.md`, `.csv`, `.jsonl` | `text` |
| ordinary `.json` | `json` |
| `trace.json`, `tracing.json`, `*.trace.json` with Cyclops installed | `cyclops:trace` |
| `.html`, `.htm` | `html` |
| `.png`, `.jpg`, `.jpeg`, `.webp`, `.gif` | `image` |

Matching is case-insensitive and uses the source filename, including OSS keys.
Unknown extensions require an explicit component. JSON is not guessed from its
contents: `execution.json` uses the collapsible JSON viewer; use `--component cyclops:trace` for a trace with
another filename. File contents must still be valid for the chosen renderer.

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
The legacy `groups: [{"label":"Reference", "members":[1,2]}]` and grouped
`--label` syntax also map to flat groups. A resource belongs to one group; repeat
its path for an additional instance. A scene may consist entirely of surfaces.

## Interaction

- Drag empty space to orbit; existing zoom/pan and Fit controls still work.
- The scene list selects entities. Each row has an opacity slider and a visibility
  button; hiding retains the slider value, and dragging it above zero shows the
  entity again. It opens by default
  only at widths of at least 1100px and heights of at least 600px. It can be
  opened manually on smaller screens. Its 信息 tab holds source details and warnings.
- Mesh and PTS rows show the current color before the name. Clicking the color
  opens preset choices below that row; a choice updates only that geometry entity.
- Every row has a rename action next to the name. Long names show their
  beginning and end in the row and in 3D; 信息 reveals a scrollable full name.
  The inline editor accepts the complete label. Mesh Raw/LOD quality sits in the
  scene list's 信息 tab. Visibility and opacity live in the scene list.
  Zero opacity is hidden; showing a
  zero-opacity entity restores full opacity.
- Surface sizes come from the share configuration. Dragging a surface title navigates
  the scene; the viewer has no drag resize control.
- Entity positions are fixed during review. The source configuration sets placement.
- Surface content does not consume scene gestures. Click once to select, double click
  or press Enter to expand and interact. Escape / **返回场景** returns to the same layout.
  Spatial opacity does not reduce expanded readability. Perfetto and HTML own keyboard input
  inside their frames; the surrounding return button remains available.
- Share preserves positions, surface sizes, visibility, opacity, camera and
  existing annotations. A public reshare creates a new link, following existing
  Blind ownership behavior.
- On macOS, Cmd+C copies an image link for the current view, and Cmd+Shift+C
  copies its view link. On other desktop systems use Ctrl. Text selection and editable fields keep
  their normal copy behavior.
- 观察 opens a second dock ordered by 着色、光照、投影、场景、剖面.
  Each category expands its controls inside the dock; 剖面 starts drawing. 场景 contains axes and background switches. Raking-light angles and
  strength appear below the tools only when relevant. 返回 restores the main dock. The chosen mode and light settings
  are saved in view and image links. Shading remains independent of lighting:
  a wireframe stays a wireframe under all three lighting modes.
- 剖面 starts from the selected visible triangle Mesh. Clicking the tool directly
  starts a line gesture, which defines a camera-relative plane. All visible
  triangle Meshes join that plane by default; the count in the section window
  opens a picker to isolate a subset. A checked Mesh without an intersection
  is marked there. The position
  slider scans parallel planes. Closed contours become translucent matte planes.
  The plot can zoom, drag to pan, fit all contours, and place up to two rulers.
  Ruler points snap to nearby contours; a point on a contour also shows its
  distance to an opposite contour when a valid crossing exists. Only the Meshes
  selected for this section contribute, so a second Mesh can show an inter-Mesh gap.
  While measuring, right or middle drag pans; on touch screens, two fingers pan
  and pinch to zoom. The wheel zooms around the pointer, and Escape leaves the
  ruler and clears its lines. Drag the upper-left handle to resize the panel.
  Pan, size, and measurements are saved in shares. Distances use source mesh
  coordinates; Blind does not assume a physical unit.
  Line length provides a fallback plot window, not the intersection extent.
  The section plane and each selected target's entity and source revision survive sharing.
  The section window can combine multiple visible Meshes in one plot, with each
  Mesh shown in its own color and automatically fitted when added. The view tilts
  slightly after drawing to reveal the matte section plane. PTS and point clouds
  stay visible but do not expose a triangle section.

## Renderer contract

`web/src/scene-components.ts` defines the shared entity schema,
`ComponentCapabilities`, `ComponentRuntime` and `ComponentRegistry`. Each
renderer registers its type and declares supported presentations (`spatial`,
`focus`, `fullscreen` for legacy plugins), movement, and input ownership by presentation.
The protocol still accepts `resizable` for older plugins, but the Viewer ignores it
and has no drag resize control. A legacy plugin declaring only `fullscreen` opens
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
Stored descriptors and public payloads using `components` remain readable.
Legacy geometry-only scenes synthesize one entity per Mesh or PTS resource.

## Plugin components (API 1)

Install a renderer as part of a normal Blind plugin package. No Viewer core edit
is required. Component types are namespaced (`example:table`); installing a new
revision replaces the implementation for **new** shares. Existing scenes pin the
package content hash. Removal unregisters new uses while retaining pinned packages.
Only the server's installed packages execute, inside an opaque-origin sandbox.

Add to `blind-plugin.json`:

```json
{
  "components": [{
    "name": "table",
    "api_version": 1,
    "entrypoint": "components/table.html",
    "extensions": ["table.json"],
    "capabilities": {
      "presentations": ["spatial", "focus"],
      "movable": false,
      "resizable": false
    },
    "frame_origins": []
  }],
  "files": ["components/table.html"]
}
```

The entrypoint is self-contained HTML with inline scripts/styles. A renderer-only
package may use empty `schemes` and `entrypoint` arrays. Other manifest fields and
installation checks are unchanged. `blind plugin list` exposes registered components.
Choose explicitly with `--component example:table` or use extension detection:
longest matching suffix wins; equally specific matches fail with an explicit-choice
message. Built-in geometry suffixes are reserved. Bare JSON uses the JSON viewer when no
installed renderer matches. A plugin can provide an alternative display for a file
by using its own namespaced type; it cannot silently replace core code in the parent.

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


Resolver manifests can return `components` alongside legacy geometry `resources`,
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
including their position, opacity, labels and plugin content. It awaits text loads,
image decode, HTML load, fonts and each visible plugin's `ready` message. Failed
or timed-out components fail export explicitly. Hidden components are not awaited.
Legacy geometry scenes retain the native renderer; component groups use the Viewer
even when they contain only geometry, keeping automatic layout consistent.

Component-scene export requires Chrome/Chromium on the Server (included in the Docker
image), or `BLIND_RENDER_BROWSER=/absolute/path/to/chromium`. It starts an isolated
headless process with a temporary profile, bounded concurrency and a 75-second
limit. Export requests are restricted to the current scene and embedded Viewer
assets. The Docker deployment limits the whole service to 4 GiB; native Linux
services can use `systemctl --user set-property blind.service MemoryMax=4G`.
This is a service-wide limit, not a per-component JavaScript memory quota.
It never connects to a user's browser. The frame uses saved canvas dimensions.
HTML's load event cannot prove completion of arbitrary asynchronous application
code; use the plugin readiness protocol for such content.

Text renders as text, never HTML. JSON renders as a collapsible, escaped tree.
The JSON preview is limited to 4 MiB and 5,000 nodes; larger files remain available
through a link to the original attachment. Long string values are shortened in the preview.
HTML supports self-contained sandboxed documents with embedded data/blob images;
relative asset bundles are not expanded. CSS 3D surfaces share the camera with WebGL
but not its depth buffer, so they are not mesh-occluded geometry. Frame labels have
no external leader lines.

Blind has six built-ins: `mesh`, `points`, `text`, `json`, `html`, `image`. Order/task naming,
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
python3 tests/integration_components.py
```

Build the Viewer before Rust: the binary embeds `web/dist`. No private test order,
log, trace, generated link or local credentials belong in the repository.
