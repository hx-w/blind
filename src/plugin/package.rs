//! Package validation and immutable installation; never executes a resolver.
//! Public package files cannot alias private dotenv data.
use super::components::validate_renderers;
use super::{
    Installed, Manifest, RendererBundle, environment_path, installed, installed_path, list, scheme,
    valid_id,
};
use crate::runtime::files::{private_dir, private_file, write_private};
use anyhow::{Context, Result, ensure};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::io::Read;
use std::{
    collections::{BTreeMap, HashSet},
    fs,
    path::{Path, PathBuf},
};
pub(crate) fn read_manifest(directory: &Path) -> Result<Manifest> {
    let bytes = read_package_file(directory, "blind-plugin.toml", super::LIMIT)?;
    let text = std::str::from_utf8(&bytes).context("plugin manifest must be UTF-8")?;
    let manifest: Manifest =
        toml::from_str(text).map_err(|_| anyhow::anyhow!("invalid blind-plugin.toml"))?;
    validate_manifest(&manifest)?;
    Ok(manifest)
}

pub(crate) fn validate_manifest(m: &Manifest) -> Result<()> {
    ensure!(valid_id(&m.id), "invalid plugin ID");
    super::update::version(&m.version)?;
    if let Some(update) = &m.update {
        super::update::validate_repository(&update.repository)?;
    }
    ensure!(
        !m.name.trim().is_empty() && m.name.len() <= 256 && m.version.len() <= 128,
        "name and version are required"
    );
    ensure!(
        !m.authors.is_empty() && m.authors.len() <= 64,
        "authors are required"
    );
    for author in &m.authors {
        ensure!(
            !author.name.trim().is_empty() && author.name.len() <= 256,
            "author name is required"
        );
        if let Some(email) = &author.email {
            ensure!(
                !email.is_empty() && email.len() <= 320 && !email.chars().any(char::is_control),
                "invalid author email"
            );
        }
        if let Some(url) = &author.url {
            validate_public_url(url)?;
        }
    }
    for url in [&m.repository, &m.homepage].into_iter().flatten() {
        validate_public_url(url)?;
    }
    ensure!(
        m.license
            .as_ref()
            .is_none_or(|value| !value.trim().is_empty() && value.len() <= 256),
        "invalid plugin license"
    );
    ensure!(
        m.description.len() <= 64 * 1024,
        "plugin description is too large"
    );
    ensure!(
        m.keywords.len() <= 64
            && m.keywords
                .iter()
                .all(|word| !word.trim().is_empty() && word.len() <= 128),
        "invalid plugin keywords"
    );
    ensure!(
        m.protocol_versions.contains(&2),
        "plugin has no compatible protocol (Host supports 2)"
    );
    ensure!(
        m.protocol_versions.len() <= 16
            && !m.protocol_versions.contains(&0)
            && m.protocol_versions.iter().collect::<HashSet<_>>().len()
                == m.protocol_versions.len(),
        "invalid or repeated protocol version"
    );
    ensure!(
        m.schemes.len() <= 64 && m.schemes.iter().all(|scheme| scheme.len() <= 64),
        "too many or oversized plugin schemes"
    );
    ensure!(
        (!m.schemes.is_empty() && !m.entrypoint.is_empty())
            || (m.schemes.is_empty() && m.entrypoint.is_empty() && !m.components.is_empty()),
        "plugin needs a resolver or components"
    );
    ensure!(m.files.len() <= 1024, "too many package files");
    let mut paths = HashSet::new();
    for file in &m.files {
        validate_relative_path(file)?;
        ensure!(
            file != "blind-plugin.toml"
                && file != "blind-plugin.json"
                && !file.split('/').any(|part| part == ".env")
                && paths.insert(file),
            "invalid, private or repeated package file"
        );
    }
    ensure!(
        m.entrypoint.len() <= 64
            && m.entrypoint
                .iter()
                .all(|arg| !arg.contains('\0') && arg.len() <= 4096),
        "invalid resolver entrypoint"
    );
    validate_renderers(m)?;
    let mut seen = HashSet::new();
    for s in &m.schemes {
        ensure!(
            scheme(&format!("{s}://x")) == Some(s.as_str())
                && !["oss", "http", "https", "file"].contains(&s.as_str())
                && seen.insert(s),
            "invalid, reserved or repeated plugin scheme"
        );
    }
    super::config::validate_environment_schema(m)?;
    Ok(())
}

