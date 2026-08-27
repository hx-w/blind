use std::{
    fs,
    path::PathBuf,
    sync::{Mutex, MutexGuard},
    time::{SystemTime, UNIX_EPOCH},
};

use anyhow::{Context, Result, bail};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use rand::{RngCore, rngs::OsRng};
use rusqlite::{Connection, OptionalExtension, params};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

use crate::{
    config::{Config, registry_path},
    scene::SceneDescriptor,
    token::{Scope, TokenCodec},
};

pub const SHORT_CODE_LEN: usize = 6;
pub const SHORT_TTL_SECONDS: i64 = 7 * 24 * 60 * 60;
const TOMBSTONE_SECONDS: i64 = 24 * 60 * 60;
const MAX_ACTIVE_SCENES: i64 = 10_000;
const MAX_REGISTRY_ROWS: i64 = 12_000;

pub struct Registry {
    connection: Mutex<Connection>,
    codec: TokenCodec,
    fingerprint_key: [u8; 32],
    path: PathBuf,
}

#[derive(Debug, Clone)]
pub struct Registration {
    pub code: String,
    pub owner_secret: String,
}

#[derive(Debug, Clone)]
pub struct RegisteredScene {
    pub scene: SceneDescriptor,
    pub owner_secret: String,
}

struct StoredScene {
    owner_secret: Option<String>,
    payload: Option<String>,
    expires_at: i64,
    gone_at: Option<i64>,
}

#[derive(Debug, thiserror::Error)]
pub enum RegistryLookupError {
    #[error("scene not found")]
    NotFound,
    #[error("scene expired or source is gone")]
    Gone,
    #[error(transparent)]
    Internal(#[from] anyhow::Error),
}

impl Registry {
    pub fn open(config: &Config) -> Result<Self> {
        let path = registry_path()?;
        let parent = path.parent().context("registry path has no parent")?;
        fs::create_dir_all(parent)?;
        let is_new = !path.exists();
        let connection = Connection::open(&path)
            .with_context(|| format!("failed to open {}", path.display()))?;
        connection.busy_timeout(std::time::Duration::from_secs(2))?;
        if is_new {
            connection.pragma_update(None, "auto_vacuum", "INCREMENTAL")?;
        }
        connection.pragma_update(None, "journal_mode", "WAL")?;
        connection.pragma_update(None, "synchronous", "NORMAL")?;
        connection.execute_batch(
            "CREATE TABLE IF NOT EXISTS scenes (
                code TEXT PRIMARY KEY CHECK(length(code) = 6),
                owner_secret TEXT,
                payload TEXT,
                fingerprint BLOB UNIQUE,
                created_at INTEGER NOT NULL,
                expires_at INTEGER NOT NULL,
                gone_at INTEGER
            );
            CREATE INDEX IF NOT EXISTS scenes_expires_at ON scenes(expires_at);",
        )?;
        set_private_permissions(&path)?;
        let key = config.secret_bytes()?;
        let registry = Self {
            connection: Mutex::new(connection),
            codec: TokenCodec::new(key),
            fingerprint_key: key,
            path,
        };
        registry.prune()?;
        Ok(registry)
    }

