# Agent Instructions

These instructions apply to the entire repository. MUST and MUST NOT are mandatory requirements; SHOULD denotes a recommendation.

## Product Scope: Observation and Control

Blind provides shared observation of source artifacts and explicit control of their review state and the Blind service. It is one Rust crate and executable with an embedded browser viewer. The CLI is the canonical agent interface; use `blind --help`, `blind share --help`, and JSON output rather than inventing a parallel integration contract.

### Observation

- Blind displays geometry and supporting documents, including Markdown, JSON, images, logs, diagrams, and configured components. It supports camera navigation, rendering modes, sections, measurements, annotations, and captured view or PNG links.
- Observation is tied to source identity and revision. MUST preserve source validation, link lifetime, and invalidation rules. A shared view is not an independent archival copy of its inputs.
- Measurements use source coordinates. MUST NOT assume physical units, treat an LOD as exact source geometry, or imply that visual inspection certifies source correctness.
- Original source files remain on their source machine or object store. MUST NOT introduce source writes or persistent source copies as a side effect of viewing, rendering, or annotation.

### Control

- Review control covers camera and projection, visibility, opacity, labels, annotations, reading state, and other documented scene settings. Sharing captures a new immutable snapshot; it MUST NOT mutate an existing link or the original artifact.
- Service control covers the documented registration, sharing, plugin management, and authorized health, stop, and registry-maintenance operations. MUST preserve each operation's credential and authorization boundary.
- A public scene capability permits reading that scene and creating a new review snapshot. It does not grant source-file write access or administrative control. The separate owner capability exposes complete source information; it is not the server PAT.
- Blind is not a general-purpose remote shell, source editor, CAD modeler, or autonomous workflow executor. MUST NOT add arbitrary command execution, source mutation, or unrelated automation under the label of observation or control without an explicit product requirement and security review.

### Trust Boundaries

- Remote source access uses read-only SFTP. This permits reads under the registered OS account, not a directory sandbox. OSS access follows configured storage credentials and authorization.
- Native plugin resolvers are trusted installed programs running with the host user's privileges, not sandboxed viewers. Browser components run in isolated sandboxed frames with scoped source bytes and messaging. Client renderer snapshots MUST NOT become a path for executing uploaded native code on the Server.
- MUST keep PATs, source credentials, plugin settings, and owner capabilities out of public scene metadata, public links, logs, and committed fixtures. MUST NOT broaden an observation capability into a control capability.

The detailed contracts are in [CLI](docs/cli.md), [sharing](docs/sharing.md), [API](docs/api.md), [viewer](docs/viewer.md), and [security](SECURITY.md). Check these before changing behavior; update the relevant contract when an authorized change alters it.

## Architecture and Separation of Concerns

Follow [repository architecture](docs/architecture.md) for module ownership and dependency direction. Directories define responsibilities within one crate, not separate services.

| Subsystem | Responsibility |
| --- | --- |
| `src/cli/` | Command parsing, prompts, dispatch, manifests, terminal presentation |
| `src/client/` | Outbound HTTP, registration, local client configuration |
| `src/server/` | Inbound HTTP, authorization, admission, scene orchestration |
| `src/protocol/` | Shared client/server wire contracts |
| `src/scene/` | Scene descriptors, validation, persisted review semantics |
| `src/geometry/` | Geometry decoding, derived LOD generation and cache |
| `src/render/` | GPU rendering, browser capture, labels, collection images |
| `src/plugin/` | Package integrity, installation, resolvers, renderer declarations and snapshots |
| `src/storage/` | Source access, OSS, archives, registry, encrypted tokens |
| `src/runtime/` | Host configuration, private files, identity, services, updates |
| `web/` | Browser presentation and interaction |