fn validate_public_url(value: &str) -> Result<()> {
    ensure!(value.len() <= 4096, "public metadata URL is too large");
    let url = url::Url::parse(value).context("invalid public metadata URL")?;
    ensure!(
        ["http", "https"].contains(&url.scheme())
            && url.host_str().is_some()
            && url.username().is_empty()
            && url.password().is_none(),
        "invalid public metadata URL"
    );
    Ok(())
}
fn executable(command: &str, package: &Path) -> Result<PathBuf> {
    let path = Path::new(command);
    let resolved = if path.is_absolute() {
        path.to_owned()
    } else if command.contains('/') {
        package.join(path)
    } else {
        std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())
            .map(|p| p.join(command))
            .find(|p| p.is_file())
            .with_context(|| {
                format!("runtime {command} not found; install it on this host first")
            })?
    };
    let resolved = fs::canonicalize(resolved)?;
    ensure!(
        resolved.is_file(),
        "plugin entrypoint must be a regular file"
    );
    #[cfg(unix)]
    if !resolved.starts_with(package) {
        use std::os::unix::fs::PermissionsExt;
        ensure!(
            fs::metadata(&resolved)?.permissions().mode() & 0o111 != 0,
            "plugin runtime is not executable"
        );
    }
    Ok(resolved)
}
/// A private immutable snapshot, owned for the whole invocation. Its dotenv values
/// never enter the snapshot, renderer bundle or package revision.
pub struct PreparedPackage {
    pub(super) package: Installed,
    pub(super) environment: BTreeMap<String, String>,
    bundle: RendererBundle,
    revision: String,
    snapshot: tempfile::TempDir,
}

impl PreparedPackage {
    pub fn manifest(&self) -> &Manifest {
        &self.package.manifest
    }

    pub fn renderer_bundle(&self) -> &RendererBundle {
        &self.bundle
    }

    pub(crate) fn into_renderer_bundle(self) -> RendererBundle {
        self.bundle
    }

    pub(crate) fn same_resolution(&self, other: &Self) -> bool {
        let runtime = self.package.executable.strip_prefix(self.snapshot.path());
        let other_runtime = other.package.executable.strip_prefix(other.snapshot.path());
        self.revision == other.revision
            && self.environment == other.environment
            && match (runtime, other_runtime) {
                (Ok(runtime), Ok(other_runtime)) => runtime == other_runtime,
                (Err(_), Err(_)) => self.package.executable == other.package.executable,
                _ => false,
            }
    }
}

fn directory_environment(directory: &Path) -> Result<Vec<u8>> {
    let path = directory.join(".env");
    if fs::symlink_metadata(&path).is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound)
    {
        return Ok(Vec::new());
    }
    // Dotenv is read only through this private import path, never a public file read.
    let (_, canonical) = canonical_package_file(directory, ".env")?;
    read_bounded_file(fs::File::open(canonical)?, super::LIMIT)
}

pub fn prepare_directory(directory: &Path) -> Result<PreparedPackage> {
    let directory = fs::canonicalize(directory)?;
    let manifest = read_manifest(&directory)?;
    let bytes = directory_environment(&directory)?;
    let environment = super::config::parse_environment(&manifest, &bytes)?;
    prepare_snapshot(
        &directory,
        manifest,
        environment,
        tempfile::Builder::new().prefix("blind-plugin-").tempdir()?,
    )
}

pub(super) fn prepare_installed(dir: &Path, id: &str) -> Result<PreparedPackage> {
    let receipt = installed(dir, id)?;
    let versions = fs::canonicalize(dir.join("plugins").join(id).join("versions"))?;
    let directory = fs::canonicalize(&receipt.directory)?;
    ensure!(
        directory.starts_with(&versions),
        "installed package escapes plugin versions"
    );
    let manifest = read_manifest(&directory)?;
    ensure!(
        manifest.id == id
            && serde_json::to_vec(&manifest)? == serde_json::to_vec(&receipt.manifest)?,
        "installed plugin metadata does not match receipt"
    );
    let environment = super::environment(dir, &manifest)?;
    let prepared = prepare_snapshot(
        &directory,
        manifest,
        environment,
        tempfile::Builder::new().prefix("blind-plugin-").tempdir()?,
    )?;
    ensure!(
        directory.file_name().and_then(|name| name.to_str()) == Some(prepared.revision.as_str()),
        "installed package integrity check failed"
    );
    Ok(prepared)
}

