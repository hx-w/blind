# Contributing

Issues and focused pull requests are welcome.

## Development

Requirements are macOS, Rust 1.85 or newer, Node.js 24, and npm.

```sh
npm ci --prefix web
npm run build --prefix web
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test --locked
```

`web/dist` is committed because the Rust binary embeds it. Rebuild the viewer
and include the generated changes whenever `web/src` or `web/index.html`
changes.

Keep changes small, add tests for behavior contracts, and update the README or
sharing contract when user-visible behavior changes. Never commit a PAT,
private Mesh, generated scene URL, or local configuration.
