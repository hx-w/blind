use std::{
    fs::{self, DirBuilder, File, OpenOptions},
    io::{Read, Write},
    os::unix::fs::{DirBuilderExt, PermissionsExt},
    path::{Path, PathBuf},
    process::{Command, Output, Stdio},
    time::Duration,
};

#[cfg(target_os = "linux")]
use std::os::unix::{fs::OpenOptionsExt, io::AsRawFd};
#[cfg(target_os = "macos")]
use std::{ffi::CStr, os::unix::ffi::OsStringExt};

use anyhow::{Context, Result, bail};
use flate2::read::GzDecoder;
use rand::RngCore;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use wait_timeout::ChildExt;

const LATEST_RELEASE_API: &str = "https://api.github.com/repos/hx-w/blind/releases/latest";

pub enum PrepareOutcome {
    Ready(PreparedUpdate),
    Unchanged { current: String, latest: String },
}

pub enum CommitOutcome {
    Updated(CommittedUpdate),
    Unchanged { current: String, latest: String },
}

pub struct PreparedUpdate {
    current: String,
    latest: String,
    destination: PathBuf,
    candidate: PathBuf,
    temp: UpdateTempDir,
    lock: UpdateLock,
}

pub struct CommittedUpdate {
    from: String,
    to: String,
    destination: PathBuf,
    backup: PathBuf,
    finished: bool,
    _temp: UpdateTempDir,
    _lock: UpdateLock,
}

#[derive(Debug, Deserialize)]
struct GitHubRelease {
    tag_name: String,
    assets: Vec<GitHubAsset>,
}

#[derive(Debug, Deserialize)]
struct GitHubAsset {
    name: String,
    browser_download_url: String,
}

pub fn validate_user() -> Result<()> {
    reject_root(unsafe { libc::getuid() })
}

pub fn prepare() -> Result<PrepareOutcome> {
    validate_user()?;
    let destination = std::env::current_exe()
        .context("could not locate the running Blind executable")?
        .canonicalize()
        .context("could not resolve the running Blind executable")?;
    let lock = UpdateLock::acquire(&destination)?;
    let current = candidate_version(&destination)
        .context("could not determine the installed Blind version")?;
    let current_version =
        ReleaseVersion::parse(&current).context("installed Blind has an invalid version")?;
    let target = release_target()?;
    let archive_name = format!("blind-{target}.tar.gz");
    let temp = UpdateTempDir::create()?;
    let release_json = temp.path.join("release.json");
    download(LATEST_RELEASE_API, &release_json)?;
    let release: GitHubRelease = serde_json::from_slice(
        &fs::read(&release_json).context("could not read the GitHub release response")?,
    )
    .context("GitHub returned an invalid release response")?;
    let latest_version = ReleaseVersion::parse(&release.tag_name)
        .context("latest GitHub release is not a stable Blind version")?;
    let latest = release.tag_name.trim_start_matches('v').to_owned();
    if latest_version <= current_version {
        return Ok(PrepareOutcome::Unchanged { current, latest });
    }
    let archive_url = release_asset_url(&release, &archive_name)?;
    let checksums_url = release_asset_url(&release, "SHA256SUMS")?;
    let archive = temp.path.join(&archive_name);
    let checksums = temp.path.join("SHA256SUMS");
    download(archive_url, &archive)?;
    download(checksums_url, &checksums)?;
    verify_checksum(&archive, &checksums, &archive_name)?;

    let unpack = temp.path.join("unpack");
    fs::create_dir(&unpack)?;
    extract_single_binary(&archive, &unpack)?;
    let candidate = unpack.join("blind");
    let candidate_release = candidate_version(&candidate)?;
    if ReleaseVersion::parse(&candidate_release)? != latest_version {
        bail!(
            "release tag {} contains Blind {candidate_release}",
            release.tag_name
        );
    }
    Ok(PrepareOutcome::Ready(PreparedUpdate {
        current,
        latest: candidate_release,
        destination,
        candidate,
        temp,
        lock,
    }))
}

