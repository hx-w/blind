# Changelog

All notable changes to Blind are documented here. This project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.17.0] - 2026-09-23

### Added

- Share independent scenes under one link with a collection config or JSON
  piped to `blind share --config -`.
- Show scenes side by side when space permits, or as tabs when one scene fills
  the available view; the shared toolbar acts on the focused scene.
- Share a view link that restores every scene and an image link that includes
  every scene in one labeled PNG.

### Changed

- Remove the viewer-wide fullscreen button and keep collection sharing in the
  bottom toolbar.

## [0.16.0] - 2026-09-23

### Added

- Inspect mesh relief with adjustable raking light or surface normals while
  keeping the existing shadowless appearance as the default; view and image
  links retain the chosen rendering settings.
- Copy the current image link with Cmd+C on macOS or Ctrl+C on other desktop
  systems; add Shift to copy the view link.
- Open ordinary JSON files in a collapsible, syntax-colored viewer.

### Changed

- Select a scene component with one click and expand it with a double click.
  Remove component fullscreen and drag-resize controls.
- Give the Render tool a Scan Eye icon and a compact mobile panel when light
  controls are hidden.

## [0.15.5] - 2026-09-22

### Fixed

- Keep the orbit pivot on the fitted mesh after double-clicking to isolate an
  element, so rotation, panning, projection switches and reopening shared
  scenes stay centered on it.

## [0.15.4] - 2026-09-21

### Fixed

- Keep rotation speed consistent after zooming or fitting large scenes, and
  prevent orthographic views from jumping during a drag.
- Show the name field immediately after drawing a screen brush stroke, matching
  point and line annotations.

## [0.15.2] - 2026-09-21

### Fixed

- Keep orthographic views from clipping nearby geometry when reopening or
  rotating a scene, and reset zoom on fit while preserving the viewing angle.
- Hide image and text surfaces behind foreground meshes and route clicks to
  the visible geometry.
- Keep long scene and annotation lists in separate scroll areas within the
  viewport.
- Let screen brush strokes keep editable notes in shared scenes and PNG exports.

### Changed

- Keep component positions fixed during dragging and keyboard navigation.
- Keep tests in CI and limit releases to cached native builds and publication,
  including Intel macOS.

## [0.15.0] - 2026-09-21

### Added

- Double-click a scene element to show it alone, or show and hide all elements
  with the scene tree's global controls, preserving visibility in shared scenes.

### Changed

- Float the scene tree over the canvas with a distinct background, wrapped names
  and inset scrolling edges that keep long lists readable.
- Remove the direction orb and its standard-view menu.

## [0.14.0] - 2026-09-20

### Added

- Arrange text, HTML, images, meshes and point contours in one scene with flat
  groups, a responsive element list, and shared visibility and presentation controls.
- Install plugin components with automatic file detection, isolated rendering and
  pinned versions that keep existing shares working after plugin updates.
- Export component scenes to PNG, including text and plugin content, using a
  Server-side Chromium installation.

## [0.13.2] - 2026-09-20

### Fixed

- Keep rear meshes and PTS loops hidden by foreground surfaces when rotating or
  zooming close to grouped scenes, in both the viewer and PNG exports.
- Light flat mesh back faces consistently with front faces in the viewer.
- Distinguish PTS contours from scan surfaces and annotations with saturated
  default colors, rounded highlights and dark edges.

## [0.13.1] - 2026-09-20

### Fixed

- Make the viewer annotation regression check cover stationary redraws without
  mistaking unchanged CSS positions for missed layout updates, and wait for
  responsive layout completion instead of a fixed delay.

## [0.13.0] - 2026-09-20

### Added

- Install Server-side share resolver plugins and invoke them from any connected
  Client with `blind share SCHEME://INPUT`, with grouped layouts and attachments.
- Update plugins from verified GitHub Release packages, including private
  repositories, while preserving configuration and existing scenes.
- Show incomplete scenes with persistent notices, readable remaining groups and
  unavailable-resource details; report empty and failed requests explicitly.

### Changed

- `blind status` now shows local Server state, the connected Server and installed
  plugins together; plugin-only Clients can register without SSH.
- Render PTS contours as smooth curves without sample spheres, with bounded LOD
  geometry and matching curve semantics in interactive views and PNG exports.

## [0.12.2] - 2026-09-20

### Added

- Set share-link lifetimes with `--ttl DAYS`: the default is 7 days, and 0 keeps
  links valid until their sources become invalid. Browser reshares inherit the
  lifetime setting, including permanent links with annotations.

### Fixed

