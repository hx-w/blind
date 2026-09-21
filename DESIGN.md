# Blind interface system

## 1. Visual theme and atmosphere

Blind is a quiet engineering inspection surface. The mesh is the only visual anchor; controls recede into graphite or soft gray planes with one restrained blue accent.

## 2. Color palette and roles

- Canvas dark: `oklch(0.22 0.008 255)`
- Canvas light: `oklch(0.93 0.008 250)`
- Elevated dark: `oklch(0.27 0.009 255)`
- Text dark: `oklch(0.91 0.008 255)`
- Text light: `oklch(0.25 0.009 255)`
- Accent: `oklch(0.70 0.14 250)`
- Danger: `oklch(0.67 0.15 28)`

The 60-30-10 ratio controls visual weight. It is not explained in product copy.

## 3. Typography

Use the native San Francisco family with PingFang SC fallback. Blind is a dense tool, not a display surface. UI text runs from 11 to 16px, with tabular numbers for counts and percentages.

## 4. Components

Buttons use a 10px radius and 42px minimum hit target. The bottom dock uses a 16px outer radius. Press feedback is a 0.96 scale. The share action opens a focused action sheet with three explicit outputs. Brush mode replaces the dock with a compact color-and-action tool strip; its ink uses a 4.25px round stroke over a restrained 7px separation edge.

## 5. Layout

The canvas is full bleed. On phones, the bottom dock remains persistent while a docked sheet changes the usable 3D viewport. On landscape and desktop, settings move to a 340px right sheet.

The scene tree and annotation list share an upper-right stack bounded by the viewport and bottom tools.
The annotation list reserves up to 45% of that height; the scene tree shrinks into the remaining space.
Their headers stay visible and each list scrolls independently. Long lists never push either pane offscreen.
The scene tree floats over the canvas without reserving a column or
painting a full-height background. Its height follows its content up to the space
above the bottom dock, capped at 65dvh. Its opaque backing is lighter than the canvas, with a fine outline and soft
shadow to establish a floating surface. It occludes geometry and labels without
text shadows or individual text backgrounds. Only the list scrolls; its heading stays visible. Long names wrap,
and selection uses accent text with a quiet neutral row tint. Opening or closing
the tree never resizes the canvas. Do not show a direction orb or view menu.
Keep Show All and Hide All above the scrolling list. Double-clicking an element
shows and focuses it while hiding every other element across all groups and types.
Visibility changes preserve nonzero opacity; showing a fully transparent element
restores its opacity so it is actually visible. These states travel with shares.
Inset the scrolling list from the rounded pane edge. Fade only edges with more
content offscreen; remove the fade at each scroll limit so the first and last rows
remain fully readable. Keep the header and global actions outside the fade.

Scene information is hidden by default and opens through the dock's information
button. It shares the details panel with Mesh controls. On phones, the four dock
actions stack their icon above their label to fit narrow screens. Scene messages
wrap and scroll inside the panel, with the close control and statistics visible.

Labels share one visual grammar. A one-Mesh label uses a leader and attachment
dot, with short leaders placed near their attachments instead of beyond Mesh
bounding boxes. Ordinary labels and their leaders sit behind geometry; only
labels for the selected Mesh sit in front. A group caption interrupts the edge
of a restrained corner frame around its projected union, without a separate
card or leader. Its type stays at 11px even on narrow screens. The frame never
fills or tints the geometry, and selecting its caption fits the whole group.
Group captions identify their members; only the selected member expands its
individual label, omitting an exact repeated group prefix. The selected Mesh
gets placement priority. Other captions appear only where they fit without
overlapping labels or controls; camera movement rechecks cached placements.
Full Mesh names remain available in the detail panel.

## 6. Depth

Depth comes from background lightness steps and restrained shadows. No blur glass, decorative gradients, or hard card outlines.

## 7. Guardrails

- Never show Solo.
- Never put the selected mesh name in the global dock.
- Do not narrate palette decisions in UI copy.
- Do not bind product language to a network vendor.
- Do not use pure black or pure white.
- Keep view, image, and full-info sharing as separate choices.
- Brush mode must fully intercept pointer input so drawing never rotates the scene.
- Screen markup must disappear as soon as camera framing changes.

## 8. Responsive behavior

Phone mesh sheets use content height up to 52dvh. Style sheets snap to 44dvh and 82dvh. Content scroll begins only at the expanded detent. Landscape and widths above 760px use a right sheet. Safe-area insets are respected. Below 360px, the brush strip becomes two compact rows so every target remains at least 40px.

## 9. Agent prompt guide

- "Add an icon action using a 42px hit area, 10px radius, graphite surface, and 0.96 press scale."
- "Add a mobile sheet using 44dvh and 82dvh detents, 16px top radius, no blur, and a 48px drag header."
- "Add a selected row using only an accent dot and surface lightness step, without a decorative side rail."
- "Add a screen-markup action using a pointer-blocking canvas, 3.2px round ink, a subtle 3.8px separation edge, four high-contrast colors, and a compact two-row layout below 360px."

## Surface annotation interaction

The annotation action opens one selection, point, line and screen-brush dock.
Keep two persistent tool rows; reveal the color palette on demand and name/line
controls only for a selected mark. Newly created points and completed lines stay
selected so their name field remains editable. Never autofocus a phone keyboard.
Do not expose a target-Mesh picker: the nearest visible hit determines ownership.
Release a dragged stroke to finish it; the next stroke naturally creates another.
Only click-to-connect drafts need an explicit Finish Line action.

The separate annotation list covers all visible Meshes and screen strokes. Canvas
numbers match list rows. Open the list by default when a shared scene contains
annotations, without entering drawing mode. Selecting a row highlights the mark and brings obscured
surface marks into view. A compact sheet above the dock on phones and a right
panel on desktop keep the mesh primary. All actions retain 42px touch targets.
Opening tools and lists never resizes the scene canvas. Details and Info move
beside the open annotation list rather than hiding the list or canvas badges.

Use the shared 3.2px ink width for screen and surface lines. Surface ribbons lie
on local tangent planes, avoiding clipping on slopes. Do not add tube lighting,
gloss, glow or heavy dark outlines. Only selections show pale emphasis and handles.
Smooth curves are sampled onto the visible surface; invalid smoothing preserves
the valid path. Never refit a shared path on load. Camera navigation is explicit;
interrupted touches roll back the current surface gesture. Screen strokes retain
their view-dependent behavior, with shared undo history cleared of obsolete views.

Screen brush strokes support the same editable names as surface marks; names survive undo, sharing, reopening, and PNG export. Unnamed strokes keep their numbered fallback.

Component positions are fixed during review, including meshes, images, text and plugin surfaces. Preview and header drags navigate the camera; there are no position drag handles or Alt/arrow movement shortcuts. Explicit positions and automatic initial layout remain part of scene loading.

Spatial content keeps its native DOM opacity. Parallel XY content planes interleave with GPU-clipped geometry bands, copied through one WebGL renderer into canvas layers. Empty bands allocate no bitmap; hidden content stays connected to preserve plugin state. Pointer routing tests painted geometry coverage, including wireframe gaps, and preserves the full pointer lifecycle for mesh selection.