impl PreparedUpdate {
    pub fn commit(self) -> Result<CommitOutcome> {
        let installed = candidate_version(&self.destination)
            .context("could not recheck the installed Blind version")?;
        if ReleaseVersion::parse(&self.latest)? <= ReleaseVersion::parse(&installed)? {
            return Ok(CommitOutcome::Unchanged {
                current: installed,
                latest: self.latest,
            });
        }
        let backup = sibling_path(&self.destination, "rollback");
        let mut backup_guard = StagedFile::new(backup.clone());
        copy_executable(&self.destination, &backup)
            .context("could not preserve the current Blind executable")?;
        if candidate_version(&backup)? != self.current {
            bail!("installed Blind changed while the update was being prepared");
        }
        atomic_replace(&self.candidate, &self.destination)?;
        backup_guard.disarm();
        Ok(CommitOutcome::Updated(CommittedUpdate {
            from: self.current,
            to: self.latest,
            destination: self.destination,
            backup,
            finished: false,
            _temp: self.temp,
            _lock: self.lock,
        }))
    }
}

impl CommittedUpdate {
    pub fn previous_version(&self) -> &str {
        &self.from
    }

    pub fn to_version(&self) -> &str {
        &self.to
    }

    pub fn rollback(mut self) -> Result<()> {
        fs::rename(&self.backup, &self.destination)
            .context("could not restore the previous Blind executable")?;
        self.finished = true;
        sync_parent(&self.destination);
        Ok(())
    }

    pub fn finish(mut self) -> Result<(String, String, PathBuf)> {
        self.finished = true;
        fs::remove_file(&self.backup).context("could not remove the Blind rollback executable")?;
        Ok((self.from.clone(), self.to.clone(), self.destination.clone()))
    }
}

impl Drop for CommittedUpdate {
    fn drop(&mut self) {
        if !self.finished && fs::rename(&self.backup, &self.destination).is_ok() {
            sync_parent(&self.destination);
        }
    }
}

fn reject_root(uid: libc::uid_t) -> Result<()> {
    if uid == 0 {
        bail!("Blind must not update as root; run `blind update` without sudo");
    }
    Ok(())
}

fn release_target() -> Result<&'static str> {
    release_target_for(std::env::consts::OS, std::env::consts::ARCH)
}

fn release_target_for(os: &str, arch: &str) -> Result<&'static str> {
    match (os, arch) {
        ("macos", "aarch64") => Ok("aarch64-apple-darwin"),
        ("macos", "x86_64") => Ok("x86_64-apple-darwin"),
        ("linux", "x86_64") => Ok("linux-x86_64"),
        (os, arch) => bail!("Blind updates are not available for {os}/{arch}"),
    }
}

fn release_asset_url<'a>(release: &'a GitHubRelease, name: &str) -> Result<&'a str> {
    let mut matches = release.assets.iter().filter(|asset| asset.name == name);
    let asset = matches
        .next()
        .with_context(|| format!("release {} does not contain {name}", release.tag_name))?;
    if matches.next().is_some() {
        bail!(
            "release {} contains duplicate {name} assets",
            release.tag_name
        );
    }
    let expected_prefix = format!(
        "https://github.com/hx-w/blind/releases/download/{}/",
        release.tag_name
    );
    if !asset.browser_download_url.starts_with(&expected_prefix) {
        bail!("release {name} asset has an unexpected download URL");
    }
    Ok(&asset.browser_download_url)
}

fn download(url: &str, destination: &Path) -> Result<()> {
    let output = Command::new("/usr/bin/curl")
        .args([
            "--disable",
            "--fail",
            "--location",
            "--retry",
            "3",
            "--silent",
            "--show-error",
            "--proto",
            "=https",
            "--proto-redir",
            "=https",
            "--tlsv1.2",
            "--connect-timeout",
            "15",
            "--max-time",
            "300",
            "--speed-limit",
            "1024",
            "--speed-time",
            "30",
            "--max-filesize",
            "268435456",
            "--output",
        ])
        .arg(destination)
        .arg(url)
        .output()
        .context("could not run curl; install curl and try again")?;
    command_succeeded("download the Blind release", &output)
}

