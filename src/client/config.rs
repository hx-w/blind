use crate::{
    protocol::registration::Source,
    runtime::{config::config_path, files::write_private},
};
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::{fs, path::PathBuf};

#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct ClientConfig {
    pub(crate) server: String,
    pub(crate) credential: String,
    pub(crate) source: Source,
    pub(crate) public_key: String,
    pub(crate) challenge: String,
    pub(crate) challenge_path: Option<String>,
}
pub(crate) fn client_path() -> Result<PathBuf> {
    if let Some(dir) = std::env::var_os("BLIND_CLIENT_DIR") {
        return Ok(PathBuf::from(dir).join("client.json"));
    }
    Ok(config_path()?
        .parent()
        .context("config parent missing")?
        .join("client.json"))
}
pub(crate) fn load() -> Result<Option<ClientConfig>> {
    let path = client_path()?;
    if !path.exists() {
        return Ok(None);
    }
    Ok(Some(serde_json::from_slice(&fs::read(path)?)?))
}

pub(super) fn save(c: &ClientConfig) -> Result<()> {
    crate::runtime::files::private_dir(
        client_path()?
            .parent()
            .context("missing Client directory")?,
    )?;
    write_private(&client_path()?, &serde_json::to_vec_pretty(c)?)
}
