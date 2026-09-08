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

Scene information is hidden by default and opens through the dock's information
button. It shares the details panel with Mesh controls. On phones, the four dock
actions stack their icon above their label to fit narrow screens. Scene messages
wrap and scroll inside the panel, with the close control and statistics visible.

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
- "Add a screen-markup action using a pointer-blocking canvas, 4.25px round ink, a 7px dark separation edge, four high-contrast colors, and a compact two-row layout below 360px."
