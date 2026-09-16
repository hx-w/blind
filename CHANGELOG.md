# Changelog

All notable changes to Blind are documented here. This project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.7.1] - 2026-09-16

### Added

- GitHub releases now include a verified `x86_64-unknown-linux-gnu` archive for
  native Linux servers, including NAS deployments that do not build Blind or
  run the Blind server in Docker.

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
