# Changelog

All notable changes to Blind are documented here. This project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-08-27

### Added

- A single macOS CLI and embedded mobile-first viewer for PLY, STL, and OBJ.
- Multi-Mesh scenes with unrestricted arcball rotation, pan, zoom, automatic
  fit, canonical views, visibility, color, opacity, shading, projection, axes,
  and gray themes.
- Six-character encrypted scene links backed by a bounded, expiring registry,
  plus explicit `blind share --stateless` long links.
- Immediate PNG links rendered on demand without a render cache.
- A shared, high-detail matte material model for interactive and offscreen
  rendering, with deterministic overlap handling and no background grid.
- Owner-only Complete information sharing with source paths and both links.
- Automatic Host discovery, PAT-protected scene creation, foreground and
  launchd service lifecycles, and Agent-friendly JSON output.

[0.1.0]: https://github.com/hx-w/blind/releases/tag/v0.1.0
