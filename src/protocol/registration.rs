use crate::scene::SceneSource;
use anyhow::{Context, Result, bail};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Source {
    pub id: String,
    pub name: String,
    pub host: String,
    #[serde(default)]
    pub hostname: String,
    pub port: u16,
    pub user: String,
    pub host_key: String,
    pub local: bool,
    #[serde(default)]
    pub client_only: bool,
    pub active: bool,
}
impl Source {
    pub fn scene_source(&self) -> SceneSource {
        SceneSource {
            id: self.id.clone(),
            name: self.name.clone(),
            host: if self.hostname.is_empty() {
                self.host.clone()
            } else {
                self.hostname.clone()
            },
            user: self.user.clone(),
        }
    }
}
#[derive(Debug, Serialize, Deserialize)]
pub struct JoinRequest {
    #[serde(default)]
    pub client_only: bool,
    pub name: String,
    pub host: String,
    #[serde(default)]
    pub hostname: String,
    pub port: u16,
    pub user: String,
    pub host_key: String,
}
#[derive(Debug, Serialize, Deserialize)]
pub struct JoinResponse {
    pub source: Source,
    pub credential: String,
    pub public_key: String,
    pub challenge: String,
}
#[derive(Debug, Serialize, Deserialize)]
pub struct FinishRequest {
    pub challenge_path: String,
    pub host: Option<String>,
    pub port: Option<u16>,
}
#[derive(Debug, Serialize, Deserialize)]
pub struct Invitation {
    pub server: String,
    pub token: String,
}
impl Invitation {
    pub fn encode(&self) -> Result<String> {
        Ok(format!(
            "blind1-{}",
            URL_SAFE_NO_PAD.encode(serde_json::to_vec(self)?)
        ))
    }
    pub fn decode(s: &str) -> Result<Self> {
        if s.len() > 16_384 {
            bail!("invitation too large");
        }
        let bytes = URL_SAFE_NO_PAD.decode(
            s.trim()
                .strip_prefix("blind1-")
                .context("invalid Blind invitation")?,
        )?;
        Ok(serde_json::from_slice(&bytes)?)
    }
}