fn prepare_snapshot(
    directory: &Path,
    mut manifest: Manifest,
    environment: BTreeMap<String, String>,
    snapshot: tempfile::TempDir,
) -> Result<PreparedPackage> {
    let runtime = match manifest.entrypoint.first() {
        Some(entry) => executable(entry, directory)?,
        None => PathBuf::new(),
    };
    if runtime.starts_with(directory) {
        let relative = runtime.strip_prefix(directory)?;
        ensure!(
            manifest
                .files
                .iter()
                .any(|file| Path::new(file) == relative),
            "packaged executable must appear in files"
        );
        manifest.entrypoint[0] = format!(
            "./{}",
            relative.to_str().context("entrypoint must be UTF-8")?
        );
    }
    // Absolute arguments naming declared package files must also address the
    // captured copy, never the mutable source directory.
    for argument in manifest.entrypoint.iter_mut().skip(1) {
        let path = Path::new(argument);
        if path.is_absolute() && path.starts_with(directory) {
            let relative = path.strip_prefix(directory)?;
            ensure!(
                manifest
                    .files
                    .iter()
                    .any(|file| Path::new(file) == relative),
                "entrypoint package argument must appear in files"
            );
            *argument = format!(
                "./{}",
                relative
                    .to_str()
                    .context("entrypoint argument must be UTF-8")?
            );
        }
    }
    let mut hash = Sha256::new();
    super::hash_field(&mut hash, b"blind.package.v2");
    super::hash_field(&mut hash, &serde_json::to_vec(&manifest)?);
    let mut documents = BTreeMap::new();
    let mut total = 0usize;
    let mut browser_total = 0usize;
    for file in &manifest.files {
        let browser = manifest
            .components
            .iter()
            .any(|component| component.entrypoint == *file);
        let limit = if browser {
            super::components::MAX_DOCUMENT
        } else {
            64 * 1024 * 1024
        };
        let bytes = read_package_file(directory, file, limit)?;
        total += bytes.len();
        ensure!(total <= 256 * 1024 * 1024, "plugin package too large");
        super::hash_field(&mut hash, file.as_bytes());
        super::hash_field(&mut hash, &bytes);
        write_private(&snapshot.path().join(file), &bytes)?;
        if browser {
            let html = String::from_utf8(bytes).context("renderer document must be UTF-8 HTML")?;
            super::components::validate_document(file, &html)?;
            browser_total += html.len();
            ensure!(
                browser_total <= super::components::MAX_DOCUMENTS,
                "renderer bundle exceeds 8 MiB"
            );
            documents.insert(file.clone(), html);
        }
    }
    let runtime = if runtime.starts_with(directory) {
        let relative = runtime.strip_prefix(directory)?;
        let target = snapshot.path().join(relative);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&target, fs::Permissions::from_mode(0o700))?;
        }
        target
    } else {
        runtime
    };
    write_private(
        &snapshot.path().join("blind-plugin.toml"),
        toml::to_string(&manifest)?.as_bytes(),
    )?;
    let bundle = RendererBundle {
        id: manifest.id.clone(),
        version: manifest.version.clone(),
        components: manifest.components.clone(),
        documents,
    };
    bundle.validate()?;
    let package = Installed {
        directory: snapshot.path().to_owned(),
        executable: runtime,
        manifest,
    };
    Ok(PreparedPackage {
        package,
        environment,
        bundle,
        revision: format!("sha256:{}", hex::encode(hash.finalize())),
        snapshot,
    })
}