fn verify_checksum(archive: &Path, manifest_path: &Path, asset: &str) -> Result<()> {
    let manifest = fs::read_to_string(manifest_path).context("could not read SHA256SUMS")?;
    let expected = expected_checksum(&manifest, asset)
        .with_context(|| format!("SHA256SUMS does not contain {asset}"))?;
    let mut input = File::open(archive).context("could not open the downloaded release")?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = input.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    let actual = hex::encode(hasher.finalize());
    if !actual.eq_ignore_ascii_case(expected) {
        bail!("downloaded Blind release failed SHA-256 verification");
    }
    Ok(())
}

fn expected_checksum<'a>(manifest: &'a str, asset: &str) -> Option<&'a str> {
    manifest.lines().find_map(|line| {
        let mut fields = line.split_whitespace();
        let checksum = fields.next()?;
        let name = fields.next()?.trim_start_matches('*');
        if fields.next().is_none()
            && name == asset
            && checksum.len() == 64
            && checksum.bytes().all(|byte| byte.is_ascii_hexdigit())
        {
            Some(checksum)
        } else {
            None
        }
    })
}

fn extract_single_binary(archive: &Path, unpack: &Path) -> Result<()> {
    let candidate = unpack.join("blind");
    let compressed = File::open(archive).context("could not open the Blind release archive")?;
    let mut tar = tar::Archive::new(GzDecoder::new(compressed));
    let mut entries = tar
        .entries()
        .context("could not read the Blind release archive")?;
    let mut entry = entries.next().context("release archive is empty")??;
    if entry.path()?.as_ref() != Path::new("blind") || !entry.header().entry_type().is_file() {
        bail!("release archive does not contain a regular blind binary");
    }
    const MAX_BINARY_BYTES: u64 = 128 * 1024 * 1024;
    let size = entry.size();
    if size > MAX_BINARY_BYTES {
        bail!("release binary exceeds the 128 MiB extraction limit");
    }
    let mut output = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&candidate)?;
    let copied = std::io::copy(&mut (&mut entry).take(MAX_BINARY_BYTES + 1), &mut output)?;
    if copied > MAX_BINARY_BYTES {
        bail!("release binary exceeds the 128 MiB extraction limit");
    }
    if copied != size {
        bail!("release binary was truncated during extraction");
    }
    output.set_permissions(fs::Permissions::from_mode(0o755))?;
    output.sync_all()?;
    drop(entry);
    if entries.next().is_some() {
        bail!("release archive must contain exactly one blind binary");
    }
    Ok(())
}

fn candidate_version(candidate: &Path) -> Result<String> {
    let mut child = Command::new(candidate)
        .arg("--version")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .context("could not execute the downloaded Blind release")?;
    let stdout = child
        .stdout
        .take()
        .context("could not capture Blind stdout")?;
    let stderr = child
        .stderr
        .take()
        .context("could not capture Blind stderr")?;
    let stdout_reader = std::thread::spawn(move || read_capped(stdout, 64 * 1024));
    let stderr_reader = std::thread::spawn(move || read_capped(stderr, 64 * 1024));
    let status = match child.wait_timeout(Duration::from_secs(10))? {
        Some(status) => status,
        None => {
            let _ = child.kill();
            let _ = child.wait();
            bail!("downloaded Blind release did not report its version within 10 seconds");
        }
    };
    let (stdout, stdout_overflow) = stdout_reader
        .join()
        .map_err(|_| anyhow::anyhow!("could not read Blind version output"))??;
    let (stderr, stderr_overflow) = stderr_reader
        .join()
        .map_err(|_| anyhow::anyhow!("could not read Blind version error output"))??;
    if stdout_overflow || stderr_overflow {
        bail!("downloaded Blind version output exceeds 64 KiB");
    }
    if !status.success() {
        let diagnostic = String::from_utf8_lossy(&stderr);
        bail!(
            "could not verify the downloaded Blind release: {}",
            diagnostic.trim()
        );
    }
    let stdout = std::str::from_utf8(&stdout)
        .context("downloaded Blind version output is not UTF-8")?
        .trim();
    let version = stdout
        .strip_prefix("blind ")
        .context("downloaded release did not identify itself as Blind")?;
    ReleaseVersion::parse(version).context("downloaded release reported an invalid version")?;
    Ok(version.to_owned())
}

