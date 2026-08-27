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