- Let the selection tool rotate the scene or edit a mark, with colors always
  visible in the toolbar and no separate camera mode.
- Show annotation names directly on the canvas and open the list only when
  space allows. Closing the list preserves marks and labels; click a label to edit.
  Annotation labels use flat, muted colors in both the viewer and PNG exports.
- Update annotation labels in the same frame as camera movement, removing
  the delay while rotating a scene. Long lists stay within their scroll area.
- Keep selected Mesh and group captions legible in front of geometry while
  group frames and sibling Mesh labels retain their original layer.

## [0.11.0] - 2026-09-20

### Added

- Place points and draw smooth lines directly on visible Meshes, with editable
  names, colors, control points, and shared undo/redo alongside screen markup.
- Shared scenes preserve surface annotations and open their numbered list;
  image links include annotation names and Mesh labels, including Chinese text.

### Changed

- Annotation tools share a compact mobile-friendly dock, and opening Details or
  Info preserves mark visibility and the annotation list.

## [0.10.3] - 2026-09-19

### Fixed

- Dense scenes use compact group captions embedded in frame edges. Only the
  selected group member expands its individual label, without repeating the
  group name. Secondary labels yield when space is crowded, and camera motion
  rechecks label collisions on both mobile and desktop.

## [0.10.2] - 2026-09-19

### Fixed

- Keep the wireframe label interaction fixture in place across pointer-triggered
  renders, verifying clicks with an intervening frame on slower CI machines.

## [0.10.1] - 2026-09-19

### Fixed

- Make the same-size file replacement test independent of filesystem timestamp
  resolution so release validation is deterministic on Linux runners.

## [0.10.0] - 2026-09-19

### Added

- Private download domains using `--signing hmac-sha1-url --bucket BUCKET`.
  Credentials and signed URLs stay on the Server; aliases can switch between
  S3 APIs and download domains without changing scene addresses.

### Changed

- Every active registered Client can discover and share Server OSS aliases.
  OSS-only scenes do not depend on Client SFTP availability. Client revocation
  still invalidates its scenes.

### Fixed

- Mesh labels stay near their anchors with short leaders. Geometry covers
  ordinary labels; only the selected Mesh's labels render in front. Group
  labels remain clickable through empty canvas and wireframe openings.

## [0.9.0] - 2026-09-19

### Added

- `blind oss set/list/remove` manages private Server-side S3-compatible stores.
  `blind share` and scene configs accept `oss://ALIAS/BUCKET/KEY` alongside local
  meshes. Each resource selects its credentials by alias; Raw, LOD and PNG use
  bounded, signed reads without persisting geometry. Only the Server owner or
  a Server-local Client may create OSS shares.

## [0.8.0] - 2026-09-16

### Changed

- Server invitations are now permanent and reusable for trusted-team
  onboarding. `blind invite --revoke-all` rotates access without revoking
  existing registered sources, while cancelling pending registrations.
  Upgrading invalidates legacy temporary invitations.
- Scenes no longer have a 64-Mesh ceiling. LOD allocation now keeps a fixed
  150,000-primitive scene target down to one primitive per Mesh, so scenes with
  thousands of inputs do not grow the browser payload without bound.
- Interactive loads issue at most four Mesh requests at once, cap automatic Raw
  fallbacks to 64 MiB per scene, and keep successfully loaded Meshes visible
  when an individual source is unavailable.
- Cached LOD requests validate only the requested source metadata; cold LOD and
  Raw requests hash only the requested Mesh. This removes the previous
  whole-scene hash sweep before every Mesh request.
- LOD builds share a 512 MiB weighted working-memory budget using a conservative
  three-times-source-size estimate. PNG requests reject oversized visible input
  before reading it and no longer re-hash hidden Meshes after rendering.
- `blind share --config FILE` accepts a strict JSON manifest containing an
  ordered resource list, per-resource labels, and group labels with 1-based
  members. Relative resource paths resolve from the manifest directory, and
  detailed CLI help documents the full schema and conflicts.
- `--label` also accepts comma-separated indices such as
  `--label '2,3=Reference'`. Group labels render as selectable corner frames
  without per-vertex work, so they remain practical in large scenes.

## [0.7.1] - 2026-09-16

### Added

- GitHub releases now include a verified `blind-linux-x86_64.tar.gz` archive for
  native Linux servers, including NAS deployments that do not build Blind or
  run the Blind server in Docker.
- The installer, managed user service, and `blind update` flow now support
  x86_64 Linux with checksum verification, atomic replacement, restart health
  checks, and rollback behavior matching macOS.

## [0.7.0] - 2026-09-15

### Added

