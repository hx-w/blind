# HTTP API

[Documentation](../README.md#documentation)

| Route | Access | Purpose |
| --- | --- | --- |
| `GET /api/v1/health` | Public | Version and renderer readiness |
| `GET /api/v1/control/health` | PAT | Verify this configured Blind instance |
| `POST /api/v1/control/stop` | PAT | Gracefully stop the server |
| `GET /api/v1/control/doctor` | PAT | Audit and repair the live short-link registry |
| `POST /api/v1/control/doctor/clean-invalid` | PAT | Remove invalid short links from the live registry |
| `POST /api/v1/control/doctor/clear-all` | PAT | Remove every short link from the live registry |
| `GET /api/v1/hosts` | PAT | Detected Host candidates |
| `POST /api/v1/scenes` | PAT | Create a scene from local paths or OSS addresses |
| `GET /api/v1/client/oss` | Client credential | Discover OSS aliases and sharing authority, without credentials |
| `GET /api/v1/scenes/:token` | Scene capability | Read validated public state |
| `GET /api/v1/scenes/:token/meshes/:index` | Scene capability | Stream a validated Mesh |
| `GET /api/v1/scenes/:token/meshes/:index/lod` | Scene capability | Generate or stream an in-memory review LOD |
| `POST /api/v1/scenes/:token/share` | Scene capability | Capture camera and style state |
| `GET /s/:code` | Short scene capability | Open the default viewer link |
| `GET /i/:token.png` | Scene capability | Render a fresh PNG |

See [authentication](client-server.md#authentication-and-security) for credentials,
[registration endpoints](sharing.md#registration-api) for Client setup, and
[the sharing contract](sharing.md) for payloads, owner capabilities and lifecycle.

For Agent integration, prefer the [CLI JSON contract](cli.md#agent-interface).
