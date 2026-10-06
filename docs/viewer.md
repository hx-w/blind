# Reviewing a scene

[Documentation](../README.md#documentation)

Inspect geometry and read its supporting documents in the same scene. View and
image links preserve the review state without changing the original files.

## Navigate and select

- Auto chooses a DOM 2D board for planar-only scenes; geometry or spatial content
  uses the spatial viewport. The board creates no WebGL/Arcball/CSS3D renderer.
- Primary drag rotates in spatial mode and pans in board mode. Two fingers
  pinch to zoom and move together to pan; board zoom stays anchored to the pointer.
- Fit frames visible world entities. Fixed sidebar panels never affect framing.
- The scene list places rename, opacity and visibility controls on each entity row.
  Mesh and PTS rows show their color before the name; click it to choose a
  preset below the row. Long names show their beginning and end; 信息 reveals
  the full name in a scrollable area. Mesh quality sits in the
  scene list's 信息 tab.
- Each Mesh loads as LOD by default. 信息 can switch it to Raw without
  changing the camera and reports Raw size, LOD size, saved bytes, and the
  saving percentage.
- Shared view snapshots preserve the selected Raw or LOD quality for every Mesh.
- The first cold load shows completed Mesh count while the server generates
  LODs. At most four Meshes are requested concurrently, and a single large Mesh
  remains indeterminate until meshoptimizer returns. Individual failures are
  reported without discarding Meshes that already loaded successfully.
- Vertex-only or zero-face PLY files render as circular GPU point sprites with
  sphere-like lighting. They are not expanded into sphere triangle Meshes.
- PTS rings render as smooth, continuous curves through the original ordered samples, without point markers.
- The 观察 dock controls surface mode, projection, axes, and the gray background
  theme.
- Annotation → Screen brush enters a touch-locked screen-markup mode with four high-contrast
  colors, undo, and clear. Strokes can cross Meshes and empty canvas space.
- Screen markup belongs to the captured view. Any later rotate, pan, zoom,
  Fit, canonical-view, or projection action hides it immediately.
- On phones, the scene list opens from the scene icon and keeps the 3D viewport
  stable while switching between elements and information.

The global toolbar never assigns one Mesh name to a multi-Mesh scene and does
not duplicate visibility with a Solo mode.

## Reading documents and other surfaces

Text, Markdown, JSON, images and vector diagrams are interactive inside both
board and spatial scenes. Drag or scroll the body to read; one finger scrolls
and two fingers navigate the viewport. Body gestures never become viewport
gestures at a scroll boundary. Titles and empty scene space retain navigation.
Board zoom changes the affine projection and screen-sized chrome, not the
native source layout or reading anchor.

Use **全屏**, or double-click noninteractive body space or the title to expand.
Escape or **返回场景** returns to the same source target, including reading
continued in the expanded view and layout changes on another device. The content
is the same DOM, not a second preview. HTML and Perfetto retain their isolated
frame interaction after expansion.

**更多 → 选择文字** enables normal selection/copy. The same menu offers focus,
content annotation, screen brush, image/diagram zoom and genuine diagram groups.
Content marks attach to source text, image coordinates or semantic graph targets;
camera navigation does not erase them. While annotating, arrows position the
cursor and Enter creates a point or completes line endpoints; Escape closes the
annotation tools. Names, colors, delete, undo and redo are contextual controls.

Surface sizes and entity positions come from the share configuration. Dragging a
surface title navigates the scene; it does not move or resize the surface.
See [components and layout](components.md#groups-and-layout).

`placement: "panel"` keeps a component in a fixed sidebar outside the world
layout. Its body owns native input and remains fixed while panning or zooming;
the host reserves sidebar space from scene controls. Placement is independent
of focus/fullscreen presentation and survives sharing.

Agents and components use the [public operation catalog](components.md#public-operations)
for the same controls. Typed operations cover native reading and review tools;
unsupported geometry actions remain explicitly unavailable on a board.

On macOS, Cmd+C copies an image link and Cmd+Shift+C copies a view link.
Use Ctrl on other desktop systems. Text selections and editable fields retain
their normal copy behavior. Sharing preserves camera, labels, positions, surface
sizes, visibility, opacity, source-anchored reading and content annotations.
Screen brush remains a distinct temporary view annotation: camera changes or
content scrolling, zoom, layer changes and reading-window changes clear it.
See [links and lifetimes](cli.md#links-and-lifetimes).

The scene list opens by default when the viewport is at least 1100 pixels wide
and 600 pixels high. Hiding an entity preserves its opacity setting. Raising
opacity above zero makes it visible; showing a zero-opacity entity restores
full opacity.

## Labels

In the interactive viewer, select a Mesh in the scene list and use the small
rename button after its name to edit its label.
Labels use a small leader and an attachment dot, follow the Mesh in 3D, and keep
a readable screen size as the camera moves. Placement prefers space outside
Mesh bounds and avoids other labels and controls where space permits.
During camera motion, each label retains its placement
relative to its projected anchor so it does not jump between sides. Hidden
Meshes hide their labels. Clear the text to remove a label; share the current
view to save edits in a new link. Existing links keep their original labels.
Group labels draw a restrained corner frame around visible members and can be
selected to fit the whole group. Per-Mesh labels can coexist with group labels.
Each label accepts up to 120 characters. View and image links include visible
Mesh and group labels, along with screen and surface annotations.

## Observation tools

观察 opens a second dock ordered by 着色, 光照, 投影, 场景, 剖面.
Each category expands its controls inside the dock; 剖面 starts drawing. 场景 contains axes and background switches. Raking-light angles and
strength appear below the tools only when relevant. 返回 restores the main dock. The chosen mode and light settings
are saved in view and image links. Shading remains independent of lighting:
a wireframe stays a wireframe under all three lighting modes.

### Sections

剖面 starts from the selected visible triangle Mesh. Clicking the tool directly
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

## Surface annotations

Open **标注** in the bottom dock to start with **画笔**. Choose **点** or **线** for
surface marks. Points follow the
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

## LOD and source formats

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

For PTS, Blind accepts Denta's `BEGIN`/`END`, numbered marker variants, and
bare finite `x y z` rows. The ordered points form a closed ring;
`SELECTION_SEED` metadata is retained in the source but is not rendered. Blind
derives a mobile-visible tube width from the ring bounds and limits
one PTS resource to 4,096 points.
