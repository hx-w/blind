# Repository architecture

[Documentation](../README.md#documentation)

Blind remains one Rust crate and one executable, with an embedded browser viewer.
Directories express ownership within that crate; they are not separate services.
The CLI, HTTP routes, saved configuration, scene schema, and share URL formats are
unchanged by the module reorganization. Rust module paths now follow these
subsystems; the former root-level module paths are not compatibility aliases.

## Repository map

```text
src/
  main.rs              Tokio entry point; calls cli::run
  lib.rs               Declares subsystem boundaries
  cli/                 Clap commands, prompts, input manifests, terminal output
  client/              Outbound HTTP, registration, local client configuration
  server/              Inbound HTTP, authorization, admission, scene orchestration
  protocol/            Shared registration and control API contracts
  scene/               Scene/component descriptors, validation, view state
  geometry/            Geometry decoding, derived LOD generation and cache
  render/              GPU rendering, browser capture, labels, collection images
  plugin/              Package validation/install, resolver execution, renderers
  storage/             Source access, OSS, archives, registry, encrypted tokens
  runtime/             Host configuration, private files, identity, services, update
web/                   TypeScript viewer and browser tests
shaders/               Material and stroke definitions shared across renderers
assets/fonts/          Font embedded by the image renderer
tests/                 CLI/server integration tests and source fixtures
deploy/                Container, proxy, and deployment configuration
docs/                  Product and developer documentation
```

## Dependency direction

```text
main -> cli -> client ----------------------> protocol
           -> server -> scene / geometry / render / plugin / storage
           -> plugin / storage / runtime / render

client -> protocol / runtime / storage
protocol -> scene / geometry
render -> scene / geometry
plugin -> scene / storage / runtime
storage -> scene / protocol / runtime
geometry -> scene
```

The diagram describes production dependencies. Some scene serialization tests
also exercise the storage token codec. The Client uses source ID validation and
OSS discovery types from storage, but does not invoke storage operations to
contact the Server.

- `cli` owns Clap, command dispatch, prompts, and presentation. Plugin resolution
  and OSS reads do not call CLI or Client commands. Shared operations accept
  data and paths rather than parsed command enums.
- `client` sends requests; `server` handles requests. Neither imports the other.
  The local-owner control HTTP client lives in `client/control.rs`; inbound
  health, stop, and doctor handlers live in `server/control.rs`.
- `protocol` owns data crossing the client/server boundary, including registration
  and control reports. It has no HTTP handlers or command parsing. Registry audit
  conversion is implemented with the registry, not in the wire contract.
- `scene` owns persisted scene semantics, including source identity, warnings,
  renderer bindings, and archive member path validation. It does not depend on
  plugin execution, HTTP, or storage adapters in production code.
- `runtime` contains host facilities. Shared private-file operations and OS
  identity do not belong to Client or source storage.

## Server ownership

`server/mod.rs` assembles state, routes, middleware, and listener lifecycle.
Its child modules stay private to the HTTP adapter:

| Module | Responsibility |
| --- | --- |
| `registration.rs` | Join, activate, revoke, local registration, discovery |
| `sharing.rs` | Owner/client share and collection request orchestration |
| `scenes/` | Assemble scenes from source paths or resolver manifests |
| `assets.rs` | Serve attachments and pinned plugin renderers |
| `view.rs` | Scene/mesh/LOD viewing, resharing, images, embedded viewer |
| `access.rs` | PAT/client capability checks, scene access, source invalidation |
| `dto.rs` | HTTP-only request and response shapes |
| `state.rs` | Shared application state and admission budgets |
| `links.rs` | Public link construction and origin selection |
| `error.rs` | HTTP error translation |
| `lease.rs` | Exclusive server/offline-maintenance lease |
| `control.rs` | Inbound health, stop, doctor, host discovery |

`server/scenes` intentionally remains server orchestration: it uses the registry,
plugin bindings, and shared memory admission. Scene descriptors and validation
live in `scene`; request-specific state does not move into that model layer.
There is no `server/client` module: client-facing endpoints are server routes,
not the outbound Client implementation. Dependencies between production server
modules use explicit imports instead of `use super::*`.

## Placement rules

Keep related implementation files under their owning subsystem. Add a nested
directory only for a cohesive concern with multiple implementation files, such
as source-based and manifest-based scene assembly. Avoid root-level helper files,
catch-all utility directories, path overrides, and aliases for obsolete layouts.
Keep tests with their implementation unless they exercise real process/API flows;
those belong in `tests/` or `web/tests/`.

GPU-specific code and WGSL live together in `render/`; shared material JSON stays
in `shaders/` because both Rust and TypeScript consume it. The browser app remains
in `web/`, and its generated `dist/` is embedded using a repository-relative path.
Build the viewer before Cargo. See [development checks](development.md).
