# Object storage sources

[Documentation](../README.md#documentation)

Blind reads private meshes from S3-compatible APIs or signed download domains.
On the **Server machine**, configure one alias per endpoint/credential pair:

```sh
blind oss set prod     # prompts: endpoint, region, Access Key, Secret Key
blind oss list        # aliases and connection metadata only; no credentials
blind oss remove prod
```

The default `--signing s3-v4` uses an HTTPS S3 API endpoint and its region.
For a private CDN using HMAC-SHA1 URL signatures:

```sh
blind oss set assets --signing hmac-sha1-url --bucket my-bucket
# prompts: HTTPS download origin, Access Key, Secret Key (no region)
```

This mode signs `https://DOMAIN/KEY?e=DEADLINE`, then appends a `token`
containing the Access Key and URL-safe Base64 HMAC-SHA1 signature. The domain
is bound to the configured bucket; other buckets are rejected. Signed URLs
are generated on the Server and never sent to the Client or viewer.
`set` also replaces an existing alias; terminal credential input is hidden.
Automation can pipe four lines on stdin for S3, or three for URL signing. Credentials are
stored only in the Server's `oss.json`, next to `config.json`, with mode 0600.
The next read picks up changes without a restart.

On a remote Client, `blind oss list` queries its connected Server and shows
the configured signing mode and bucket/region. Every active registered Client
can share these OSS aliases; discovery never returns Access Keys or Secret Keys. `set` and `remove`
always edit the local Server configuration, not the remote Server.

```sh
blind share oss://prod/my-bucket/orders/123/crown.ply --format json
blind share oss://prod/my-bucket/crown.ply oss://archive/other-bucket/jaw.stl
```

Addresses are `oss://ALIAS/BUCKET/KEY`; percent-encode reserved characters in
object keys. Each mesh selects its own alias. Local files can be mixed with OSS
addresses, and `--config` accepts these addresses in `resources[].path`.
Labels, groups, Raw/LOD, PNG and sharing work as for filesystem sources.

Any active registered Client can create OSS shares using the connected Server's
aliases. The Server reads the objects; the Client does not need storage keys or
a live SFTP connection for an OSS-only scene. The owner PAT API also supports
OSS scenes. Viewers only need the resulting Blind URL.

Blind performs signed, read-only GET requests, hashes the original bytes, and
does not save meshes to disk. Changes/deletion or alias removal invalidate
shares; temporary authentication/network failures return 503 and remain
recoverable. Reads are limited to 512 MiB per object and 120 seconds, and do
not follow redirects. HTTPS is required except for loopback test endpoints.
