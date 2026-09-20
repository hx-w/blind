//! Verified native plugin packages from a GitHub repository's stable releases.
use anyhow::{Context, Result, bail, ensure};
use flate2::read::GzDecoder;
use reqwest::{Client, Response, header};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{collections::HashSet, fs, io::Read, path::Path, time::Duration};

const MAX_ARCHIVE: usize = 256 * 1024 * 1024;
const MAX_FILE: u64 = 64 * 1024 * 1024;

#[derive(Deserialize)]
struct Release {
    tag_name: String,
    draft: bool,
    prerelease: bool,
    assets: Vec<Asset>,
}
#[derive(Deserialize)]
struct Asset {
    id: u64,
    name: String,
}

fn version(input: &str) -> Result<[u64; 3]> {
    let input = input.strip_prefix('v').unwrap_or(input);
    let parts = input.split('.').collect::<Vec<_>>();
    ensure!(
        parts.len() == 3,
        "plugin release must have a stable X.Y.Z version"
    );
    let mut result = [0; 3];
    for (i, part) in parts.iter().enumerate() {
        ensure!(
            !part.is_empty()
                && part.bytes().all(|b| b.is_ascii_digit())
                && (part.len() == 1 || !part.starts_with('0')),
            "plugin release must have a stable X.Y.Z version"
        );
        result[i] = part.parse().context("plugin version number is too large")?;
    }
    Ok(result)
}

pub fn validate_repository(repo: &str) -> Result<()> {
    let parts = repo.split('/').collect::<Vec<_>>();
    ensure!(
        parts.len() == 2
            && parts.iter().all(|p| {
                !p.is_empty()
                    && p.len() <= 100
                    && ![".", ".."].contains(p)
                    && p.bytes()
                        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
            }),
        "plugin repository must be OWNER/REPO"
    );
    Ok(())
}

fn asset_id(release: &Release, name: &str) -> Result<u64> {
    let assets = release
        .assets
        .iter()
        .filter(|a| a.name == name)
        .collect::<Vec<_>>();
    ensure!(
        assets.len() == 1,
        "release must contain exactly one {name} asset"
    );
    ensure!(assets[0].id > 0, "release contains an invalid asset ID");
    Ok(assets[0].id)
}

fn asset_redirect(url: &url::Url) -> bool {
    url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && url.port_or_known_default() == Some(443)
        && url.fragment().is_none()
        && matches!(
            url.host_str(),
            Some("release-assets.githubusercontent.com" | "objects.githubusercontent.com")
        )
}

async fn bounded_body(mut response: Response, limit: usize) -> Result<Vec<u8>> {
    ensure!(
        response.status().is_success(),
        "GitHub download failed (HTTP {})",
        response.status().as_u16()
    );
    ensure!(
        response.content_length().is_none_or(|n| n <= limit as u64),
        "GitHub response exceeds size limit"
    );
    let mut data = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| anyhow::anyhow!("Could not read GitHub response"))?
    {
        ensure!(
            chunk.len() <= limit.saturating_sub(data.len()),
            "GitHub response exceeds size limit"
        );
        data.extend_from_slice(&chunk);
    }
    Ok(data)
}

async fn api_get(
    client: &Client,
    path: &str,
    token: Option<&str>,
    asset: bool,
    limit: usize,
) -> Result<Vec<u8>> {
    let mut request = client.get(format!("https://api.github.com/{path}")).header(
        header::ACCEPT,
        if asset {
            "application/octet-stream"
        } else {
            "application/vnd.github+json"
        },
    );
    if let Some(token) = token.filter(|t| !t.is_empty()) {
        request = request.bearer_auth(token);
    }
    let mut response = request
        .send()
        .await
        .map_err(|_| anyhow::anyhow!("Could not contact GitHub"))?;
    // GitHub's private asset endpoint returns a signed CDN URL. Never forward
    // the repository credential to that URL, including subsequent redirects.
    for _ in 0..3 {
        if !response.status().is_redirection() {
            return bounded_body(response, limit).await;
        }
        ensure!(asset, "Unexpected GitHub API redirect");
        let location = response
            .headers()
            .get(header::LOCATION)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| url::Url::parse(v).ok())
            .context("Invalid GitHub asset redirect")?;
        ensure!(asset_redirect(&location), "Unexpected GitHub asset host");
        response = client
            .get(location)
            .send()
            .await
            .map_err(|_| anyhow::anyhow!("Could not download GitHub asset"))?;
    }
    bail!("Too many GitHub asset redirects")
}

