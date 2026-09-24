# Security policy

## Supported versions

Security fixes are provided for the latest published release.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting for this repository. Do
not open a public issue containing credentials, tokens, private paths, or an
unpatched exploit. Include the affected version, reproduction steps, impact,
and any suggested mitigation.

Blind is designed for trusted private networks. Treat viewer URLs as bearer
capabilities: anyone who has a link can read that exact scene while all source
files still match. Complete source paths require the separate owner capability.
Keep the PAT private and place internet-facing deployments behind an HTTPS
reverse proxy with appropriate access control.

Default public and owner capabilities are independently generated six-character
secrets with per-client invalid-code rate limiting and a seven-day absolute
lifetime. They are intended for trusted private networks, not as a replacement
for internet-facing authentication.

## Remote sources

Named OSS credentials live only in the Server's private `oss.json` (mode 0600).
Use read-only object-store credentials for the intended buckets/prefixes.
All active registered Clients and the Server owner PAT may create scenes from
Server-configured OSS aliases. Register only Clients trusted to read those
configured stores; bucket/prefix restrictions belong in the storage credentials.
A download-domain alias is also bound to its configured bucket. Revoked or
unactivated Clients cannot create scenes, and revocation invalidates existing
scenes owned by that Client. Public scene metadata and
capability URLs never include these credentials. OSS reads use HTTPS, reject
redirects, and redact upstream errors. HTTP is allowed only on loopback for
local storage/testing. The OSS alias is a locator, not an authorization token.

The Server creates an independent SSH private key for each registered source;
users never upload their personal private keys. The Client installs the public
key under its current OS account, forced to `sftp-server -R` with `restrict`:
no write operations, shell, PTY or forwarding. Registration pins the SSH host
key, verifies a challenge file, and rejects writable access. Host-key changes
cause temporary failures until registration is explicitly repaired.

This grants the Server read access to files accessible to that OS account;
it is not a directory sandbox. Use separate OS accounts and filesystem access
controls when different users must have different read boundaries. A Client's
API credential can register scenes only against its own source ID. Invitation
tokens are permanent and reusable, so they must stay inside the trusted team;
`blind invite --revoke-all` invalidates every issued invitation without
affecting registered sources. Invitation and source credentials are stored
hashed on A; dedicated private keys are stored with restrictive permissions.

Viewer metadata intentionally includes source host, OS user and display name.
Absolute source paths still require the owner capability. Source bytes are
processed in memory; reverse proxies must also disable response buffering to
disk, as in `deploy/nginx.conf`.
