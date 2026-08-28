use std::{fs, io::Write, path::PathBuf};

use anyhow::{Context, Result, bail};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use directories::ProjectDirs;
use rand::{RngCore, rngs::OsRng};
use serde::{Deserialize, Serialize};
use subtle::ConstantTimeEq;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    pub listen: String,
    pub preferred_origin: Option<String>,
    pub pat: String,
    pub secret: String,
}

impl Config {
    pub fn load_or_create() -> Result<(Self, bool)> {
        let path = config_path()?;
        if path.exists() {
            let bytes =
                fs::read(&path).with_context(|| format!("failed to read {}", path.display()))?;
            return Ok((
                serde_json::from_slice(&bytes).context("invalid Blind config")?,
                false,
            ));
        }

        let config = Self::fresh();
        config.save()?;
        Ok((config, true))
    }

    pub fn fresh() -> Self {
        Self {
            listen: "0.0.0.0:7400".into(),
            preferred_origin: None,
            pat: format!("blind_pat_{}", random_b64(24)),
            secret: random_b64(32),
        }
    }

    pub fn save(&self) -> Result<()> {
        let path = config_path()?;
        let parent = path.parent().context("config path has no parent")?;
        fs::create_dir_all(parent)?;
        let payload = serde_json::to_vec_pretty(self)?;

        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            let mut file = fs::OpenOptions::new()
                .create(true)
                .truncate(true)
                .write(true)
                .mode(0o600)
                .open(&path)?;
            file.write_all(&payload)?;
            let mut permissions = file.metadata()?.permissions();
            use std::os::unix::fs::PermissionsExt;
            permissions.set_mode(0o600);
            fs::set_permissions(&path, permissions)?;
        }

        #[cfg(not(unix))]
        fs::write(&path, payload)?;

        Ok(())
    }

    pub fn secret_bytes(&self) -> Result<[u8; 32]> {
        let bytes = URL_SAFE_NO_PAD
            .decode(&self.secret)
            .context("invalid config secret")?;
        bytes
            .try_into()
            .map_err(|_| anyhow::anyhow!("config secret must be 32 bytes"))
    }

    pub fn verify_pat(&self, candidate: &str) -> bool {
        self.pat.as_bytes().ct_eq(candidate.as_bytes()).into()
    }

    pub fn port(&self) -> Result<u16> {
        self.listen
            .rsplit_once(':')
            .and_then(|(_, port)| port.parse().ok())
            .ok_or_else(|| anyhow::anyhow!("listen address must end with a port"))
    }

    pub fn repair_invalid_secret(&mut self) -> Result<bool> {
        if self.secret_bytes().is_ok() {
            return Ok(false);
        }
        self.secret = random_b64(32);
        self.save()?;
        Ok(true)
    }

    pub fn restore_saved_secret(&self) -> Result<bool> {
        let (mut saved, _) = Self::load_or_create()?;
        if saved.secret == self.secret {
            return Ok(false);
        }
        saved.secret.clone_from(&self.secret);
        saved.save()?;
        Ok(true)
    }
}

/// Random URL-safe secret derived from OS entropy.
pub(crate) fn random_b64(bytes: usize) -> String {
    let mut buffer = vec![0_u8; bytes];
    OsRng.fill_bytes(&mut buffer);
    URL_SAFE_NO_PAD.encode(buffer)
}

pub fn config_path() -> Result<PathBuf> {
    if let Some(path) = std::env::var_os("BLIND_CONFIG_DIR") {
        return Ok(PathBuf::from(path).join("config.json"));
    }
    let dirs = ProjectDirs::from("dev", "Blind", "Blind")
        .ok_or_else(|| anyhow::anyhow!("could not locate the user config directory"))?;
    Ok(dirs.config_dir().join("config.json"))
}

pub fn repair_config_permissions() -> Result<bool> {
    let path = config_path()?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        let metadata = fs::metadata(&path)?;
        if metadata.permissions().mode() & 0o777 != 0o600 {
            fs::set_permissions(&path, fs::Permissions::from_mode(0o600))?;
            return Ok(true);
        }
    }
    Ok(false)
}

pub fn registry_path() -> Result<PathBuf> {
    Ok(config_path()?
        .parent()
        .context("config path has no parent")?
        .join("scenes.sqlite3"))
}

pub fn normalize_origin(value: &str) -> Result<String> {
    let value = value.trim_end_matches('/');
    let url = url::Url::parse(value).context("host URL must include http:// or https://")?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        bail!("host URL must be an HTTP(S) origin");
    }
    if url.path() != "/" || url.query().is_some() || url.fragment().is_some() {
        bail!("host URL must not include a path, query, or fragment");
    }
    Ok(value.to_string())
}