    pub fn register(&self, scene: &SceneDescriptor) -> Result<Registration> {
        let now = now();
        let expires_at = now + SHORT_TTL_SECONDS;
        let fingerprint = self.fingerprint(scene)?;
        let payload = self.codec.seal(Scope::Public, scene)?;
        let mut connection = self.lock()?;
        let transaction = connection.transaction()?;
        transaction.execute(
            "DELETE FROM scenes WHERE expires_at < ?1",
            [now - TOMBSTONE_SECONDS],
        )?;
        let total: i64 =
            transaction.query_row("SELECT count(*) FROM scenes", [], |row| row.get(0))?;
        if total >= MAX_REGISTRY_ROWS {
            transaction.execute(
                "DELETE FROM scenes WHERE code IN (
                    SELECT code FROM scenes
                    WHERE payload IS NULL OR expires_at <= ?1
                    ORDER BY coalesce(gone_at, expires_at), created_at
                    LIMIT ?2
                )",
                params![now, total - MAX_REGISTRY_ROWS + 1],
            )?;
        }
        if let Some(existing) = transaction
            .query_row(
                "SELECT code, owner_secret FROM scenes
                 WHERE fingerprint = ?1 AND payload IS NOT NULL AND expires_at > ?2",
                params![fingerprint, now],
                |row| {
                    Ok(Registration {
                        code: row.get(0)?,
                        owner_secret: row.get(1)?,
                    })
                },
            )
            .optional()?
        {
            transaction.commit()?;
            return Ok(existing);
        }
        let active: i64 = transaction.query_row(
            "SELECT count(*) FROM scenes WHERE payload IS NOT NULL AND expires_at > ?1",
            [now],
            |row| row.get(0),
        )?;
        if active >= MAX_ACTIVE_SCENES {
            bail!("short-link registry reached its 10,000 active scene limit");
        }
        for _ in 0..64 {
            let registration = Registration {
                code: short_secret(),
                owner_secret: short_secret(),
            };
            let inserted = transaction.execute(
                "INSERT OR IGNORE INTO scenes
                 (code, owner_secret, payload, fingerprint, created_at, expires_at, gone_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL)",
                params![
                    registration.code,
                    registration.owner_secret,
                    payload,
                    fingerprint,
                    now,
                    expires_at
                ],
            )?;
            if inserted == 1 {
                transaction.commit()?;
                return Ok(registration);
            }
            if let Some(existing) = transaction
                .query_row(
                    "SELECT code, owner_secret FROM scenes
                     WHERE fingerprint = ?1 AND payload IS NOT NULL AND expires_at > ?2",
                    params![fingerprint, now],
                    |row| {
                        Ok(Registration {
                            code: row.get(0)?,
                            owner_secret: row.get(1)?,
                        })
                    },
                )
                .optional()?
            {
                transaction.commit()?;
                return Ok(existing);
            }
        }
        bail!("could not allocate a unique short scene code")
    }

    pub fn resolve(&self, code: &str) -> std::result::Result<RegisteredScene, RegistryLookupError> {
        if !is_short_secret(code) {
            return Err(RegistryLookupError::NotFound);
        }
        let now = now();
        let connection = self.lock().map_err(RegistryLookupError::Internal)?;
        let row: Option<StoredScene> = connection
            .query_row(
                "SELECT owner_secret, payload, expires_at, gone_at FROM scenes WHERE code = ?1",
                [code],
                |row| {
                    Ok(StoredScene {
                        owner_secret: row.get(0)?,
                        payload: row.get(1)?,
                        expires_at: row.get(2)?,
                        gone_at: row.get(3)?,
                    })
                },
            )
            .optional()
            .map_err(|error| RegistryLookupError::Internal(error.into()))?;
        let Some(stored) = row else {
            return Err(RegistryLookupError::NotFound);
        };
        if stored.expires_at <= now || stored.gone_at.is_some() || stored.payload.is_none() {
            return Err(RegistryLookupError::Gone);
        }
        let envelope = self
            .codec
            .open(stored.payload.as_deref().unwrap_or_default())
            .map_err(RegistryLookupError::Internal)?;
        Ok(RegisteredScene {
            scene: envelope.scene,
            owner_secret: stored.owner_secret.unwrap_or_default(),
        })
    }

    pub fn mark_gone(&self, code: &str) -> Result<()> {
        if !is_short_secret(code) {
            return Ok(());
        }
        let now = now();
        self.lock()?.execute(
            "UPDATE scenes SET owner_secret = NULL, payload = NULL, fingerprint = NULL,
             gone_at = ?2, expires_at = min(expires_at, ?3) WHERE code = ?1",
            params![code, now, now + TOMBSTONE_SECONDS],
        )?;
        Ok(())
    }

    pub fn owner_matches(&self, expected: &str, candidate: &str) -> bool {
        expected.len() == candidate.len() && expected.as_bytes().ct_eq(candidate.as_bytes()).into()
    }

    pub fn clear(&self) -> Result<()> {
        self.lock()?.execute("DELETE FROM scenes", [])?;
        Ok(())
    }

    pub fn stats(&self) -> Result<(i64, i64)> {
        let current = now();
        let connection = self.lock()?;
        let active = connection.query_row(
            "SELECT count(*) FROM scenes WHERE payload IS NOT NULL AND expires_at > ?1",
            [current],
            |row| row.get(0),
        )?;
        let total = connection.query_row("SELECT count(*) FROM scenes", [], |row| row.get(0))?;
        Ok((active, total))
    }

    pub fn path(&self) -> &PathBuf {
        &self.path
    }

    fn prune(&self) -> Result<()> {
        let connection = self.lock()?;
        connection.execute(
            "DELETE FROM scenes WHERE expires_at < ?1",
            [now() - TOMBSTONE_SECONDS],
        )?;
        connection
            .execute_batch("PRAGMA wal_checkpoint(PASSIVE); PRAGMA incremental_vacuum(128);")?;
        Ok(())
    }

    fn fingerprint(&self, scene: &SceneDescriptor) -> Result<Vec<u8>> {
        let mut canonical = scene.clone();
        canonical.created_at = 0;
        let mut hasher = Sha256::new();
        hasher.update(self.fingerprint_key);
        hasher.update(serde_json::to_vec(&canonical)?);
        Ok(hasher.finalize().to_vec())
    }

    fn lock(&self) -> Result<MutexGuard<'_, Connection>> {
        self.connection
            .lock()
            .map_err(|_| anyhow::anyhow!("short-link registry lock was poisoned"))
    }
}

pub fn is_short_secret(value: &str) -> bool {
    value.len() == SHORT_CODE_LEN
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn short_secret() -> String {
    let mut bytes = [0_u8; 5];
    OsRng.fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)[..SHORT_CODE_LEN].to_string()
}

fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

fn set_private_permissions(path: &PathBuf) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}