- MUST keep parsing and presentation separate from domain operations. Shared operations accept data and paths, not parsed CLI command enums.
- MUST keep outbound Client code separate from inbound Server handlers. Neither imports the other; shared wire types belong in `protocol`.
- MUST keep persisted scene semantics independent of HTTP handlers, plugin execution, and storage adapters in production code. Request orchestration belongs in `server`, not `scene`.
- MUST keep geometry processing separate from rendering, and target-specific rendering adapters separate from scene handling. Reuse shared scene state and material definitions instead of maintaining divergent contracts.
- MUST give each concern one clear owner. Extend the owning subsystem rather than adding catch-all utilities, root-level helpers, hidden cross-layer state, or duplicate implementations.
- Refactors MUST migrate affected callers and remove obsolete code, aliases, and redundant paths. MUST NOT introduce speculative abstractions or retain legacy architecture merely to keep old tests passing.

## Test Quality and the Pre-Commit Gate

Tests protect observable behavior, boundaries, and invariants. Test count and coverage percentage are not reasons to add tests.

### Adding or Changing Tests

- Before adding a permanent test, identify the concrete consumer-visible failure it would detect and why existing coverage does not detect it. Extend an existing test when it can cover the risk clearly.
- Add tests for meaningful behavior, failure handling, authorization, state transitions, source identity, or boundary conditions. A regression test SHOULD fail on the original defect and pass with the fix.
- MUST NOT add trivial tests: tautological assertions, bare "does not throw" checks, source-text matching, implementation-detail snapshots, wiring-only checks, or mocks that merely echo their inputs. A successful status or nonempty result alone is insufficient when the behavioral result can be asserted.
- MUST NOT add or retain redundant cases, duplicate coverage without a distinct failure mode, or legacy tests that pin obsolete behavior, compatibility paths, wording, or incidental defaults. A test's age alone does not make it obsolete; a meaningful regression guard remains valid.
- Tests MUST be deterministic, isolated, and safe in the full suite. Keep subsystem tests with their implementation; place real process/API flows in `tests/` and browser flows in `web/tests/`.
- Documentation-only changes MUST NOT create tests that assert the documentation's text. Use direct document checks instead.

### Mandatory Review Before Every Commit

Before committing, MUST review the entire repository test suite, not only tests touched by the change. This includes Rust tests under `src/`, integration tests and fixtures under `tests/`, viewer unit tests under `web/src/`, and browser tests under `web/tests/`.

1. Inventory the test cases and identify the behavior or invariant each protects.
2. Check all cases for trivial assertions, obsolete contracts, redundant coverage, ineffective mocks, nondeterminism, and unnecessary fixtures or scaffolding.
3. Remove trivial and obsolete tests; consolidate redundant cases while preserving distinct failure modes. Update affected tests to the current contract rather than restoring obsolete implementation solely to satisfy them.
4. Run the applicable checks after any test cleanup. Record the review scope, removals or consolidations, retained coverage rationale, and actual verification in the delivery or commit notes. Do not create a separate audit document unless requested.

Passing tests do not replace this review. MUST NOT commit while trivial, obsolete legacy, or redundant tests identified by the review remain unresolved. MUST NOT claim a whole-suite review when only a subset was examined.

## Release Versioning

- MUST obtain explicit user authorization before publishing a new major version. Breaking implementation changes alone do not authorize a major release.
- Unless a major release is explicitly authorized, publish feature releases as minor versions and bug-fix-only releases as patch versions within the current major series.
- MUST keep the Cargo package, browser package, changelog, release tag, and published assets on the same version.
- MUST disclose any destructive data cutover and obtain authorization for its exact scope before deployment. Version selection does not authorize deleting links, registrations, configuration, or source files.

## Verification and Delivery

- Read the relevant implementation and contracts before editing. Keep changes within the requested scope and preserve unrelated work.
- For behavior changes, exercise the actual CLI, API, rendered output, or browser interaction affected by the change. Observe the result; compilation and mock-based tests alone are insufficient evidence.
- Follow [development checks](docs/development.md) and CI for the applicable unit, browser, integration, formatting, and lint checks. Build the viewer before invoking Cargo because the executable embeds `web/dist`; generated assets MUST NOT be committed.
- Update affected callers, tests, and documentation together. Remove temporary verification scripts and obsolete scaffolding before delivery.
- Report only checks actually performed and results actually observed. State missing prerequisites and unverified behavior explicitly; do not describe incomplete work as complete.
