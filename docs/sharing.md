# Sharing contract

Blind sharing is encrypted and ephemeral. Every Mesh remains owned by its source path on the host.

## Link forms

```text
http://host/s/<6-char-code>
http://host/i/<6-char-code>.png
```

The viewer URL restores an interactive scene. The image URL performs a fresh offscreen render and returns `image/png`. Both derive from the same scene snapshot.

## Descriptor

The encrypted descriptor contains:

- Schema version, title, and creation time.
- Canonical source path, format, byte size, and SHA-256 revision for every Mesh.
- Registered source ID, hostname, OS user and display name (optional for legacy local scenes).
- Visibility, selected Mesh, color, and opacity.
- An optional label per Mesh: `{"text":"供体 A","anchor":[0,1,2]}`.
  Text is limited to 120 characters; the optional anchor is a finite world-space
  point. Omitting it attaches the label to the Mesh bounds center.
- Optional labels spanning multiple Meshes: `{"text":"参考牙","meshes":[0,1]}`.
  Mesh indices are zero-based in the descriptor and must contain at least two
  unique, valid members.
- Camera position, target, up vector, field of view, zoom, projection, and orthographic height.
- Captured frame dimensions.
- Surface mode, axes, and gray background mode.
- Screen strokes as a color, capture aspect ratio, and bounded normalized
  points. A scene permits 64 strokes, 512 points per stroke, and 4,096 points
  in total.

The registry payload never contains a PAT or Mesh bytes. XChaCha20-Poly1305 encrypts and authenticates the compressed descriptor before SQLite receives it.

## Public and owner capabilities

The public scene code can read the exact source revisions and create another public snapshot with a changed camera or style. Public scene responses expose file names and source host/user attribution, but not absolute paths or SSH/API credentials.

An independent six-character owner secret is placed in the URL fragment of `owner_url`. The browser stores it only for the current session and removes it from the visible URL. Public links copied from the share sheet never contain this capability. It authorizes the Complete information option, which copies canonical source paths plus the view and image links.

## Exact restore

New scenes run Fit against the joint bounds of all visible Meshes after the viewport is ready. Camera pose and styling in a captured scene restore exactly and do not run Fit again. The captured vertical framing remains stable across aspect ratios, while a different device may reveal more or less content horizontally.

Screen markup is tied to that exact camera framing rather than Mesh geometry.
It can cross empty space and remaps across viewport aspect ratios. The first
rotate, pan, zoom, Fit, canonical-view, or projection action hides all marks in
that browser session; reloading the immutable link restores the snapshot.

Mesh labels stay attached as the camera changes. The interactive viewer projects
their anchors into screen space and lays out readable text with a leader and
attachment dot. Hidden Meshes and anchors outside the camera view hide their
labels. Label placement adapts to the viewport and available space; text and
world-space anchors are preserved in both registry and stateless scene records.
Labels spanning multiple Meshes draw a low-obstruction corner frame around the
visible members. Their label is selectable and fits the camera to the group.
PNG rendering currently does not draw Mesh labels.

For API clients, scene creation accepts an optional `labels` array parallel to
`paths`, containing label objects or `null`. Scene/share Mesh entries expose a
`label` field. In a share update, omit `label` to preserve it, send a label object
to replace it, or send `null` to remove it. Editing and sharing creates a new
snapshot; the original link is unchanged.
Scene creation also accepts `label_groups`, an array of `{text, meshes}` objects.
The CLI exposes both cases through one repeatable option: `--label '1=牙冠'`
for one Mesh and `--label '1,2=参考牙'` for a group.

For large resource sets, `blind share --config FILE` reads this strict schema:

```json
{
  "title": "optional scene title",
  "resources": [
    { "path": "required/path.ply", "label": "optional per-Mesh label" }
  ],
  "groups": [
    { "label": "group label", "members": [1, 2] }
  ]
}
```

`resources` is required and non-empty. `groups` is optional; unlike the
encrypted descriptor, its `members` are 1-based to match CLI indices. Relative
paths resolve from the config file directory. Unknown fields are errors.

## Lifecycle

1. The registered Client submits file paths. The Server canonicalizes and hashes the source through read-only SFTP, or the local filesystem for a same-user local registration.
2. The daemon encrypts the compact descriptor and registers a random six-character public code plus an independent owner secret. It stores no Mesh copy.
3. Viewer metadata and reshare requests verify that the registered source is
   still active. A Raw or cold-LOD request reads and hashes only its target
   Mesh. A cached LOD request checks the target's canonical path, size, and
   modification time instead of scanning the whole scene.
4. A confirmed deletion, revision change or source revocation returns `410 Gone`. An offline host, timeout, host-key mismatch or denied access returns `503 Service Unavailable` without tombstoning the scene. Doctor retains temporarily unavailable scenes.
5. A link expires absolutely seven days after its first registration. Registering an identical active scene reuses its code and does not extend that lifetime.
6. The registry permits 10,000 active scenes and at most 12,000 total rows. Expired and invalid tombstones are pruned and SQLite reuses released pages.
7. Restarting the server does not invalidate active links because the registry and scene key persist in the user configuration.
8. `blind doctor` audits the registry, `--clean-invalid` removes invalid short
   links, and `--clear-all` removes every short link without stopping the
   server.

The interactive viewer reports unavailable Meshes and retains successfully
loaded ones, so one failed source does not throw away a large review scene.
Unknown short-code requests are rate limited per client. `blind share
--stateless` remains available for a long, self-contained `/v/` link that
writes no registry row.

## Instant image rendering

The image route:

1. Decrypts and validates the descriptor.
2. Parses all visible PLY, STL, OBJ, and PTS sources. Vertex-only PLY uses
   sphere-shaded point sprites; PTS rings use one shared generated
   tube-and-sphere triangle representation in both render paths.
3. Rebuilds the camera, shared matte material, colors, deterministic overlap bias, and axes.
4. Renders with the host graphics adapter into an offscreen texture.
5. Composites the captured screen strokes with anti-aliased round joins and
   the same display widths used by the browser.
6. Encodes PNG in memory and releases request resources.

The response uses `Cache-Control: no-store, max-age=0`. Blind writes no rendered image to disk and bounds concurrent renders with a semaphore. Interactive WebGL and offscreen WebGPU consume the same material parameters and lighting formula, with target-specific shader adapters. Visible sources for one image request are limited to 512 MiB, 2,000,000 triangles, and 2,000,000 point-cloud points. The byte limit is checked before any visible source is read; after rendering, Blind rechecks metadata only for the visible inputs. These limits apply only to the server-side PNG renderer; the interactive browser viewer remains independent.

## Agent boundary

The CLI is canonical:

```sh
blind serve
blind share crown.ply preparation.stl --format json
```

An MCP adapter should call this contract rather than duplicate resource or lifecycle logic. A Skill can teach when to call it, but should not contain a separate sharing implementation.

## Registration API

See [Client/Server operation](client-server.md) for invitation onboarding, per-user authorization, address selection, and deployment. Registered scene creation uses `POST /api/v1/client/scenes` with its own bearer credential; the source always comes from that credential. The old PAT-protected local creation endpoint remains for compatibility. Existing descriptors without a source ID continue to refer to local server files.
