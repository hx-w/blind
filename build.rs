use std::path::Path;

fn main() {
    println!("cargo:rerun-if-changed=web/index.html");
    println!("cargo:rerun-if-changed=web/src");
    println!("cargo:rerun-if-changed=web/package.json");
    println!("cargo:rerun-if-changed=web/package-lock.json");

    assert!(
        Path::new("web/dist/index.html").is_file(),
        "web/dist is missing; run `npm ci --prefix web && npm run build --prefix web`"
    );
}