pub(crate) fn install_package(dir: &Path, directory: &Path) -> Result<String> {
    let directory = fs::canonicalize(directory)?;
    let manifest = read_manifest(&directory)?;
    for plugin in list(dir)?["plugins"]
        .as_array()
        .context("invalid plugin list")?
    {
        if plugin["id"] != manifest.id {
            for scheme in &manifest.schemes {
                ensure!(
                    !plugin["schemes"]
                        .as_array()
                        .is_some_and(|values| values.contains(&json!(scheme))),
                    "scheme {scheme} is already registered"
                );
            }
        }
    }
    let id = manifest.id.clone();
    let private_environment = environment_path(dir, &id)?;
    let retain_environment = private_environment.exists() || installed_path(dir, &id)?.exists();
    let environment_bytes = if retain_environment {
        super::config::read_environment(&private_environment)?
    } else {
        directory_environment(&directory)?
    };
    let environment = super::config::parse_environment(&manifest, &environment_bytes)?;
    let versions = dir.join("plugins").join(&id).join("versions");
    private_dir(
        versions
            .parent()
            .context("plugin versions have no parent")?,
    )?;
    private_dir(&versions)?;
    let versions = fs::canonicalize(&versions)?;
    let mut prepared = prepare_snapshot(
        &directory,
        manifest,
        environment,
        tempfile::tempdir_in(&versions)?,
    )?;
    let destination = versions.join(&prepared.revision);
    if destination.exists() {
        for file in prepared
            .package
            .manifest
            .files
            .iter()
            .map(String::as_str)
            .chain(["blind-plugin.toml"])
        {
            ensure!(
                fs::read(destination.join(file))? == fs::read(prepared.snapshot.path().join(file))?,
                "installed package integrity check failed"
            );
        }
    } else {
        fs::rename(prepared.snapshot.path(), &destination)?;
    }
    if prepared
        .package
        .executable
        .starts_with(&prepared.package.directory)
    {
        prepared.package.executable = destination.join(
            prepared
                .package
                .executable
                .strip_prefix(&prepared.package.directory)?,
        );
    }
    prepared.package.directory = destination;
    let receipt = serde_json::to_vec_pretty(&prepared.package)?;
    // An existing .env is never rewritten. First-install imports are published
    // before the receipt; a receipt-write failure rolls that import back.
    if !retain_environment {
        write_private(&private_environment, &environment_bytes)?;
    } else if private_environment.exists() {
        private_file(&private_environment)?;
    }
    if let Err(error) = write_private(&installed_path(dir, &id)?, &receipt) {
        if !retain_environment {
            fs::remove_file(&private_environment)
                .context("could not roll back private environment import")?;
        }
        return Err(error);
    }
    Ok(id)
}
pub(crate) fn lock_admin(dir: &Path) -> Result<fs::File> {
    private_dir(dir)?;
    let path = dir.join("plugins.lock");
    let mut options = fs::OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let file = options.open(path)?;
    #[cfg(unix)]
    {
        use std::os::fd::AsRawFd;
        ensure!(
            unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0,
            "another plugin administration command is running; retry after it finishes"
        );
    }
    Ok(file)
}

pub(super) fn validate_relative_path(file: &str) -> Result<()> {
    ensure!(
        !file.is_empty()
            && file.len() <= 512
            && !file.contains(['\\', '\0', ':'])
            && file
                .split('/')
                .all(|part| !part.is_empty() && part != "." && part != "..")
            && !Path::new(file).is_absolute(),
        "package paths must be relative without traversal"
    );
    Ok(())
}

fn canonical_package_file(directory: &Path, file: &str) -> Result<(PathBuf, PathBuf)> {
    validate_relative_path(file)?;
    let directory = fs::canonicalize(directory)?;
    let canonical = fs::canonicalize(directory.join(file))?;
    ensure!(
        canonical.starts_with(&directory) && canonical.is_file(),
        "package file escapes package"
    );
    Ok((directory, canonical))
}