- Client/Server responsibilities separated behind one `blind` executable:
  `serve` on A, short-lived `join` and `share` commands on B/C.
- One-use invitation registration, independent OS-user credentials, pinned SSH
  host identity, and server-owned per-source SSH keys restricted to read-only SFTP.
- Direct local registration for the same OS user; no Client background service.
- Source host attribution in scene information and complete share text.
- Linux server locking and Docker/HTTPS deployment examples.

### Changed

- `blind status` now reports Client registration; use `blind server-status` for Server status.
- Remote source bytes feed LOD and PNG generation entirely in memory.
- Temporarily unavailable sources return 503 and survive doctor cleanup;
  confirmed source changes, deletions, and revocation return 410.
- `/s/`, `/i/`, `/v/`, owner capabilities and legacy local descriptors remain compatible.
- Restore static viewer assets when running without a base path.

## [0.6.1] - 2026-09-14

### Changed

- With `base_path` configured the app is now served only under the configured
  prefix; the root-level routes (`/s/{token}`, `/i/…`, `/api/…`, `/`) are no
  longer registered, keeping the root path free for other independent services
  behind the same host. Deployments without `base_path` are unchanged.

## [0.6.0] - 2026-09-14

### Added

- Optional `base_path` config field (e.g. `"/blind"`) so the whole app can be
  served under a sub-path behind a reverse proxy. The router is mounted under
  both the configured prefix and the root, so pre-existing `/s/{token}` share
  links keep working after enabling a base path. Share origins and discovered
  host candidates carry the prefix automatically.

## [0.5.1] - 2026-09-09

### Changed

- CLI help now recommends adding Mesh labels when sharing, with examples that
  explain input order, repeated labels, and the interactive-viewer scope.

## [0.5.0] - 2026-09-08

### Added

- Per-Mesh 3D labels in the interactive viewer, editable in Mesh details or
  supplied with repeated `--label INDEX=TEXT` CLI options. Labels follow their
  Mesh, keep a readable screen size, and persist in shared scenes.

### Changed

- Scene information now opens from the toolbar's information button and stays
  hidden by default. Multiline text and long words wrap on mobile and desktop,
  with independent scrolling for long notes.

### Fixed

- Mesh label placement remains stable during camera rotation, including when
  projected anchors cross the screen center or leave and re-enter the view.

## [0.4.4] - 2026-09-01

### Fixed

- Interactive and PNG views now preserve true front-to-back occlusion for
  overlapping Meshes without reintroducing coplanar flicker.

## [0.4.3] - 2026-09-01

### Added

- Vertex-only and zero-face PLY files now render as point clouds in both the
  interactive viewer and PNG links. Each point uses a circular, sphere-shaded
  GPU sprite instead of expanding the source into sphere triangles.
- Point-cloud LODs use bounded deterministic sampling, and `blind doctor`
  reports source and LOD point counts alongside triangle statistics.

## [0.4.2] - 2026-08-30

### Changed

- Cold LOD generation streams the source revision check instead of buffering
  the whole Mesh in memory, parses PTS once for both the Raw size and the
  preview geometry, and re-checks sources after simplification with the cheap
  length gate instead of a full scene hash sweep.
- LOD cache keys now encode the simplification profile, so any profile change
  invalidates cached entries automatically.
- The scene payload no longer carries a separate LOD URL — the viewer derives
  it from the Mesh URL — and LOD responses dropped informational headers
  without a client. The viewer picks its parser from the response content
  type instead of mirroring server container rules.

## [0.4.1] - 2026-08-29

### Added

- `blind doctor` now reports live LOD cache entries, resident memory against
  capacity, Raw-to-LOD payload savings, and source-to-LOD triangle counts.
- Offline doctor runs explicitly report that the process-memory LOD cache is
  inactive, while older running servers are identified as not exposing cache
  statistics.

## [0.4.0] - 2026-08-29

### Added

- The interactive viewer loads a server-generated LOD by default and lets each
  Mesh switch between LOD and Raw while reporting both payload sizes and the
  saved bytes and percentage.
- LOD geometry is generated on demand with meshoptimizer and retained only in
  a bounded 256 MiB process-memory cache. No derived Mesh is written to disk.
- Cold LOD loads report completed Mesh count and Raw fallbacks, with an explicit
  first-generation wait message for slower scenes.

### Changed

- Mesh selection, visibility, opacity, color, and Raw/LOD precision now live in
  one per-Mesh Details panel. The duplicate Mesh toolbar item was removed.
- Shared view snapshots now restore each Mesh's selected Raw or LOD quality;
  older links without the field continue to default to LOD.