fn read_capped<R: Read>(mut input: R, limit: usize) -> std::io::Result<(Vec<u8>, bool)> {
    let mut captured = Vec::new();
    let mut overflow = false;
    let mut buffer = [0_u8; 8 * 1024];
    loop {
        let read = input.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        let remaining = limit.saturating_sub(captured.len());
        let keep = remaining.min(read);
        captured.extend_from_slice(&buffer[..keep]);
        overflow |= keep < read;
    }
    Ok((captured, overflow))
}

fn atomic_replace(candidate: &Path, destination: &Path) -> Result<()> {
    let staged = sibling_path(destination, "update");
    let mut guard = StagedFile::new(staged.clone());
    copy_executable(candidate, &staged)?;
    if candidate_version(&staged)? != candidate_version(candidate)? {
        bail!("staged Blind binary changed during installation");
    }
    fs::rename(&staged, destination)
        .with_context(|| format!("could not replace {}", destination.display()))?;
    guard.disarm();
    sync_parent(destination);
    Ok(())
}

fn copy_executable(source_path: &Path, destination: &Path) -> Result<()> {
    let mut source = File::open(source_path)?;
    let mut output = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(destination)?;
    std::io::copy(&mut source, &mut output)?;
    output.flush()?;
    output.set_permissions(fs::Permissions::from_mode(0o755))?;
    output.sync_all()?;
    Ok(())
}

fn sibling_path(destination: &Path, purpose: &str) -> PathBuf {
    let parent = destination.parent().unwrap_or_else(|| Path::new("."));
    let mut suffix = [0_u8; 8];
    rand::thread_rng().fill_bytes(&mut suffix);
    parent.join(format!(
        ".blind.{purpose}.{}-{}",
        std::process::id(),
        hex::encode(suffix)
    ))
}

fn sync_parent(path: &Path) {
    if let Some(parent) = path.parent()
        && let Ok(directory) = File::open(parent)
    {
        let _ = directory.sync_all();
    }
}