fn open_package_file(directory: &Path, file: &str) -> Result<fs::File> {
    let (directory, canonical) = canonical_package_file(directory, file)?;
    ensure!(
        !canonical
            .strip_prefix(&directory)?
            .components()
            .any(|part| part.as_os_str() == ".env")
            && !file.split('/').any(|part| part == ".env"),
        "public package file aliases private environment"
    );
    let opened = fs::File::open(canonical)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        match fs::metadata(directory.join(".env")) {
            Ok(environment) => {
                let public = opened.metadata()?;
                ensure!(
                    public.dev() != environment.dev() || public.ino() != environment.ino(),
                    "public package file aliases private environment"
                );
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    Ok(opened)
}

pub(super) fn read_package_file(directory: &Path, file: &str, limit: usize) -> Result<Vec<u8>> {
    read_bounded_file(open_package_file(directory, file)?, limit)
}

fn read_bounded_file(file: fs::File, limit: usize) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    file.take((limit + 1) as u64).read_to_end(&mut bytes)?;
    ensure!(bytes.len() <= limit, "plugin file too large");
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn entrypoint_and_administration_boundaries() {
        let dir = tempfile::tempdir().unwrap();
        assert!(executable(dir.path().to_str().unwrap(), dir.path()).is_err());
        let lock = lock_admin(dir.path()).unwrap();
        assert!(lock_admin(dir.path()).is_err());
        drop(lock);
        assert!(lock_admin(dir.path()).is_ok());
    }

    #[test]
    fn package_files_reject_traversal_oversize_and_symlink_escape() {
        for path in [
            "",
            "../x.html",
            "/x.html",
            "a//x.html",
            "./x.html",
            "a\\x.html",
            "a:x.html",
        ] {
            assert!(validate_relative_path(path).is_err());
        }
        let package = tempfile::tempdir().unwrap();
        fs::write(package.path().join("x.html"), b"12345").unwrap();
        assert!(read_package_file(package.path(), "x.html", 4).is_err());
        #[cfg(unix)]
        {
            let outside = tempfile::NamedTempFile::new().unwrap();
            std::os::unix::fs::symlink(outside.path(), package.path().join("escape.html")).unwrap();
            assert!(read_package_file(package.path(), "escape.html", 4096).is_err());
        }
    }

    #[test]
    fn malformed_package_declarations_and_browser_encoding_do_not_install() {
        let host = tempfile::tempdir().unwrap();
        let package = tempfile::tempdir().unwrap();
        let original = json!({"id":"example","name":"Example","version":"1.0.0","authors":[{"name":"Example Team"}],
            "files":["table.html"],"components":[{"name":"table","entrypoint":"table.html","api_version":1}]});
        fs::write(package.path().join("table.html"), b"<p>inline</p>").unwrap();
        for invalid in 0..11 {
            let mut manifest = original.clone();
            match invalid {
                0 => manifest["version"] = json!("1.0"),
                1 => manifest["protocol_versions"] = json!([2, 2]),
                2 => manifest["files"] = json!(["table.html", "table.html"]),
                3 => {
                    manifest["schemes"] = json!(["oss"]);
                    manifest["entrypoint"] = json!(["/bin/sh"]);
                }
                4 => manifest["typo"] = json!(true),
                5 => {
                    manifest["env"] = json!({"COUNT":{"type":"integer","default":"not an integer"}})
                }
                6 => manifest["components"][0]["extensions"] = json!(["trace", "trace"]),
                7 => manifest["authors"] = json!([]),
                8 => manifest["files"] = json!(["table.html", ".env"]),
                9 => manifest["config_schema"] = json!({}),
                _ => manifest["env"] = json!({"TOKEN":{"secret":true,"default":"private"}}),
            }
            fs::write(
                package.path().join("blind-plugin.toml"),
                toml::to_string(&manifest).unwrap(),
            )
            .unwrap();
            assert!(
                install_package(host.path(), package.path()).is_err(),
                "installed malformed package {invalid}"
            );
            assert!(!installed_path(host.path(), "example").unwrap().exists());
        }
        fs::write(
            package.path().join("blind-plugin.toml"),
            toml::to_string(&original).unwrap(),
        )
        .unwrap();
        fs::write(package.path().join("table.html"), [0xff]).unwrap();
        assert!(install_package(host.path(), package.path()).is_err());
    }

    fn environment_package(directory: &Path, version: &str) {
        fs::write(directory.join("viewer.html"), "<p>renderer</p>").unwrap();
        let manifest = json!({
            "id":"example","name":"Example","version":version,"authors":[{"name":"Team"}],
            "files":["viewer.html"],"components":[{"name":"viewer","entrypoint":"viewer.html","api_version":1}],
            "env":{"TOKEN":{"required":true,"secret":true},"COUNT":{"type":"integer","default":3}}
        });
        fs::write(
            directory.join("blind-plugin.toml"),
            toml::to_string(&manifest).unwrap(),
        )
        .unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn public_files_reject_symlink_and_hardlink_aliases_to_private_environment() {
        use std::os::unix::fs::symlink;

        let environment = b"TOKEN=private\nCOUNT=5\n";
        for private_target in [".env", "private/values", "private/.env"] {
            for hardlink in [false, true] {
                let host = tempfile::tempdir().unwrap();
                let source = tempfile::tempdir().unwrap();
                environment_package(source.path(), "1.0.0");
                fs::create_dir(source.path().join("private")).unwrap();
                fs::write(source.path().join(private_target), environment).unwrap();
                if private_target != ".env" {
                    symlink(private_target, source.path().join(".env")).unwrap();
                }
                fs::remove_file(source.path().join("viewer.html")).unwrap();
                if hardlink {
                    fs::hard_link(
                        source.path().join(private_target),
                        source.path().join("viewer.html"),
                    )
                    .unwrap();
                } else {
                    symlink(private_target, source.path().join("viewer.html")).unwrap();
                }

                assert_eq!(directory_environment(source.path()).unwrap(), environment);
                for public in [".env", "viewer.html"] {
                    let error =
                        read_package_file(source.path(), public, super::super::LIMIT).unwrap_err();
                    assert!(error.to_string().contains("private environment"));
                }
                let error = prepare_directory(source.path()).err().unwrap();
                assert!(error.to_string().contains("private environment"));
                let error = install_package(host.path(), source.path()).unwrap_err();
                assert!(error.to_string().contains("private environment"));
                assert!(!installed_path(host.path(), "example").unwrap().exists());
                assert!(!environment_path(host.path(), "example").unwrap().exists());
                assert_eq!(
                    fs::read(source.path().join(private_target)).unwrap(),
                    environment
                );
            }
        }
    }

    #[cfg(unix)]
    #[test]
    fn internal_public_aliases_and_private_environment_import_remain_allowed() {
        use std::os::unix::fs::symlink;

        let host = tempfile::tempdir().unwrap();
        let source = tempfile::tempdir().unwrap();
        environment_package(source.path(), "1.0.0");
        fs::create_dir(source.path().join("internal")).unwrap();
        let html = "<p>safe renderer</p>";
        fs::write(source.path().join("internal/renderer.html"), html).unwrap();
        fs::remove_file(source.path().join("viewer.html")).unwrap();
        symlink("internal/renderer.html", source.path().join("viewer.html")).unwrap();
        fs::hard_link(
            source.path().join("internal/renderer.html"),
            source.path().join("safe.html"),
        )
        .unwrap();
        let environment = b"TOKEN=private\nCOUNT=5\n";
        fs::write(source.path().join("internal/values"), environment).unwrap();
        symlink("internal/values", source.path().join(".env")).unwrap();

        for public in ["internal/renderer.html", "viewer.html", "safe.html"] {
            assert_eq!(
                read_package_file(source.path(), public, super::super::LIMIT).unwrap(),
                html.as_bytes()
            );
        }
        let prepared = prepare_directory(source.path()).unwrap();
        assert_eq!(prepared.environment["TOKEN"], "private");
        assert_eq!(prepared.renderer_bundle().documents["viewer.html"], html);
        assert_eq!(prepared.renderer_bundle().documents.len(), 1);
        assert!(!prepared.snapshot.path().join(".env").exists());
        assert!(!prepared.snapshot.path().join("internal/values").exists());
        let snapshot = prepared.snapshot.path().to_owned();
        let bundle = prepared.into_renderer_bundle();
        assert_eq!(bundle.documents["viewer.html"], html);
        assert!(!snapshot.exists());

        install_package(host.path(), source.path()).unwrap();
        assert_eq!(
            fs::read(environment_path(host.path(), "example").unwrap()).unwrap(),
            environment
        );
        let installed = prepare_installed(host.path(), "example").unwrap();
        assert_eq!(installed.environment["TOKEN"], "private");
        assert_eq!(installed.renderer_bundle().documents["viewer.html"], html);
        assert!(!installed.package.directory.join(".env").exists());
        assert!(!installed.package.directory.join("internal/values").exists());
    }

    #[test]
    fn install_imports_private_environment_and_reinstall_retains_it_transactionally() {
        let host = tempfile::tempdir().unwrap();
        let source = tempfile::tempdir().unwrap();
        environment_package(source.path(), "1.0.0");
        assert!(install_package(host.path(), source.path()).is_err());
        assert!(!installed_path(host.path(), "example").unwrap().exists());
        let original_env = b"TOKEN='private $PATH'\nCOUNT=5\n";
        fs::write(source.path().join(".env"), original_env).unwrap();
        install_package(host.path(), source.path()).unwrap();
        let path = environment_path(host.path(), "example").unwrap();
        assert_eq!(fs::read(&path).unwrap(), original_env);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        let first = installed(host.path(), "example").unwrap();
        assert!(!first.directory.join(".env").exists());
        assert_eq!(
            super::super::environment(host.path(), &first.manifest).unwrap()["TOKEN"],
            "private $PATH"
        );
        environment_package(source.path(), "1.0.1");
        fs::write(
            source.path().join(".env"),
            "TOKEN=replacement\nCOUNT=invalid\n",
        )
        .unwrap();
        install_package(host.path(), source.path()).unwrap();
        assert_eq!(fs::read(&path).unwrap(), original_env);
        let receipt_path = installed_path(host.path(), "example").unwrap();
        let receipt = fs::read(&receipt_path).unwrap();
        let mut manifest = read_manifest(source.path()).unwrap();
        manifest.env.get_mut("COUNT").unwrap().choices = Some(vec![json!(7)]);
        manifest.env.get_mut("COUNT").unwrap().default = Some(json!(7));
        fs::write(
            source.path().join("blind-plugin.toml"),
            toml::to_string(&manifest).unwrap(),
        )
        .unwrap();
        assert!(install_package(host.path(), source.path()).is_err());
        assert_eq!(fs::read(&receipt_path).unwrap(), receipt);
        assert_eq!(fs::read(&path).unwrap(), original_env);
        environment_package(source.path(), "1.0.2");
        fs::write(source.path().join("viewer.html"), [0xff]).unwrap();
        assert!(install_package(host.path(), source.path()).is_err());
        assert_eq!(fs::read(&receipt_path).unwrap(), receipt);
        assert_eq!(fs::read(&path).unwrap(), original_env);
    }

    #[test]
    fn preprovisioned_private_environment_wins_and_json_packages_have_no_loader() {
        let host = tempfile::tempdir().unwrap();
        let source = tempfile::tempdir().unwrap();
        environment_package(source.path(), "1.0.0");
        fs::write(source.path().join(".env"), "TOKEN=source\n").unwrap();
        let private = environment_path(host.path(), "example").unwrap();
        write_private(&private, b"TOKEN=provisioned\n").unwrap();
        install_package(host.path(), source.path()).unwrap();
        assert_eq!(fs::read(private).unwrap(), b"TOKEN=provisioned\n");
        let json_only = tempfile::tempdir().unwrap();
        fs::write(json_only.path().join("blind-plugin.json"), "{}").unwrap();
        assert!(prepare_directory(json_only.path()).is_err());
        assert!(install_package(host.path(), json_only.path()).is_err());
    }

    #[test]
    fn installed_snapshot_rejects_declared_byte_tampering() {
        let host = tempfile::tempdir().unwrap();
        let source = tempfile::tempdir().unwrap();
        environment_package(source.path(), "1.0.0");
        fs::write(source.path().join(".env"), "TOKEN=private\n").unwrap();
        install_package(host.path(), source.path()).unwrap();
        let receipt = installed(host.path(), "example").unwrap();
        prepare_installed(host.path(), "example").unwrap();
        fs::write(receipt.directory.join("viewer.html"), "<p>tampered</p>").unwrap();
        assert!(prepare_installed(host.path(), "example").is_err());
    }
}
