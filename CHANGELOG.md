# Changelog

All notable changes to Blind are documented here. This project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[0.2.0]: https://github.com/hx-w/blind/releases/tag/v0.2.0
[0.1.0]: https://github.com/hx-w/blind/releases/tag/v0.1.0