fn command_succeeded(action: &str, output: &Output) -> Result<()> {
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    let stdout = String::from_utf8_lossy(&output.stdout);
    let diagnostic = if stderr.trim().is_empty() {
        stdout.trim()
    } else {
        stderr.trim()
    };
    if diagnostic.is_empty() {
        bail!("could not {action}: {}", output.status);
    }
    bail!("could not {action}: {diagnostic}");
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
struct ReleaseVersion(u64, u64, u64);

impl ReleaseVersion {
    fn parse(value: &str) -> Result<Self> {
        let value = value.strip_prefix('v').unwrap_or(value);
        let mut parts = value.split('.');
        let major = parts.next().context("missing major version")?.parse()?;
        let minor = parts.next().context("missing minor version")?.parse()?;
        let patch = parts.next().context("missing patch version")?.parse()?;
        if parts.next().is_some() {
            bail!("version must contain exactly three numeric components");
        }
        Ok(Self(major, minor, patch))
    }
}

struct UpdateLock {
    path: PathBuf,
    #[cfg(target_os = "macos")]
    pid: u32,
    #[cfg(target_os = "linux")]
    file: File,
}

impl UpdateLock {
    fn acquire(executable: &Path) -> Result<Self> {
        let parent = executable
            .parent()
            .context("Blind executable has no parent directory")?;
        let path = parent.join(".blind.update.lock");
        #[cfg(target_os = "macos")]
        {
            let pid = std::process::id();
            let output = Command::new("/usr/bin/shlock")
                .args([
                    "-f",
                    path.to_string_lossy().as_ref(),
                    "-p",
                    &pid.to_string(),
                ])
                .output()
                .context("could not run the macOS update lock helper")?;
            if !output.status.success() {
                bail!("another Blind install or update is already running");
            }
            Ok(Self { path, pid })
        }
        #[cfg(target_os = "linux")]
        {
            let file = OpenOptions::new()
                .create(true)
                .read(true)
                .write(true)
                .mode(0o600)
                .open(&path)
                .context("could not open the Blind update lock")?;
            let result = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
            if result != 0 {
                bail!("another Blind install or update is already running");
            }
            file.set_len(0)?;
            let mut lock_contents = &file;
            lock_contents.write_all(std::process::id().to_string().as_bytes())?;
            file.sync_all()?;
            Ok(Self { path, file })
        }
        #[cfg(not(any(target_os = "macos", target_os = "linux")))]
        bail!("Blind updates are not available on this operating system")
    }
}

impl Drop for UpdateLock {
    fn drop(&mut self) {
        #[cfg(target_os = "macos")]
        {
            let owned = fs::read_to_string(&self.path)
                .ok()
                .and_then(|value| value.trim().parse::<u32>().ok())
                == Some(self.pid);
            if owned {
                let _ = fs::remove_file(&self.path);
            }
        }
        #[cfg(target_os = "linux")]
        {
            let _ = unsafe { libc::flock(self.file.as_raw_fd(), libc::LOCK_UN) };
            let _ = fs::remove_file(&self.path);
        }
    }
}

struct UpdateTempDir {
    path: PathBuf,
}

impl UpdateTempDir {
    fn create() -> Result<Self> {
        let parent = safe_temp_parent()?;
        for _ in 0..16 {
            let path = parent.join(format!(
                "blind-update-{}-{:016x}",
                std::process::id(),
                rand::random::<u64>()
            ));
            let mut builder = DirBuilder::new();
            builder.mode(0o700);
            match builder.create(&path) {
                Ok(()) => return Ok(Self { path }),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(error).context("could not create update directory"),
            }
        }
        bail!("could not allocate a unique update directory");
    }
}

fn safe_temp_parent() -> Result<PathBuf> {
    use std::os::unix::fs::MetadataExt;

    let parent = platform_temp_dir()?;
    let metadata = fs::metadata(&parent)
        .with_context(|| format!("could not inspect temporary directory {}", parent.display()))?;
    let mode = metadata.mode();
    let uid = unsafe { libc::getuid() };
    if !temp_parent_is_safe(uid, metadata.uid(), mode, metadata.is_dir()) {
        bail!(
            "temporary directory {} is not private or sticky",
            parent.display()
        );
    }
    Ok(parent)
}

#[cfg(target_os = "macos")]
fn platform_temp_dir() -> Result<PathBuf> {
    const CS_DARWIN_USER_TEMP_DIR: libc::c_int = 65_537;
    let required = unsafe { libc::confstr(CS_DARWIN_USER_TEMP_DIR, std::ptr::null_mut(), 0) };
    if required == 0 {
        return Err(std::io::Error::last_os_error())
            .context("could not resolve the macOS user temporary directory");
    }
    let mut buffer = vec![0_u8; required];
    let written = unsafe {
        libc::confstr(
            CS_DARWIN_USER_TEMP_DIR,
            buffer.as_mut_ptr().cast(),
            buffer.len(),
        )
    };
    if written == 0 || written > buffer.len() {
        bail!("macOS returned an invalid user temporary directory");
    }
    let path = CStr::from_bytes_until_nul(&buffer)
        .context("macOS user temporary directory is not NUL terminated")?
        .to_bytes()
        .to_vec();
    Ok(PathBuf::from(std::ffi::OsString::from_vec(path)))
}

#[cfg(target_os = "linux")]
fn platform_temp_dir() -> Result<PathBuf> {
    Ok(std::env::var_os("XDG_RUNTIME_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir))
}

fn temp_parent_is_safe(uid: u32, owner: u32, mode: u32, is_dir: bool) -> bool {
    let owner_private = owner == uid && mode & 0o022 == 0;
    let sticky_system = owner == 0 && mode & 0o1000 != 0;
    is_dir && (owner_private || sticky_system)
}

impl Drop for UpdateTempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

struct StagedFile {
    path: Option<PathBuf>,
}

impl StagedFile {
    fn new(path: PathBuf) -> Self {
        Self { path: Some(path) }
    }

    fn disarm(&mut self) {
        self.path = None;
    }
}

impl Drop for StagedFile {
    fn drop(&mut self) {
        if let Some(path) = &self.path {
            let _ = fs::remove_file(path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_release_versions_for_ordering() {
        assert!(ReleaseVersion::parse("0.3.1").unwrap() > ReleaseVersion::parse("v0.3.0").unwrap());
        assert!(ReleaseVersion::parse("0.3").is_err());
        assert!(ReleaseVersion::parse("0.3.1-beta").is_err());
    }

    #[test]
    fn checksum_manifest_requires_an_exact_asset_name() {
        let digest = "a".repeat(64);
        let manifest = format!("{digest}  blind-aarch64-apple-darwin.tar.gz\n");
        assert_eq!(
            expected_checksum(&manifest, "blind-aarch64-apple-darwin.tar.gz"),
            Some(digest.as_str())
        );
        assert_eq!(
            expected_checksum(&manifest, "blind-x86_64-apple-darwin.tar.gz"),
            None
        );
    }

    #[test]
    fn release_targets_keep_platform_asset_names_stable() {
        assert_eq!(
            release_target_for("macos", "aarch64").unwrap(),
            "aarch64-apple-darwin"
        );
        assert_eq!(
            release_target_for("linux", "x86_64").unwrap(),
            "linux-x86_64"
        );
        assert!(release_target_for("linux", "aarch64").is_err());
    }

    #[test]
    fn rejects_release_assets_from_an_unexpected_url() {
        let release = GitHubRelease {
            tag_name: "v0.3.1".into(),
            assets: vec![GitHubAsset {
                name: "SHA256SUMS".into(),
                browser_download_url: "https://example.com/SHA256SUMS".into(),
            }],
        };
        assert!(release_asset_url(&release, "SHA256SUMS").is_err());
    }

    #[test]
    fn root_cannot_self_update() {
        assert!(
            reject_root(0)
                .unwrap_err()
                .to_string()
                .contains("without sudo")
        );
    }

    #[test]
    fn update_directory_is_private() {
        let directory = UpdateTempDir::create().unwrap();
        let mode = fs::metadata(&directory.path).unwrap().permissions().mode();
        assert_eq!(mode & 0o077, 0);
    }

    #[test]
    fn unsafe_shared_temp_parent_is_rejected_by_policy() {
        assert!(temp_parent_is_safe(501, 501, 0o700, true));
        assert!(temp_parent_is_safe(501, 0, 0o1777, true));
        assert!(!temp_parent_is_safe(501, 502, 0o777, true));
        assert!(!temp_parent_is_safe(501, 501, 0o777, true));
    }

    #[test]
    fn atomic_replace_keeps_an_executable_binary() {
        let directory = tempfile::tempdir().unwrap();
        let candidate = directory.path().join("candidate");
        let destination = directory.path().join("blind");
        fs::write(&candidate, b"#!/bin/sh\necho 'blind 9.8.7'\n").unwrap();
        fs::set_permissions(&candidate, fs::Permissions::from_mode(0o755)).unwrap();
        fs::write(&destination, b"old").unwrap();

        atomic_replace(&candidate, &destination).unwrap();

        assert_eq!(
            fs::read(&destination).unwrap(),
            fs::read(&candidate).unwrap()
        );
        assert_ne!(
            fs::metadata(&destination).unwrap().permissions().mode() & 0o111,
            0
        );
    }

    #[test]
    fn committed_update_can_restore_the_previous_executable() {
        let directory = tempfile::tempdir().unwrap();
        let destination = directory.path().join("blind");
        write_version_script(&destination, "0.3.0");
        let update_temp = UpdateTempDir::create().unwrap();
        let candidate = update_temp.path.join("blind");
        write_version_script(&candidate, "0.3.1");
        let prepared = PreparedUpdate {
            current: "0.3.0".into(),
            latest: "0.3.1".into(),
            lock: UpdateLock::acquire(&destination).unwrap(),
            destination: destination.clone(),
            candidate,
            temp: update_temp,
        };

        let CommitOutcome::Updated(committed) = prepared.commit().unwrap() else {
            panic!("expected an update");
        };
        assert_eq!(candidate_version(&destination).unwrap(), "0.3.1");
        committed.rollback().unwrap();

        assert_eq!(candidate_version(&destination).unwrap(), "0.3.0");
        assert!(!directory.path().join(".blind.update.lock").exists());
    }

    #[test]
    fn extracts_only_the_expected_single_binary() {
        let directory = tempfile::tempdir().unwrap();
        let archive = directory.path().join("blind.tar.gz");
        write_test_archive(&archive, &[("blind", b"binary")]);
        let unpack = directory.path().join("unpack");
        fs::create_dir(&unpack).unwrap();

        extract_single_binary(&archive, &unpack).unwrap();

        assert_eq!(fs::read(unpack.join("blind")).unwrap(), b"binary");
        assert_ne!(
            fs::metadata(unpack.join("blind"))
                .unwrap()
                .permissions()
                .mode()
                & 0o111,
            0
        );
    }

    #[test]
    fn rejects_release_archives_with_extra_entries() {
        let directory = tempfile::tempdir().unwrap();
        let archive = directory.path().join("blind.tar.gz");
        write_test_archive(&archive, &[("blind", b"binary"), ("extra", b"unexpected")]);
        let unpack = directory.path().join("unpack");
        fs::create_dir(&unpack).unwrap();

        let error = extract_single_binary(&archive, &unpack)
            .unwrap_err()
            .to_string();

        assert!(error.contains("exactly one"));
    }

    #[test]
    fn rejects_pax_size_overrides_above_the_extraction_limit() {
        use flate2::{Compression, write::GzEncoder};

        let directory = tempfile::tempdir().unwrap();
        let archive_path = directory.path().join("blind.tar.gz");
        let file = File::create(&archive_path).unwrap();
        let encoder = GzEncoder::new(file, Compression::default());
        let mut archive = tar::Builder::new(encoder);
        let pax_size = (128_u64 * 1024 * 1024 + 1).to_string();
        archive
            .append_pax_extensions([("size", pax_size.as_bytes())])
            .unwrap();
        let mut header = tar::Header::new_gnu();
        header.set_path("blind").unwrap();
        header.set_size(6);
        header.set_mode(0o755);
        header.set_cksum();
        archive.append(&header, &b"binary"[..]).unwrap();
        archive.finish().unwrap();
        archive.into_inner().unwrap().finish().unwrap();
        let unpack = directory.path().join("unpack");
        fs::create_dir(&unpack).unwrap();

        let error = extract_single_binary(&archive_path, &unpack)
            .unwrap_err()
            .to_string();

        assert!(error.contains("128 MiB"));
    }

    fn write_test_archive(path: &Path, entries: &[(&str, &[u8])]) {
        use flate2::{Compression, write::GzEncoder};

        let file = File::create(path).unwrap();
        let encoder = GzEncoder::new(file, Compression::default());
        let mut archive = tar::Builder::new(encoder);
        for (name, contents) in entries {
            let mut header = tar::Header::new_gnu();
            header.set_path(name).unwrap();
            header.set_size(contents.len() as u64);
            header.set_mode(0o755);
            header.set_cksum();
            archive.append(&header, *contents).unwrap();
        }
        archive.finish().unwrap();
        archive.into_inner().unwrap().finish().unwrap();
    }

    fn write_version_script(path: &Path, version: &str) {
        fs::write(path, format!("#!/bin/sh\necho 'blind {version}'\n")).unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
    }
}
