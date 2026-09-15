# Client and Server operation

## Responsibilities

| Component | Responsibility | Persistent state |
| --- | --- | --- |
| Client (`blind join/share`) | Register the current OS user; submit file paths; print links | Server URL, source ID, Client credential, installed public key |
| OS SSH/SFTP on B/C | Authenticate A and allow read-only file access | Dedicated public authorization in this user's `authorized_keys` |
| Server (`blind serve`) | Source registry, encrypted scene registry, HTTP viewer, LOD, PNG | Scene descriptors, hashed Client credentials, source routes, dedicated private SSH keys |

Original geometry is read on demand and never written to Server storage. LODs
are bounded to 256 MiB in memory; PNGs are generated per request. Individual
source reads are capped at 512 MiB. Visible source bytes for a PNG are also
capped at 512 MiB in total. Hash verification still reads the original source
on cache hits, so cached LODs cannot bypass revocation or source changes.

## Registration

1. A runs `blind invite --host https://blind.example.com`. The result is
   a one-use, ten-minute invitation. Deliver it privately to the intended user.
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

Use SFTP registration for different OS users on the same machine, or for a
Client on the host accessing a containerized Server. A container's filesystem
and user identity are separate from the host's.

## Recovery and revocation

- A pending registration can be resumed with `blind join`; an incorrect route
  can be corrected with `blind join --address b.example.com --port 22` before
  the ten-minute invitation window expires.
- After expiry, run `blind leave`, request a fresh invitation and join again.
- `blind status --json` reports this user's registration without credentials.
- `blind leave` removes only this registration's managed authorized-key line,
  revokes the registration, and removes local Client state. If A is offline,
  the SSH authorization is still removed; retry leave when A returns.
- A can list and revoke sources with `blind sources` and
  `blind sources --revoke SOURCE_ID`. Other registrations keep working.
  B can then run `blind leave` to remove its now-unused public-key line.
- To change an active registration's address or server, leave and join again;
  its old links are revoked. Prefer a stable, server-resolvable DNS name.
- Temporarily offline hosts, authentication errors and permission failures
  return 503. Existing links recover when access is restored. Only confirmed
  revision changes, deletion, expiry or revocation invalidate a scene.

Client state defaults to the user's Blind configuration directory. Override
it with `BLIND_CLIENT_DIR`. Server state uses `BLIND_CONFIG_DIR`. Client files
and Server SSH keys use mode 0600; credential directories use mode 0700.

## Linux / Docker Server

The Linux Server uses an OS file lock. Automatic `service install` remains a
macOS LaunchAgent feature; Docker handles Linux restart behavior. Linux binary
self-update is not currently packaged: rebuild the container for upgrades.

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
image. Mesa's Vulkan software renderer supports PNG on hosts without a GPU.

Adapt [the Nginx example](../deploy/nginx.conf) for your hostname and certificate
paths. It preserves HTTPS origins, blocks local-owner API operations and
disables proxy response buffering/temp files. Reuse the existing certificate
renewal hook that reloads Nginx. The Server itself listens on HTTP behind TLS.

## Migration

The installation remains one `blind` binary on each host. Preserve the existing
Server configuration and scene database when upgrading A, then register the
Client locally if A also shares files. `blind serve`, `blind service install`
and `blind update` keep their existing entry points. Client commands do not
start the Server. `blind status` reports Client registration; `blind server-status`
reports the Server. Existing source-less scenes still resolve local Server files.

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