- The single non-configurable LOD profile now favors bandwidth with a 150,000
  triangle scene budget, 2,000 to 50,000 triangles per Mesh, and 0.002 relative
  simplification error.

## [0.3.2] - 2026-08-28

### Added

- `blind doctor` now repairs safe config and SQLite invariants, verifies every
  stored short link against its encrypted payload and source revisions, and
  reports valid, expired, source-gone, tombstoned, and corrupt rows.
- `blind doctor --clean-invalid` removes invalid short links and
  `blind doctor --clear-all` clears the registry while the server keeps running.
- Registry key identity prevents a stale valid-looking config from turning live
  links into corrupt rows; a running server restores its authoritative key
  during doctor maintenance.

### Removed

- The public `blind key rotate` command. Blind keeps its internal scene key
  stable instead of exposing routine key maintenance that destroys all links.

## [0.3.1] - 2026-08-28

### Added

- `blind update` downloads the latest architecture-specific GitHub release,
  verifies its checksum and archive contents, and atomically replaces the
  current executable without sudo. Managed services are restarted and health
  checked, with automatic rollback if the new version does not become ready.

### Fixed

- Background-service installation waits for launchd's asynchronous unload and
  retries its transient bootstrap state, avoiding repeated-install
  `Input/output error` and `No such process` failures.
- Per-user service commands reject sudo instead of writing a root-owned plist
  and targeting the nonexistent `gui/0` domain.

## [0.3.0] - 2026-08-27

### Added

- Mobile-first screen markup with touch-locked drawing, four colors, undo,
  clear, encrypted view-link restore, and matching PNG composition.
- Host-aware browser sharing with an in-sheet address picker for every
  discovered local interface.

### Changed

- Screen markup disappears after camera framing changes so a 2D mark is never
  presented as though it followed the Mesh in 3D.
- Fast and interrupted pointer strokes retain their captured samples, and the
  committed path keeps the same curve geometry shown while drawing.
- Shared camera poses now preserve the rendered Arcball orientation after pan
  and rotation, while oversized PNGs scale both dimensions together.
- Matte Mesh lighting has stronger directional separation, restrained
  highlights, and subtle grazing-angle definition in both WebGL and WebGPU.
- Partially expanded mobile drawers remain scrollable and overlay a stable 3D
  viewport without resizing or flashing the WebGL drawing buffer.
- Generated viewer bundles are built by CI and releases without being stored
  in Git.

## [0.2.0] - 2026-08-27

### Added

- Denta PTS ring files as Mesh sources: ordered points render as a continuous
  tube with one sphere at every original point, capped at 4,096 points.
- Six-character encrypted scene links backed by a bounded, expiring local
  registry with an absolute seven-day lifetime, plus explicit
  `blind share --stateless` long links that write no registry row.
- A shared high-detail matte material definition consumed identically by
  interactive WebGL and offscreen WebGPU rendering, with deterministic
  overlap handling and no background grid.

### Changed

- One-finger rotation is an unrestricted arcball without polar limits.
- New scenes frame all visible Meshes automatically once the viewport is
  ready; captured camera and style state still restores exactly.

## [0.1.0] - 2026-08-27

### Added

- A single macOS CLI and embedded mobile-first viewer for PLY, STL, and OBJ.
- Multi-Mesh scenes with orbit, pan, zoom, fit, canonical views, visibility,
  color, opacity, shading, projection, grid, axes, and gray themes.
- Stateless encrypted view links that preserve camera and style state.
- Immediate PNG links rendered on demand without a render cache.
- Owner-only Complete information sharing with source paths and both links.
- Automatic Host discovery, PAT-protected scene creation, foreground and
  launchd service lifecycles, and Agent-friendly JSON output.

[0.4.4]: https://github.com/hx-w/blind/releases/tag/v0.4.4
[0.4.3]: https://github.com/hx-w/blind/releases/tag/v0.4.3
[0.4.2]: https://github.com/hx-w/blind/releases/tag/v0.4.2
[0.4.1]: https://github.com/hx-w/blind/releases/tag/v0.4.1
[0.4.0]: https://github.com/hx-w/blind/releases/tag/v0.4.0
[0.3.2]: https://github.com/hx-w/blind/releases/tag/v0.3.2
[0.3.1]: https://github.com/hx-w/blind/releases/tag/v0.3.1
[0.3.0]: https://github.com/hx-w/blind/releases/tag/v0.3.0
[0.2.0]: https://github.com/hx-w/blind/releases/tag/v0.2.0
[0.1.0]: https://github.com/hx-w/blind/releases/tag/v0.1.0
