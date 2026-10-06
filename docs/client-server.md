# Client and Server operation

[Documentation](../README.md#documentation)

One executable serves both roles: `blind serve` runs the Server, while
`blind join` and `blind share` are short-lived Client commands with no daemon.

## Install and update

Install the same executable on the Server and every source machine:

```sh
curl -fsSL https://raw.githubusercontent.com/hx-w/blind/main/install.sh | sh
```

`blind update` updates that executable and restarts its managed macOS
LaunchAgent or Linux systemd user service when one is installed.
`BLIND_VERSION` and `BLIND_INSTALL_DIR` select a version and installation
directory. The installer never invokes sudo.

Before upgrading a 2.1.0 Server to 2.2.0, explicitly authorize and run
`blind doctor --clear-all` with the existing executable. This removes published
short links and pinned browser snapshots; recreate shares after the upgrade.
It does not remove Client registrations, configuration, SSH authorization or
original sources. The updater does not perform this destructive cutover automatically.

Prebuilt releases support macOS 14+ on Apple Silicon and Intel, plus native
x86_64 Linux servers. For an optional Docker deployment, see [Linux Server](#linux-server).

## Start a team server

```sh
blind init --host https://blind.example.com
blind serve
# In another terminal, issue one permanent reusable invitation for the team.
blind invite --host https://blind.example.com
```

Point your HTTPS reverse proxy at the server. Keep its configured public origin
on the Server; generated URLs never use the source machine's SFTP address.

Then follow [Registration](#registration) on each source machine. On macOS,
enable **System Settings → General → Sharing → Remote Login** for the current
user. The source address must be reachable from the Server.

The local-only Quick Start is in the [README](../README.md#quick-start).

## Responsibilities

| Component | Responsibility | Persistent state |
| --- | --- | --- |
| Client (`blind join/share`) | Register the OS user; run local resolvers; submit paths/manifests and selected browser snapshots; print links | Server URL, source ID, Client credential, public key, local plugin packages/private `.env` |
| OS SSH/SFTP on B/C | Authenticate A and allow read-only file access | Dedicated public authorization in this user's `authorized_keys` |
| Server (`blind serve`) | Source and scene registries, optional Server resolvers, HTTP viewer, LOD, PNG | Scene descriptors, shared browser snapshots/references, hashed Client credentials, source routes, dedicated private SSH keys |

Original geometry is read on demand and never written to Server storage. LODs
are bounded to 256 MiB in memory; PNGs are generated per request. Individual
source reads are capped at 512 MiB. Visible source bytes for a PNG are also
capped at 512 MiB in total. Cold LOD and Raw requests hash only the requested
Mesh. Cached LODs check its canonical path, byte size, and modification time,
so serving one Mesh never triggers a hash sweep over a multi-gigabyte scene.
LOD generation admits at most two builds and shares a 512 MiB weighted working
memory budget; the browser issues at most four Mesh requests concurrently.

For setup and examples, see [object storage sources](oss.md).

For OSS resources, the Server stores named storage credentials in private `oss.json`.
`blind oss list` on a remote Client discovers the connected Server's aliases;
proxies with explicit Client-route allowlists must allow `GET /api/v1/client/oss`.
Any active registered Client or the owner PAT can create OSS scenes. OSS-only
shares do not need a live SFTP connection to the Client. Revoking that Client
invalidates its OSS scenes. Keys and signed download URLs stay on the Server. Cached OSS
LODs verify the source SHA-256 with a bounded GET because an S3 ETag is not
necessarily a content hash. A temporary storage failure remains recoverable.

## Registration

1. A runs `blind invite --host https://blind.example.com`. The result is
   a permanent reusable invitation. Keep it inside the trusted team. Run
   `blind invite --revoke-all` to invalidate every previously issued invitation
   before distributing a replacement.
2. On B, enable the OS SSH/SFTP service and allow the current OS account.
   Run `blind join --stdin --address b.example.com --name carol`, paste the
   invitation, then finish stdin. `--port` defaults to 22. Without `--address`,
   A uses the request's peer IP; specify an address behind any reverse proxy.
3. A creates a dedicated Ed25519 key pair and returns **only the public key**.
   B pins its SSH host public key during registration and installs A's public
   key with `restrict,command="/path/to/sftp-server -R"`.
4. A verifies the host key before authentication, reads a disposable challenge
   file, and verifies that opening that file for writing is denied. The Client
   cleans up the challenge; registration becomes active only after verification.
5. `blind share model.ply --format json` submits absolute paths using this
   Client's own credential. A hashes the files and returns its existing
   `/s/<code>` and `/i/<code>.png` URL forms.

For a persistent large scene, `blind share --config scene.json` submits the
manifest's ordered `resources` list. Each resource may have a per-Mesh label;
`groups` may label two or more 1-based member indices. Relative paths resolve
from the manifest directory. The first registration streams and hashes each
source once; it does not buffer the aggregate scene on either host.

No personal SSH private key leaves B. The CLI exits after each operation;
only the existing OS SSH service remains available. The Server may pool its
own SFTP connections. Per-user registration is independent even when IP and
port are identical. Display names are labels, not identity or authorization.

The authorized key can read files accessible to that OS user. Read-only SFTP
is **not a directory sandbox**. For tighter limits use a dedicated read-only
OS account and filesystem permissions/chroot configured by an administrator.
This implementation assumes the Server and source users belong to a trusted
team. Registration credentials, invitations and owner URLs must stay private.

## Same host

Use `blind join --local` when the Client and Server run as the same OS user,
share the same configuration directory and filesystem, and can use loopback.
The local endpoint requires the Server owner's PAT. No SFTP key is installed.
The first `blind share` can register locally automatically when no Client
registration exists.

Use SFTP registration for different OS users on the same machine, or for a
Client on the host accessing a containerized Server. A container's filesystem
and user identity are separate from the host's.

## Recovery and revocation

- A pending registration remains resumable for ten minutes with `blind join`;
  an incorrect route can be corrected with
  `blind join --address b.example.com --port 22`. After ten minutes, run
  `blind leave` and reuse the same permanent invitation to start again.
- If the invitation was revoked, run `blind leave`, request the current
  invitation and join again.
- `blind status --json` reports local Server state, this user's connection and target plugins without credentials.
- `blind leave` removes only this registration's managed authorized-key line,
  revokes the registration, and removes local Client state. If A is offline,
  the SSH authorization is still removed; retry leave when A returns.
- A can list and revoke sources with `blind sources` and
  `blind sources --revoke SOURCE_ID`. Other registrations keep working.
  B can then run `blind leave` to remove its now-unused public-key line.
- Revoking invitations does not revoke already registered sources or their
  existing links. It does cancel every pending registration that has not yet
  completed. Revoke active sources separately when access must be removed.
- To change an active registration's address or server, leave and join again;
  its old links are revoked. Prefer a stable, server-resolvable DNS name.
- Temporarily offline hosts, authentication errors and permission failures
  return 503. Existing links recover when access is restored. Only confirmed
  revision changes, deletion, expiry or revocation invalidate a scene.

Client state defaults to the user's Blind configuration directory. Override
it with `BLIND_CLIENT_DIR`. Server state uses `BLIND_CONFIG_DIR`. Client files
and Server SSH keys use mode 0600; credential directories use mode 0700.

## Background service

To keep Blind running after login:

```sh
blind service install
blind service status
```

Install the service as the logged-in user. Do not use `sudo`: Blind installs a
per-user LaunchAgent on macOS or a systemd user service on Linux and rejects
root rather than target the wrong user session.

Remove the background service with `blind service uninstall`.

## Host discovery and access

Blind listens on `0.0.0.0:7400` by default and detects addresses from active
network interfaces. Several private, local, or global origins may be returned.
The first is used unless you choose one explicitly:

```sh
blind hosts
blind init --host https://mesh.example.test
blind share model.ply --host http://10.0.0.8:7400
```

Browser-generated shares initially keep the origin used to open the current
page. The Share sheet lists every detected Host and can regenerate the view,
image, and Complete information links with another selected origin.

For CLI automation, `--host` always wins. Without it, Blind uses a configured
origin from `blind init --host` when present; otherwise it prefers private IPv4
addresses in `100.64.0.0/10`, LAN IPv4, private IPv6, other IPv4, then other
IPv6. Interface name and address break ties, and loopback is last. `blind hosts`
shows the current order and marks the default with `*`.

For remote mobile access, provide a trusted private network or HTTPS reverse proxy.
Plain HTTP may prevent browser clipboard APIs, in which case Blind uses a
visible, preselected text field for manual copying. Blind only reports an
automatic copy after the browser confirms the clipboard write.

## Authentication and security

The Server control API requires its private PAT. Remote Clients use their own registration credentials for scene creation and cannot choose another user's source.
Initialize and print it locally:

```sh
blind init --show-pat
```

Send it only as `Authorization: Bearer blind_pat_...`. Viewer URLs are bearer
capabilities. Anyone with a public URL can read that exact scene and create a
new public snapshot while the sources match. Public scene responses expose
file names but not absolute paths. Keep `owner_url` private because it can copy
source paths.

Blind is intended for trusted private networks. Do not expose it directly to
the public internet. See [SECURITY.md](../SECURITY.md) for reporting and deployment
guidance.

## Doctor and link maintenance

`blind doctor` repairs safe local invariants and audits every SQLite-backed
short link without stopping a running server. It restores private config and
registry permissions, verifies the schema, index, WAL, and SQLite integrity,
checks that the configured internal scene key matches the registry, then reports
this distribution:

- valid: the payload decrypts, has not expired, and every source revision still
  matches;
- expired: the configured lifetime has ended;
- source gone: a source was deleted, moved, replaced, changed, or was revoked;
- unavailable: the source host is offline, authentication fails, or access is temporarily denied; these links are retained by `--clean-invalid`;
- tombstoned: Blind previously detected an invalid source;
- corrupt: required fields or the encrypted payload cannot be read.

When the server is running, `blind doctor` also reports the in-memory LOD cache:
entry count, resident bytes versus the 256 MiB limit, Raw-to-LOD payload savings,
and source-to-LOD triangle and point counts. With no server running it reports
the cache as inactive because derived LODs never persist to disk.

Invalid or all SQLite-backed short links can be deleted while Blind continues
serving other requests:

```sh
blind doctor --clean-invalid
blind doctor --clear-all
```

These actions affect `/s/` short links.

## Linux Server

GitHub releases include a native `blind-linux-x86_64.tar.gz`
archive. The installer verifies `SHA256SUMS` and installs the single `blind`
binary. `blind service install` creates a systemd user service, and
`blind update` downloads, verifies, atomically replaces, restarts and health
checks future releases. The Linux Server uses native file locks; no Docker or
source checkout is required.

For startup before the user logs in, enable lingering for the service account
with `loginctl enable-linger USER`. As that account, check
`systemctl --user is-enabled blind.service` and
`systemctl --user is-active blind.service`.
On systems where the home directory is mounted late, arrange for the systemd
user manager to start after that mount; the user manager must be able to read
the unit before it can start Blind. Verify both the configured local health
endpoint and the public HTTPS `/api/v1/health` route after deployment.

An optional Docker deployment is available when process isolation is preferred:

Build the viewer, then build the Linux binary (Rust 1.90 or newer):

```sh
npm ci --prefix web
npm run build --prefix web
docker run --rm -v "$PWD:/work" -w /work rust:1.90-bookworm \
  cargo build --locked --release --bin blind
mkdir -p deploy/config
# Match BLIND_UID / BLIND_GID to the owner of deploy/config.
BLIND_UID=$(id -u) BLIND_GID=$(id -g) docker compose -f deploy/compose.yaml build
BLIND_UID=$(id -u) BLIND_GID=$(id -g) docker compose -f deploy/compose.yaml \
  run --rm blind init --host https://blind.example.com
BLIND_UID=$(id -u) BLIND_GID=$(id -g) docker compose -f deploy/compose.yaml up -d
```

The example binds HTTP only to `127.0.0.1:7401`, keeps the container filesystem
read-only and mounts only configuration storage. It does not mount or copy
remote originals. SFTP needs `ssh-keygen`, provided by `openssh-client` in the
image. Mesa's Vulkan software renderer supports geometry PNGs on hosts
without a GPU. Chromium exports component scenes; the included seccomp profile
permits its nested user-namespace sandbox while retaining dropped capabilities,
no-new-privileges and the 4 GiB service limit. See [profile provenance](../deploy/seccomp-chromium.md).

Adapt [the Nginx example](../deploy/nginx.conf) for your hostname and certificate
paths. It preserves HTTPS origins, blocks local-owner API operations and
disables proxy response buffering/temp files. Reuse the existing certificate
renewal hook that reloads Nginx. The Server itself listens on HTTP behind TLS.

## Migration

The installation remains one `blind` binary on each host. Preserve the existing
Server configuration when upgrading A, follow any release-specific link cutover
above, then register the
Client locally if A also shares files. `blind serve`, `blind service install`
and `blind update` keep their existing entry points. Client commands do not
start the Server. `blind status` reports local Server state, Client connectivity and target plugins.
`blind server-status` is a hidden compatibility alias for the same report. Existing source-less scenes still resolve local Server files.

## Verification

```sh
cargo fmt --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked
cargo build --locked
python3 tests/integration_sftp.py
```

The integration test starts an isolated SSH daemon on a random port with
throwaway keys. It never changes OS SSH settings or the user's authorized keys.
It covers writable-key rejection, independent credentials, source ownership,
Raw/LOD/PNG, unavailable-source cleanup, recovery, revocation and deletion.

Plugin/OSS-only Clients may register using `blind join --stdin --client-only`
without SSH. This identity has no filesystem source. See [plugins](plugins.md).