fn verify_checksum(bytes: &[u8], sums: &[u8], name: &str) -> Result<()> {
    let sums = std::str::from_utf8(sums).context("SHA256SUMS must be UTF-8")?;
    let mut expected = None;
    for line in sums.lines() {
        let fields = line.split_whitespace().collect::<Vec<_>>();
        if fields.len() == 2 && fields[1].trim_start_matches('*') == name {
            ensure!(
                expected.is_none(),
                "SHA256SUMS contains duplicate archive entries"
            );
            ensure!(
                fields[0].len() == 64 && fields[0].bytes().all(|b| b.is_ascii_hexdigit()),
                "Invalid archive checksum"
            );
            expected = Some(fields[0].to_ascii_lowercase());
        }
    }
    let expected = expected.context("SHA256SUMS does not contain the plugin archive")?;
    ensure!(
        hex::encode(Sha256::digest(bytes)) == expected,
        "Plugin archive checksum mismatch"
    );
    Ok(())
}

fn safe_path(path: &Path) -> bool {
    !path.as_os_str().is_empty()
        && path
            .components()
            .all(|c| matches!(c, std::path::Component::Normal(_)))
        && path
            .to_str()
            .is_some_and(|s| !s.contains('\\') && !s.chars().any(char::is_control))
}

fn extract(
    bytes: &[u8],
    destination: &Path,
    id: &str,
    expected_version: [u64; 3],
    repo: &str,
) -> Result<()> {
    // Bound the decompressed stream too: sparse/header-heavy tar files must not
    // bypass the aggregate regular-file limit.
    let decoder = GzDecoder::new(bytes).take((MAX_ARCHIVE + 1024 * 1024) as u64);
    let mut archive = tar::Archive::new(decoder);
    let mut paths = HashSet::new();
    let mut files = HashSet::new();
    let mut total = 0u64;
    for entry in archive.entries().context("Invalid plugin archive")? {
        let mut entry = entry.context("Invalid plugin archive entry")?;
        let path = entry
            .path()
            .context("Invalid plugin archive path")?
            .into_owned();
        ensure!(
            safe_path(&path) && paths.insert(path.clone()),
            "Unsafe or duplicate plugin archive path"
        );
        ensure!(paths.len() <= 4096, "Too many plugin package entries");
        let kind = entry.header().entry_type();
        ensure!(
            kind.is_file() || kind.is_dir(),
            "Plugin archive may contain only regular files and directories"
        );
        if kind.is_dir() {
            fs::create_dir_all(destination.join(path))?;
            continue;
        }
        let size = entry.size();
        ensure!(size <= MAX_FILE, "Plugin package file exceeds 64 MiB");
        total = total
            .checked_add(size)
            .context("Plugin archive size overflow")?;
        ensure!(
            total <= MAX_ARCHIVE as u64,
            "Plugin package exceeds 256 MiB"
        );
        let target = destination.join(&path);
        fs::create_dir_all(target.parent().context("Invalid package path")?)?;
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(target)?;
        ensure!(
            std::io::copy(&mut entry, &mut file)? == size,
            "Truncated plugin package file"
        );
        files.insert(path);
    }
    let manifest_path = destination.join("blind-plugin.json");
    ensure!(
        fs::metadata(&manifest_path)?.len() <= 4 * 1024 * 1024,
        "Plugin manifest exceeds 4 MiB"
    );
    let manifest: serde_json::Value =
        serde_json::from_slice(&fs::read(manifest_path)?).context("Invalid plugin manifest")?;
    ensure!(
        manifest["id"] == id,
        "Release package plugin ID differs from requested plugin"
    );
    ensure!(
        manifest["update"]["repository"] == repo,
        "Release package update repository differs from requested repository"
    );
    ensure!(
        version(
            manifest["version"]
                .as_str()
                .context("Plugin manifest version missing")?
        )? == expected_version,
        "Release package version differs from its release tag"
    );
    let declared = manifest["files"]
        .as_array()
        .context("Plugin manifest files missing")?;
    let mut expected = HashSet::from([std::path::PathBuf::from("blind-plugin.json")]);
    for file in declared {
        let path = Path::new(file.as_str().context("Invalid declared plugin file")?);
        ensure!(
            safe_path(path) && expected.insert(path.to_owned()),
            "Invalid or duplicate declared plugin file"
        );
    }
    ensure!(
        files == expected,
        "Release package files differ from its manifest"
    );
    Ok(())
}

