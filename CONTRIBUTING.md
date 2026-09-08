# Contributing

Issues and focused pull requests are welcome.

## Development

Requirements are macOS, Rust 1.85 or newer, Node.js 24, and npm.

```sh
npm ci --prefix web
npm test --prefix web
npm run build --prefix web
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test --locked
```

`web/dist` is generated and intentionally ignored. Build it before invoking
Cargo because the Rust binary embeds the generated viewer. Do not include
generated assets in pull requests.

Keep changes small, add tests for behavior contracts, and update the README or
sharing contract when user-visible behavior changes. Never commit a PAT,
private Mesh, generated scene URL, or local configuration.
