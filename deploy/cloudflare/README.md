# Cloudflare Tunnel + Feishu SSO test deployment

This deployment keeps Blind on the NAS and publishes two test hostnames through
a free Cloudflare Tunnel:

- `blind-test.deepshape.dev`: browser viewer, protected by Feishu SSO.
- `blind-api-test.deepshape.dev`: Blind CLI only, restricted to the invitation
  and client-credential endpoints in `nginx.conf`.

The same narrow CLI endpoint allowlist also exists on the viewer hostname. That
keeps existing `blind.deepshape.dev` client registrations working after the
production hostname moves behind SSO; all viewer and scene-fetch routes still
require a browser session.

Cloudflare terminates public TLS. The Tunnel, gateway, SSO service and Blind
origin communicate only on NAS loopback. No inbound NAS port is opened.

The SSO implementation is the pinned `deepshape-ai/relay` implementation already
used by internal services. The image tag in `compose.yaml` is built from commit
`e369f1fdce5b8c9807f14dbd748aaa032ab1e9e3`.

## 1. Build and copy the Relay image

From a clean checkout at the pinned commit:

```sh
./build-relay-image.sh /path/to/relay
docker save blind-sso-relay:e369f1fdce5b | gzip > blind-sso-relay.tar.gz
```

Copy the archive and this directory to the NAS, then load the image there:

```sh
gzip -dc blind-sso-relay.tar.gz | docker load
cp .env.example .env
chmod 600 .env
```

Generate `RELAY_SECRET` and `RELAY_ADMIN_TOKEN` with independent
`openssl rand -hex 32` values. For the first test, leave `SSO_PROVIDER=mock`.

## 2. Local mock verification

```sh
docker compose up -d gateway sso
curl -i -H 'Host: blind-test.deepshape.dev' http://127.0.0.1:7410/
curl -i -H 'Host: blind-api-test.deepshape.dev' http://127.0.0.1:7410/api/v1/health
curl -i -H 'Host: blind-api-test.deepshape.dev' http://127.0.0.1:7410/s/example
```

Expected results are respectively `302` to `/sso/login`, `200`, and `404`.

## 3. Cloudflare setup

Add `deepshape.dev` to a Cloudflare Free account, copy every existing DNS record
from Name.com, verify the copied zone, and only then replace the Name.com name
servers with the two assigned by Cloudflare.

Create one remotely-managed Tunnel. Add public hostnames
`blind-test.deepshape.dev` and `blind-api-test.deepshape.dev`, both targeting
`http://127.0.0.1:7410`. Put its token in `.env`, but do not start the Tunnel
while `SSO_PROVIDER=mock`: mock login deliberately accepts a test identity and
must remain loopback-only.

Do not add a separate Cloudflare Access policy in front of the viewer. Feishu is
not a native Cloudflare Access identity provider; the gateway's forward-auth
layer is the authorization boundary.

## 4. Switch from mock to Feishu

Add this exact redirect URL to the Feishu custom application's security settings:

```text
https://blind-test.deepshape.dev/sso/callback
```

Set `SSO_PROVIDER=feishu`, the Feishu app ID/secret, and the organization's
`tenant_key` in `.env`, then recreate only the SSO container:

```sh
docker compose up -d --force-recreate sso
```

Only after the Feishu provider is healthy, start the public Tunnel:

```sh
docker compose --profile tunnel up -d
```

Keep the test hostnames until login, logout, cross-user denial, CLI sharing and
viewer access have all passed. Production cutover can then reuse the same Tunnel
with `blind.deepshape.dev` and `blind-api.deepshape.dev`.