/// Download and verify a release without altering the installed plugin. The
/// caller must retain the returned directory until its atomic install finishes.
pub async fn fetch_package(
    repo: &str,
    id: &str,
    current_version: Option<&str>,
    token: Option<&str>,
) -> Result<Option<tempfile::TempDir>> {
    validate_repository(repo)?;
    ensure!(
        !id.is_empty()
            && id.len() <= 64
            && id
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'-' | b'_')),
        "Invalid plugin ID"
    );
    let target = match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => "aarch64-apple-darwin",
        ("macos", "x86_64") => "x86_64-apple-darwin",
        ("linux", "x86_64") => "linux-x86_64",
        _ => bail!("Plugin releases are unavailable for this platform"),
    };
    let client = Client::builder()
        .user_agent(concat!("blind/", env!("CARGO_PKG_VERSION")))
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(180))
        .connect_timeout(Duration::from_secs(15))
        .build()
        .map_err(|_| anyhow::anyhow!("Could not initialize GitHub client"))?;
    let release: Release = serde_json::from_slice(
        &api_get(
            &client,
            &format!("repos/{repo}/releases/latest"),
            token,
            false,
            4 * 1024 * 1024,
        )
        .await?,
    )
    .context("Invalid GitHub release metadata")?;
    ensure!(
        !release.draft && !release.prerelease && release.tag_name.starts_with('v'),
        "Expected a published stable vX.Y.Z plugin release"
    );
    let latest = version(&release.tag_name)?;
    if let Some(current) = current_version {
        let current = version(current)?;
        ensure!(
            latest >= current,
            "GitHub release is older than the installed plugin; refusing downgrade"
        );
        if latest == current {
            return Ok(None);
        }
    }
    let name = format!("{id}-{target}.tar.gz");
    let archive_id = asset_id(&release, &name)?;
    let sums_id = asset_id(&release, "SHA256SUMS")?;
    let sums = api_get(
        &client,
        &format!("repos/{repo}/releases/assets/{sums_id}"),
        token,
        true,
        1024 * 1024,
    )
    .await?;
    let bytes = api_get(
        &client,
        &format!("repos/{repo}/releases/assets/{archive_id}"),
        token,
        true,
        MAX_ARCHIVE,
    )
    .await?;
    verify_checksum(&bytes, &sums, &name)?;
    let temp = tempfile::Builder::new()
        .prefix("blind-plugin-update-")
        .tempdir()?;
    extract(&bytes, temp.path(), id, latest, repo)?;
    Ok(Some(temp))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn extract(bytes: &[u8], destination: &Path, id: &str, version: [u64; 3]) -> Result<()> {
        super::extract(bytes, destination, id, version, "team/demo")
    }
    fn archive(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let gzip = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        let mut tar = tar::Builder::new(gzip);
        for (name, bytes) in entries {
            let mut header = tar::Header::new_gnu();
            header.set_size(bytes.len() as u64);
            header.set_mode(0o755);
            header.set_cksum();
            tar.append_data(&mut header, name, *bytes).unwrap();
        }
        tar.into_inner().unwrap().finish().unwrap()
    }
    const MANIFEST: &[u8] =
        br#"{"id":"demo","version":"1.2.0","files":["demo"],"update":{"repository":"team/demo"}}"#;
    #[test]
    fn stable_versions_and_repository_paths() {
        assert!(version("v1.10.0").unwrap() > version("1.9.9").unwrap());
        for bad in ["1.2", "1.2.3-beta", "01.2.3", "1.2.3+build", "vv1.2.3"] {
            assert!(version(bad).is_err());
        }
        assert!(validate_repository("deepshape-ai/cyclops").is_ok());
        for bad in [
            "../x",
            "a/b/c",
            "a/b?token=secret",
            "https://github.com/a/b",
        ] {
            assert!(validate_repository(bad).is_err());
        }
    }
    #[test]
    fn archive_identity_and_inventory_are_verified() {
        let bytes = archive(&[("blind-plugin.json", MANIFEST), ("demo", b"binary")]);
        let temp = tempfile::tempdir().unwrap();
        extract(&bytes, temp.path(), "demo", [1, 2, 0]).unwrap();
        assert!(
            super::extract(
                &bytes,
                tempfile::tempdir().unwrap().path(),
                "demo",
                [1, 2, 0],
                "another/demo"
            )
            .is_err()
        );
        for (id, v) in [("wrong", [1, 2, 0]), ("demo", [1, 3, 0])] {
            assert!(extract(&bytes, tempfile::tempdir().unwrap().path(), id, v).is_err());
        }
        for files in [
            vec![("blind-plugin.json", MANIFEST)],
            vec![
                ("blind-plugin.json", MANIFEST),
                ("demo", b"x"),
                ("extra", b"x"),
            ],
            vec![
                ("blind-plugin.json", MANIFEST),
                ("demo", b"x"),
                ("demo", b"y"),
            ],
        ] {
            assert!(
                extract(
                    &archive(&files),
                    tempfile::tempdir().unwrap().path(),
                    "demo",
                    [1, 2, 0]
                )
                .is_err()
            );
        }
    }
    #[test]
    fn unsafe_paths_and_links_are_rejected() {
        for bad in ["../x", "/x", "a/../../x", "a\\b", "./x"] {
            assert!(!safe_path(Path::new(bad)));
        }
        for kind in [tar::EntryType::Symlink, tar::EntryType::Link] {
            let gzip = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
            let mut tar = tar::Builder::new(gzip);
            let mut header = tar::Header::new_gnu();
            header.set_entry_type(kind);
            header.set_size(0);
            header.set_mode(0o777);
            header.set_cksum();
            tar.append_link(&mut header, "demo", "/tmp/escape").unwrap();
            let bytes = tar.into_inner().unwrap().finish().unwrap();
            assert!(
                extract(
                    &bytes,
                    tempfile::tempdir().unwrap().path(),
                    "demo",
                    [1, 2, 0]
                )
                .is_err()
            );
        }
        let gzip = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        let mut tar = tar::Builder::new(gzip);
        let mut header = tar::Header::new_gnu();
        header.as_mut_bytes()[..7].copy_from_slice(b"../demo");
        header.set_size(0);
        header.set_mode(0o755);
        header.set_cksum();
        tar.append(&header, &[][..]).unwrap();
        let bytes = tar.into_inner().unwrap().finish().unwrap();
        assert!(
            extract(
                &bytes,
                tempfile::tempdir().unwrap().path(),
                "demo",
                [1, 2, 0]
            )
            .is_err()
        );
    }
    #[test]
    fn checksums_and_asset_hosts_are_strict() {
        let sum = format!("{}  demo.tar.gz\n", hex::encode(Sha256::digest(b"content")));
        verify_checksum(b"content", sum.as_bytes(), "demo.tar.gz").unwrap();
        assert!(verify_checksum(b"changed", sum.as_bytes(), "demo.tar.gz").is_err());
        assert!(
            verify_checksum(b"content", format!("{sum}{sum}").as_bytes(), "demo.tar.gz").is_err()
        );
        assert!(asset_redirect(
            &url::Url::parse("https://release-assets.githubusercontent.com/a?sig=private").unwrap()
        ));
        for bad in [
            "https://evil.test/a",
            "https://release-assets.githubusercontent.com.evil.test/a",
            "http://objects.githubusercontent.com/a",
            "https://user@objects.githubusercontent.com/a",
        ] {
            assert!(!asset_redirect(&url::Url::parse(bad).unwrap()));
        }
        let release: Release = serde_json::from_value(serde_json::json!({"tag_name":"v1.2.0","draft":false,"prerelease":false,"assets":[{"id":1,"name":"demo"},{"id":2,"name":"demo"}]})).unwrap();
        assert!(asset_id(&release, "demo").is_err());
    }
}
