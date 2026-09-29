# Build and contribute

[Documentation](../README.md#documentation)

Use Rust stable, Node.js 24, and npm, matching the CI toolchains.

```sh
npm ci --prefix web
npm run build --prefix web
cargo build --locked --release
```

The installed binary embeds the generated `web/dist` and does not require
Node.js. The directory is intentionally excluded from version control. Before
a pull request, run:

```sh
npm test --prefix web
npm run test:browser --prefix web
cargo fmt --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked
```

Pull requests and main-branch pushes run CI checks. A stable tag must pass the
same verification before the Release workflow builds the viewer and native
binaries, packages the three archives, generates SHA-256 checksums, and publishes
the GitHub Release. Run local checks before tagging too. The first build, a
toolchain change, or cache eviction can still require a cold compilation.

The [CI workflow](../.github/workflows/ci.yml) also runs collection, component,
plugin and OSS integration tests. Component and collection exports require
Chrome/Chromium; see [component verification](components.md#verification).
The [release workflow](../.github/workflows/release.yml) publishes macOS ARM,
macOS Intel and Linux x86_64 archives with `SHA256SUMS`.

See [the changelog](../CHANGELOG.md) for released changes and
[security reporting](../SECURITY.md) for vulnerability reports.

## Code organization

See [repository architecture](architecture.md) for subsystem ownership, dependency
direction, and where to place new code.

## Rendering internals

Interactive WebGL and offscreen WebGPU use the same matte material definition,
color-space rules, camera state, deterministic overlap bias, and light model.
The target-specific GLSL and WGSL adapters are isolated from scene handling so
future material definitions can be added without coupling them to the viewer.
The browser draws screen markup in a dedicated 2D layer. The image renderer
composites the same normalized strokes after the 3D pass, so a view link and
its image link show the same captured marks.
