use std::io::Cursor;

use anyhow::{Context, Result, bail};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use chacha20poly1305::{
    XChaCha20Poly1305, XNonce,
    aead::{Aead, KeyInit, OsRng, rand_core::RngCore},
};
use serde::{Deserialize, Serialize};

use crate::scene::SceneDescriptor;

const TOKEN_VERSION: u8 = 1;
const MAX_TOKEN_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Scope {
    Public,
    Owner,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Envelope {
    pub version: u8,
    pub scope: Scope,
    pub scene: SceneDescriptor,
}

#[derive(Clone)]
pub struct TokenCodec {
    cipher: XChaCha20Poly1305,
}

impl TokenCodec {
    pub fn new(key: [u8; 32]) -> Self {
        Self {
            cipher: XChaCha20Poly1305::new((&key).into()),
        }
    }

    pub fn seal(&self, scope: Scope, scene: &SceneDescriptor) -> Result<String> {
        let envelope = Envelope {
            version: TOKEN_VERSION,
            scope,
            scene: scene.clone(),
        };
        let json = serde_json::to_vec(&envelope)?;
        let compressed = zstd::stream::encode_all(Cursor::new(json), 7)?;
        let mut nonce = [0_u8; 24];
        OsRng.fill_bytes(&mut nonce);
        let encrypted = self
            .cipher
            .encrypt(XNonce::from_slice(&nonce), compressed.as_ref())
            .map_err(|_| anyhow::anyhow!("failed to seal scene"))?;
        let mut payload = Vec::with_capacity(1 + nonce.len() + encrypted.len());
        payload.push(TOKEN_VERSION);
        payload.extend_from_slice(&nonce);
        payload.extend_from_slice(&encrypted);
        Ok(URL_SAFE_NO_PAD.encode(payload))
    }

    pub fn open(&self, token: &str) -> Result<Envelope> {
        let payload = URL_SAFE_NO_PAD
            .decode(token)
            .context("invalid scene token")?;
        if payload.len() < 42 || payload.len() > MAX_TOKEN_BYTES {
            bail!("invalid scene token length");
        }
        if payload[0] != TOKEN_VERSION {
            bail!("unsupported scene token version");
        }
        let decrypted = self
            .cipher
            .decrypt(XNonce::from_slice(&payload[1..25]), &payload[25..])
            .map_err(|_| anyhow::anyhow!("invalid or expired scene token"))?;
        let json = zstd::stream::decode_all(Cursor::new(decrypted))?;
        let envelope: Envelope = serde_json::from_slice(&json)?;
        if envelope.version != TOKEN_VERSION {
            bail!("unsupported scene descriptor version");
        }
        Ok(envelope)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scene::{SceneDescriptor, ViewState};

    fn scene() -> SceneDescriptor {
        SceneDescriptor {
            source: None,
            schema: 1,
            title: "review".into(),
            created_at: 1,
            ttl_days: None,
            meshes: Vec::new(),
            components: Vec::new(),
            attachments: Vec::new(),
            collection: None,
            warnings: Vec::new(),
            label_groups: Vec::new(),
            state: ViewState::default(),
        }
    }

    #[test]
    fn encrypted_tokens_round_trip_without_exposing_scene_text() {
        let codec = TokenCodec::new([7; 32]);
        let token = codec.seal(Scope::Public, &scene()).unwrap();
        assert!(!token.contains("review"));
        let opened = codec.open(&token).unwrap();
        assert_eq!(opened.scope, Scope::Public);
        assert_eq!(opened.scene.title, "review");
        assert!(TokenCodec::new([8; 32]).open(&token).is_err());
    }

    #[test]
    fn stateless_lifetimes_preserve_legacy_links_and_expire_at_the_boundary() {
        let codec = TokenCodec::new([7; 32]);
        let mut scene = scene();
        assert!(!scene.stateless_expired_at(u64::MAX));
        scene.ttl_days = Some(0);
        let permanent = codec
            .open(&codec.seal(Scope::Public, &scene).unwrap())
            .unwrap()
            .scene;
        assert!(!permanent.stateless_expired_at(u64::MAX));
        scene.ttl_days = Some(2);
        let limited = codec
            .open(&codec.seal(Scope::Public, &scene).unwrap())
            .unwrap()
            .scene;
        assert!(!limited.stateless_expired_at(172_800));
        assert!(limited.stateless_expired_at(172_801));
        scene.created_at = u64::MAX;
        assert!(scene.stateless_expired_at(u64::MAX));
    }
}
