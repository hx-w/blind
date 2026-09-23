use std::{
    collections::{HashMap, VecDeque},
    fs,
    path::{Path, PathBuf},
    sync::{Mutex, MutexGuard},
    time::{SystemTime, UNIX_EPOCH},
};

use anyhow::{Context, Result, bail};
use rusqlite::{Connection, OptionalExtension, params, types::Value};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

use crate::{
    config::{Config, random_b64, registry_path},
    scene::{SceneDescriptor, hash_file},
    token::{Scope, TokenCodec},
};

pub const SHORT_CODE_LEN: usize = 6;
const TOMBSTONE_SECONDS: i64 = 24 * 60 * 60;
const MAX_ACTIVE_SCENES: i64 = 10_000;
const MAX_REGISTRY_ROWS: i64 = 12_000;

pub struct Registry {
    pub sources: crate::source::Sources,
    connection: Mutex<Connection>,
    codec: TokenCodec,
    fingerprint_key: [u8; 32],
    key_id: String,
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

#[derive(Debug, Default, Clone)]
pub struct RegistryAudit {
    pub unavailable: usize,
    pub valid: usize,
    pub expired: usize,
    pub source_gone: usize,
    pub tombstoned: usize,
    pub corrupt: usize,
    invalid_rows: Vec<InvalidRow>,
}

impl RegistryAudit {
    pub fn invalid(&self) -> usize {
        self.expired + self.source_gone + self.tombstoned + self.corrupt
    }
}

struct StoredScene {
    owner_secret: Option<String>,
    payload: Option<String>,
    expires_at: i64,
    gone_at: Option<i64>,
}

#[derive(Debug, Clone)]
struct AuditRow {
    rowid: i64,
    code: Value,
    owner_secret: Value,
    payload: Value,
    fingerprint: Value,
    created_at: Value,
    expires_at: Value,
    gone_at: Value,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AuditStatus {
    Unavailable,
    Valid,
    Expired,
    SourceGone,
    Tombstoned,
    Corrupt,
}

#[derive(Debug, Clone)]
struct InvalidRow {
    row: AuditRow,
    status: AuditStatus,
}

struct ObservedSource {
    byte_size: u64,
    revision: String,
}

struct SourceCache {
    entries: HashMap<String, Option<ObservedSource>>,
    insertion_order: VecDeque<String>,
}

#[derive(Debug, thiserror::Error)]
#[error(
    "the configured scene key does not match this registry; use `blind doctor --clear-all` to discard the links explicitly"
)]
struct RegistryKeyMismatch;

impl AuditRow {
    fn storage_types_are_valid(&self) -> bool {
        matches!(&self.code, Value::Text(_))
            && matches!(&self.owner_secret, Value::Null | Value::Text(_))
            && matches!(&self.payload, Value::Null | Value::Text(_))
            && matches!(&self.fingerprint, Value::Null | Value::Blob(_))
            && matches!(&self.created_at, Value::Integer(_))
            && matches!(&self.expires_at, Value::Integer(_))
            && matches!(&self.gone_at, Value::Null | Value::Integer(_))
    }

    fn code(&self) -> Option<&str> {
        match &self.code {
            Value::Text(value) => Some(value),
            _ => None,
        }
    }

    fn owner_secret(&self) -> Option<&str> {
        match &self.owner_secret {
            Value::Text(value) => Some(value),
            _ => None,
        }
    }

    fn payload(&self) -> Option<&str> {
        match &self.payload {
            Value::Text(value) => Some(value),
            _ => None,
        }
    }

    fn fingerprint(&self) -> Option<&[u8]> {
        match &self.fingerprint {
            Value::Blob(value) => Some(value),
            _ => None,
        }
    }

    fn expires_at(&self) -> Option<i64> {
        match &self.expires_at {
            Value::Integer(value) => Some(*value),
            _ => None,
        }
    }

    fn gone_at(&self) -> Option<i64> {
        match &self.gone_at {
            Value::Integer(value) => Some(*value),
            _ => None,
        }
    }
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
        Self::open_at(config, path)
    }

    fn open_at(config: &Config, path: PathBuf) -> Result<Self> {
        let key = config.secret_bytes()?;
        let connection = open_connection(&path)?;
        let codec = TokenCodec::new(key);
        ensure_key_identity(&connection, &codec, &key)?;
        let key_id = hex::encode(Sha256::digest(key));
        let registry = Self {
            sources: crate::source::Sources::open(
                path.parent().context("registry parent missing")?,
            )?,
            connection: Mutex::new(connection),
            codec,
            fingerprint_key: key,
            key_id,
            path,
        };
        registry.prune()?;
        Ok(registry)
    }

    pub fn clear_without_key() -> Result<usize> {
        let path = registry_path()?;
        Self::clear_at_without_key(&path)
    }

    fn clear_at_without_key(path: &Path) -> Result<usize> {
        let mut connection = open_connection(path)?;
        let transaction = connection.transaction()?;
        let removed = transaction.execute("DELETE FROM scenes", [])?;
        transaction.execute("DELETE FROM registry_meta WHERE key = 'scene_key_id'", [])?;
        transaction.commit()?;
        Ok(removed)
    }

    pub fn register(&self, scene: &SceneDescriptor) -> Result<Registration> {
        let now = now();
        let fingerprint = self.fingerprint(scene)?;
        // An identical active scene reuses its code without resealing its payload.
        {
            let connection = self.lock()?;
            if let Some(existing) = existing_registration(&connection, &fingerprint, now)? {
                return Ok(existing);
            }
        }
        let days = scene.link_ttl_days(false);
        let expires_at = if days == 0 {
            i64::MAX
        } else {
            now + i64::from(days) * 86_400
        };
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
            if let Some(existing) = existing_registration(&transaction, &fingerprint, now)? {
                transaction.commit()?;
                return Ok(existing);
            }
        }
        bail!("could not allocate a unique short scene code")
    }

    pub fn resolve(&self, code: &str) -> std::result::Result<RegisteredScene, RegistryLookupError> {
        self.resolve_at(code, now())
    }

    fn resolve_at(
        &self,
        code: &str,
        now: i64,
    ) -> std::result::Result<RegisteredScene, RegistryLookupError> {
        if !is_short_secret(code) {
            return Err(RegistryLookupError::NotFound);
        }
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
        if stored.expires_at <= now || stored.gone_at.is_some() {
            return Err(RegistryLookupError::Gone);
        }
        let Some(payload) = stored.payload else {
            return Err(RegistryLookupError::Gone);
        };
        let envelope = self
            .codec
            .open(&payload)
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

    pub fn clear(&self) -> Result<usize> {
        self.lock()?
            .execute("DELETE FROM scenes", [])
            .map_err(Into::into)
    }

    pub fn repair(&self) -> Result<()> {
        let connection = self.lock()?;
        let integrity: String = connection.query_row("PRAGMA quick_check", [], |row| row.get(0))?;
        if integrity != "ok" {
            bail!("SQLite quick_check failed: {integrity}");
        }
        connection.execute_batch(
            "CREATE INDEX IF NOT EXISTS scenes_expires_at ON scenes(expires_at);
             PRAGMA wal_checkpoint(PASSIVE);
             PRAGMA incremental_vacuum(128);
             PRAGMA optimize;",
        )?;
        verify_schema(&connection)?;
        connection.execute(
            "INSERT INTO registry_meta (key, value) VALUES ('scene_key_id', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [&self.key_id],
        )?;
        set_private_permissions(&self.path)?;
        Ok(())
    }

    pub async fn audit(&self) -> Result<RegistryAudit> {
        const AUDIT_BATCH_SIZE: i64 = 32;
        let max_rowid = {
            let connection = self.lock()?;
            connection.query_row("SELECT coalesce(max(rowid), 0) FROM scenes", [], |row| {
                row.get::<_, i64>(0)
            })?
        };
        let current = now();
        let mut after_rowid = i64::MIN;
        let mut audit = RegistryAudit::default();
        let mut source_cache = SourceCache::new();
        loop {
            let rows = {
                let connection = self.lock()?;
                let mut statement = connection.prepare(
                    "SELECT rowid, code, owner_secret, payload, fingerprint, created_at,
                            expires_at, gone_at
                     FROM scenes WHERE rowid > ?1 AND rowid <= ?2
                     ORDER BY rowid LIMIT ?3",
                )?;
                statement
                    .query_map(params![after_rowid, max_rowid, AUDIT_BATCH_SIZE], |row| {
                        Ok(AuditRow {
                            rowid: row.get(0)?,
                            code: row.get::<_, Value>(1)?,
                            owner_secret: row.get::<_, Value>(2)?,
                            payload: row.get::<_, Value>(3)?,
                            fingerprint: row.get::<_, Value>(4)?,
                            created_at: row.get::<_, Value>(5)?,
                            expires_at: row.get::<_, Value>(6)?,
                            gone_at: row.get::<_, Value>(7)?,
                        })
                    })?
                    .collect::<std::result::Result<Vec<_>, _>>()?
            };
            if rows.is_empty() {
                break;
            }

            for row in rows {
                after_rowid = row.rowid;
                let status =
                    if !row.storage_types_are_valid() || !row.code().is_some_and(is_short_secret) {
                        AuditStatus::Corrupt
                    } else if row.gone_at().is_some() || row.payload == Value::Null {
                        AuditStatus::Tombstoned
                    } else if row.expires_at().is_some_and(|expires| expires <= current) {
                        AuditStatus::Expired
                    } else if !row.owner_secret().is_some_and(is_short_secret) {
                        AuditStatus::Corrupt
                    } else {
                        let payload = row.payload().expect("payload checked above");
                        match self.codec.open(payload) {
                            Ok(envelope) => {
                                if envelope.scope != Scope::Public
                                    || self.fingerprint(&envelope.scene).ok().as_deref()
                                        != row.fingerprint()
                                {
                                    AuditStatus::Corrupt
                                } else {
                                    match scene_sources_are_valid(
                                        &envelope.scene,
                                        &mut source_cache,
                                        &self.sources,
                                    )
                                    .await
                                    {
                                        Ok(true) => AuditStatus::Valid,
                                        Ok(false) => AuditStatus::SourceGone,
                                        Err(_) => AuditStatus::Unavailable,
                                    }
                                }
                            }
                            Err(_) => AuditStatus::Corrupt,
                        }
                    };
                match status {
                    AuditStatus::Valid => audit.valid += 1,
                    AuditStatus::Unavailable => audit.unavailable += 1,
                    AuditStatus::Expired => audit.expired += 1,
                    AuditStatus::SourceGone => audit.source_gone += 1,
                    AuditStatus::Tombstoned => audit.tombstoned += 1,
                    AuditStatus::Corrupt => audit.corrupt += 1,
                }
                if !matches!(status, AuditStatus::Valid | AuditStatus::Unavailable) {
                    audit.invalid_rows.push(InvalidRow { row, status });
                }
            }
        }
        Ok(audit)
    }

    pub async fn clean_invalid(&self, audit: &RegistryAudit) -> Result<usize> {
        const CLEAN_BATCH_SIZE: usize = 32;
        let mut removed = 0;
        for batch in audit.invalid_rows.chunks(CLEAN_BATCH_SIZE) {
            let mut still_invalid = Vec::with_capacity(batch.len());
            let mut source_cache = SourceCache::new();
            for invalid in batch {
                if invalid.status == AuditStatus::SourceGone {
                    let payload = invalid
                        .row
                        .payload()
                        .expect("source-gone row has a payload");
                    if let Ok(envelope) = self.codec.open(payload)
                        && scene_sources_are_valid(
                            &envelope.scene,
                            &mut source_cache,
                            &self.sources,
                        )
                        .await
                        .unwrap_or(true)
                    {
                        continue;
                    }
                }
                still_invalid.push(invalid);
            }

            // Commit immediately after this refreshed filesystem snapshot so
            // a long audit does not keep stale negative observations alive.
            let mut connection = self.lock()?;
            let transaction = connection.transaction()?;
            for invalid in still_invalid {
                let row = &invalid.row;
                removed += transaction.execute(
                    "DELETE FROM scenes
                     WHERE rowid = ?1 AND code = ?2 AND owner_secret IS ?3 AND payload IS ?4
                       AND fingerprint IS ?5 AND created_at = ?6 AND expires_at = ?7
                       AND gone_at IS ?8",
                    params![
                        row.rowid,
                        &row.code,
                        &row.owner_secret,
                        &row.payload,
                        &row.fingerprint,
                        &row.created_at,
                        &row.expires_at,
                        &row.gone_at
                    ],
                )?;
            }
            transaction.commit()?;
        }
        Ok(removed)
    }

    fn prune(&self) -> Result<()> {
        self.prune_at(now())
    }

    fn prune_at(&self, now: i64) -> Result<()> {
        let connection = self.lock()?;
        connection.execute(
            "DELETE FROM scenes WHERE expires_at < ?1",
            [now - TOMBSTONE_SECONDS],
        )?;
        connection
            .execute_batch("PRAGMA wal_checkpoint(PASSIVE); PRAGMA incremental_vacuum(128);")?;
        Ok(())
    }

    fn fingerprint(&self, scene: &SceneDescriptor) -> Result<Vec<u8>> {
        let mut canonical = scene.clone();
        canonical.created_at = 0;
        if let Some(collection) = &mut canonical.collection {
            for entry in &mut collection.scenes {
                entry.scene.created_at = 0;
            }
        }
        // Explicit default TTL and legacy short scenes have identical lifetimes.
        if canonical.ttl_days == Some(crate::scene::DEFAULT_TTL_DAYS) {
            canonical.ttl_days = None;
        }
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

pub fn is_key_mismatch(error: &anyhow::Error) -> bool {
    error.downcast_ref::<RegistryKeyMismatch>().is_some()
}

async fn scene_sources_are_valid(
    scene: &SceneDescriptor,
    cache: &mut SourceCache,
    sources: &crate::source::Sources,
) -> Result<bool, crate::source::SourceError> {
    if let Some(collection) = &scene.collection {
        let mut valid = false;
        let mut unavailable = None;
        for child in
            std::iter::once(scene).chain(collection.scenes.iter().map(|entry| &entry.scene))
        {
            match single_scene_sources_are_valid(child, cache, sources).await {
                Ok(true) => valid = true,
                Ok(false) | Err(crate::source::SourceError::Gone) => {}
                Err(error) => unavailable = Some(error),
            }
        }
        return if valid {
            Ok(true)
        } else if let Some(error) = unavailable {
            Err(error)
        } else {
            Ok(false)
        };
    }
    single_scene_sources_are_valid(scene, cache, sources).await
}

async fn single_scene_sources_are_valid(
    scene: &SceneDescriptor,
    cache: &mut SourceCache,
    sources: &crate::source::Sources,
) -> Result<bool, crate::source::SourceError> {
    if scene.source.is_some() || scene.meshes.iter().any(|m| crate::oss::is_oss(&m.path)) {
        return match sources.validate(scene).await {
            Ok(()) => Ok(true),
            Err(crate::source::SourceError::Gone) => Ok(false),
            Err(error) => Err(error),
        };
    }
    for mesh in &scene.meshes {
        let Some(observed) = cache.observe(&mesh.path).await else {
            return Ok(false);
        };
        if observed.byte_size != mesh.byte_size || observed.revision != mesh.revision {
            return Ok(false);
        }
    }
    Ok(true)
}

impl SourceCache {
    const MAX_ENTRIES: usize = 4_096;

    fn new() -> Self {
        Self {
            entries: HashMap::new(),
            insertion_order: VecDeque::new(),
        }
    }

    async fn observe(&mut self, source: &str) -> Option<&ObservedSource> {
        if !self.entries.contains_key(source) {
            let observed = async {
                let path = Path::new(source);
                let metadata = tokio::fs::metadata(path).await.ok()?;
                if !metadata.is_file() {
                    return None;
                }
                Some(ObservedSource {
                    byte_size: metadata.len(),
                    revision: hash_file(path).await.ok()?,
                })
            }
            .await;
            if self.entries.len() >= Self::MAX_ENTRIES
                && let Some(oldest) = self.insertion_order.pop_front()
            {
                self.entries.remove(&oldest);
            }
            self.insertion_order.push_back(source.to_owned());
            self.entries.insert(source.to_owned(), observed);
        }
        self.entries.get(source).and_then(Option::as_ref)
    }
}

pub fn is_short_secret(value: &str) -> bool {
    value.len() == SHORT_CODE_LEN
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn short_secret() -> String {
    random_b64(5)[..SHORT_CODE_LEN].to_string()
}

/// Active scene already registered under this fingerprint, if any.
fn existing_registration(
    connection: &Connection,
    fingerprint: &[u8],
    now: i64,
) -> Result<Option<Registration>> {
    connection
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
        .optional()
        .map_err(Into::into)
}

fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

fn ensure_key_identity(connection: &Connection, codec: &TokenCodec, key: &[u8; 32]) -> Result<()> {
    let expected = hex::encode(Sha256::digest(key));
    let stored: Option<String> = connection
        .query_row(
            "SELECT value FROM registry_meta WHERE key = 'scene_key_id'",
            [],
            |row| row.get(0),
        )
        .optional()?;
    if let Some(stored) = stored {
        if stored != expected {
            return Err(RegistryKeyMismatch.into());
        }
        return Ok(());
    }

    // v0.3.1 registries predate key identity metadata. Bind them only after
    // proving that this key opens at least one stored payload. An empty or
    // tombstone-only registry has no surviving capability to protect.
    let mut statement =
        connection.prepare("SELECT payload FROM scenes WHERE payload IS NOT NULL")?;
    let mut rows = statement.query([])?;
    let mut has_payload = false;
    let mut compatible = false;
    while let Some(row) = rows.next()? {
        has_payload = true;
        if let Value::Text(payload) = row.get::<_, Value>(0)?
            && codec
                .open(&payload)
                .is_ok_and(|envelope| envelope.scope == Scope::Public)
        {
            compatible = true;
            break;
        }
    }
    if has_payload && !compatible {
        return Err(RegistryKeyMismatch.into());
    }
    connection.execute(
        "INSERT OR IGNORE INTO registry_meta (key, value) VALUES ('scene_key_id', ?1)",
        [&expected],
    )?;
    let bound: String = connection.query_row(
        "SELECT value FROM registry_meta WHERE key = 'scene_key_id'",
        [],
        |row| row.get(0),
    )?;
    if bound != expected {
        return Err(RegistryKeyMismatch.into());
    }
    Ok(())
}

fn verify_schema(connection: &Connection) -> Result<()> {
    let mut statement = connection.prepare("PRAGMA table_info(scenes)")?;
    let columns = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, i64>(5)?,
            ))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let expected = vec![
        ("code".into(), "TEXT".into(), 0, 1),
        ("owner_secret".into(), "TEXT".into(), 0, 0),
        ("payload".into(), "TEXT".into(), 0, 0),
        ("fingerprint".into(), "BLOB".into(), 0, 0),
        ("created_at".into(), "INTEGER".into(), 1, 0),
        ("expires_at".into(), "INTEGER".into(), 1, 0),
        ("gone_at".into(), "INTEGER".into(), 0, 0),
    ];
    if columns != expected {
        bail!("SQLite scenes schema does not match this Blind version");
    }

    let mut statement = connection.prepare("PRAGMA table_info(registry_meta)")?;
    let metadata_columns = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, i64>(5)?,
            ))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    if metadata_columns
        != [
            ("key".into(), "TEXT".into(), 0, 1),
            ("value".into(), "TEXT".into(), 1, 0),
        ]
    {
        bail!("SQLite registry metadata schema does not match this Blind version");
    }

    let mut statement = connection.prepare("PRAGMA index_info(scenes_expires_at)")?;
    let index_columns = statement
        .query_map([], |row| row.get::<_, String>(2))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    if index_columns != ["expires_at"] {
        bail!("SQLite scenes expiry index is malformed");
    }
    Ok(())
}

fn open_connection(path: &Path) -> Result<Connection> {
    let parent = path.parent().context("registry path has no parent")?;
    fs::create_dir_all(parent)?;
    let is_new = !path.exists();
    let connection =
        Connection::open(path).with_context(|| format!("failed to open {}", path.display()))?;
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
        CREATE INDEX IF NOT EXISTS scenes_expires_at ON scenes(expires_at);
        CREATE TABLE IF NOT EXISTS registry_meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );",
    )?;
    set_private_permissions(path)?;
    Ok(connection)
}

fn set_private_permissions(path: &Path) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn ttl_preserves_legacy_dedup_and_permanent_links_across_time_and_restart() {
        let directory = tempfile::tempdir().unwrap();
        let mesh_path = directory.path().join("mesh.ply");
        fs::write(&mesh_path, include_bytes!("../tests/fixtures/tetra.ply")).unwrap();
        let config = Config::fresh();
        let db = directory.path().join("scenes.sqlite3");
        let registry = Registry::open_at(&config, db.clone()).unwrap();
        let mut scene = SceneDescriptor::create(std::slice::from_ref(&mesh_path), None)
            .await
            .unwrap();
        let legacy = registry.register(&scene).unwrap();
        scene.ttl_days = Some(7);
        assert_eq!(legacy.code, registry.register(&scene).unwrap().code);
        scene.ttl_days = Some(30);
        let monthly = registry.register(&scene).unwrap();
        scene.ttl_days = Some(0);
        let permanent = registry.register(&scene).unwrap();
        assert_ne!(permanent.code, legacy.code);
        assert_ne!(permanent.code, monthly.code);
        assert_eq!(permanent.code, registry.register(&scene).unwrap().code);
        let future = now() + 10 * 86_400;
        assert!(matches!(
            registry.resolve_at(&legacy.code, future),
            Err(RegistryLookupError::Gone)
        ));
        assert!(registry.resolve_at(&monthly.code, future).is_ok());
        assert!(registry.resolve_at(&permanent.code, future).is_ok());
        registry.prune_at(now() + 365 * 86_400).unwrap();
        assert!(matches!(
            registry.resolve(&monthly.code),
            Err(RegistryLookupError::NotFound)
        ));
        assert!(registry.resolve(&permanent.code).is_ok());
        drop(registry);
        let registry = Registry::open_at(&config, db).unwrap();
        assert_eq!(registry.audit().await.unwrap().valid, 1);
        assert!(registry.resolve(&permanent.code).is_ok());
        fs::remove_file(mesh_path).unwrap();
        let audit = registry.audit().await.unwrap();
        assert_eq!(audit.source_gone, 1);
        assert_eq!(registry.clean_invalid(&audit).await.unwrap(), 1);
        assert!(matches!(
            registry.resolve(&permanent.code),
            Err(RegistryLookupError::NotFound)
        ));
    }

    #[tokio::test]
    async fn capacity_cleanup_preserves_permanent_scenes_until_source_invalidation() {
        let directory = tempfile::tempdir().unwrap();
        let mesh_path = directory.path().join("mesh.ply");
        fs::write(&mesh_path, include_bytes!("../tests/fixtures/tetra.ply")).unwrap();
        let registry =
            Registry::open_at(&Config::fresh(), directory.path().join("scenes.sqlite3")).unwrap();
        let mut scene = SceneDescriptor::create(&[mesh_path], None).await.unwrap();
        scene.ttl_days = Some(0);
        let permanent = registry.register(&scene).unwrap();
        {
            let mut connection = registry.lock().unwrap();
            let transaction = connection.transaction().unwrap();
            for index in 0..MAX_REGISTRY_ROWS - 1 {
                transaction.execute("INSERT INTO scenes (code, created_at, expires_at, gone_at) VALUES (?1, ?2, ?2, ?2)", params![format!("{index:06}"), now() - 1]).unwrap();
            }
            transaction.commit().unwrap();
        }
        scene.title = "another permanent scene".into();
        registry.register(&scene).unwrap();
        assert!(registry.resolve(&permanent.code).is_ok());
        let rows: i64 = registry
            .lock()
            .unwrap()
            .query_row("SELECT count(*) FROM scenes", [], |row| row.get(0))
            .unwrap();
        assert_eq!(rows, MAX_REGISTRY_ROWS);
        registry.mark_gone(&permanent.code).unwrap();
        assert!(matches!(
            registry.resolve(&permanent.code),
            Err(RegistryLookupError::Gone)
        ));
        registry.prune_at(now() + 3 * 86_400).unwrap();
        assert!(matches!(
            registry.resolve(&permanent.code),
            Err(RegistryLookupError::NotFound)
        ));
    }

    #[tokio::test]
    async fn audit_classifies_and_cleans_invalid_links() {
        let directory = tempfile::tempdir().unwrap();
        let mesh_path = directory.path().join("mesh.ply");
        std::fs::write(&mesh_path, include_bytes!("../tests/fixtures/tetra.ply")).unwrap();
        let config = Config::fresh();
        let registry = Registry::open_at(&config, directory.path().join("scenes.sqlite3")).unwrap();
        let scene = SceneDescriptor::create(std::slice::from_ref(&mesh_path), None)
            .await
            .unwrap();
        let valid = registry.register(&scene).unwrap();

        let payload = registry.codec.seal(Scope::Public, &scene).unwrap();
        let current = now();
        {
            let connection = registry.lock().unwrap();
            connection
                .execute(
                    "INSERT INTO scenes
                     (code, owner_secret, payload, fingerprint, created_at, expires_at, gone_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                    params![
                        "expire",
                        "owner1",
                        payload,
                        vec![1_u8],
                        current,
                        current - 1,
                        None::<i64>
                    ],
                )
                .unwrap();
            connection
                .execute(
                    "INSERT INTO scenes
                     (code, owner_secret, payload, fingerprint, created_at, expires_at, gone_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL)",
                    params![
                        "badtym",
                        "owner4",
                        payload,
                        vec![4_u8],
                        "not-an-integer",
                        current + 60
                    ],
                )
                .unwrap();
            connection
                .execute(
                    "INSERT INTO scenes
                     (code, owner_secret, payload, fingerprint, created_at, expires_at, gone_at)
                     VALUES (?1, NULL, NULL, NULL, ?2, ?3, ?2)",
                    params!["tombed", current, current + 60],
                )
                .unwrap();
            connection
                .execute(
                    "INSERT INTO scenes
                     (code, owner_secret, payload, fingerprint, created_at, expires_at, gone_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL)",
                    params![
                        "broken",
                        "owner2",
                        "not-a-token",
                        vec![2_u8],
                        current,
                        current + 60
                    ],
                )
                .unwrap();
            connection
                .execute(
                    "INSERT INTO scenes
                     (code, owner_secret, payload, fingerprint, created_at, expires_at, gone_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL)",
                    params![
                        "badtyp",
                        "owner3",
                        vec![0_u8, 159, 146, 150],
                        vec![3_u8],
                        current,
                        current + 60
                    ],
                )
                .unwrap();
        }

        let gone_path = directory.path().join("gone.ply");
        std::fs::write(&gone_path, include_bytes!("../tests/fixtures/tetra.ply")).unwrap();
        let gone_scene = SceneDescriptor::create(std::slice::from_ref(&gone_path), None)
            .await
            .unwrap();
        registry.register(&gone_scene).unwrap();
        std::fs::remove_file(gone_path).unwrap();

        let audit = registry.audit().await.unwrap();
        assert_eq!(audit.valid, 1);
        assert_eq!(audit.expired, 1);
        assert_eq!(audit.source_gone, 1);
        assert_eq!(audit.tombstoned, 1);
        assert_eq!(audit.corrupt, 3);
        assert_eq!(audit.valid + audit.invalid(), 7);
        assert_eq!(registry.clean_invalid(&audit).await.unwrap(), 6);
        assert!(registry.resolve(&valid.code).is_ok());
        assert_eq!(registry.audit().await.unwrap().valid, 1);
    }

    #[tokio::test]
    async fn clean_preserves_a_source_restored_after_the_audit() {
        let directory = tempfile::tempdir().unwrap();
        let mesh_path = directory.path().join("mesh.ply");
        let mesh = include_bytes!("../tests/fixtures/tetra.ply");
        std::fs::write(&mesh_path, mesh).unwrap();
        let config = Config::fresh();
        let registry = Registry::open_at(&config, directory.path().join("scenes.sqlite3")).unwrap();
        let scene = SceneDescriptor::create(std::slice::from_ref(&mesh_path), None)
            .await
            .unwrap();
        let registration = registry.register(&scene).unwrap();

        std::fs::remove_file(&mesh_path).unwrap();
        let audit = registry.audit().await.unwrap();
        assert_eq!(audit.source_gone, 1);
        std::fs::write(&mesh_path, mesh).unwrap();

        assert_eq!(registry.clean_invalid(&audit).await.unwrap(), 0);
        assert!(registry.resolve(&registration.code).is_ok());
    }

    #[tokio::test]
    async fn maintenance_connection_updates_an_open_server_registry() {
        let directory = tempfile::tempdir().unwrap();
        let mesh_path = directory.path().join("mesh.ply");
        std::fs::write(&mesh_path, include_bytes!("../tests/fixtures/tetra.ply")).unwrap();
        let config = Config::fresh();
        let database = directory.path().join("scenes.sqlite3");
        let server_registry = Registry::open_at(&config, database.clone()).unwrap();
        let maintenance_registry = Registry::open_at(&config, database).unwrap();
        let scene = SceneDescriptor::create(std::slice::from_ref(&mesh_path), None)
            .await
            .unwrap();
        let registration = server_registry.register(&scene).unwrap();

        assert!(server_registry.resolve(&registration.code).is_ok());
        assert_eq!(maintenance_registry.clear().unwrap(), 1);
        assert!(matches!(
            server_registry.resolve(&registration.code),
            Err(RegistryLookupError::NotFound)
        ));
    }

    #[tokio::test]
    async fn clear_all_does_not_require_a_valid_scene_key() {
        let directory = tempfile::tempdir().unwrap();
        let mesh_path = directory.path().join("mesh.ply");
        std::fs::write(&mesh_path, include_bytes!("../tests/fixtures/tetra.ply")).unwrap();
        let database = directory.path().join("scenes.sqlite3");
        let config = Config::fresh();
        let registry = Registry::open_at(&config, database.clone()).unwrap();
        let scene = SceneDescriptor::create(std::slice::from_ref(&mesh_path), None)
            .await
            .unwrap();
        registry.register(&scene).unwrap();

        let mut invalid_config = config;
        invalid_config.secret = "invalid".into();
        assert!(Registry::open_at(&invalid_config, database.clone()).is_err());
        assert_eq!(Registry::clear_at_without_key(&database).unwrap(), 1);
        assert_eq!(Registry::clear_at_without_key(&database).unwrap(), 0);
    }

    #[tokio::test]
    async fn legacy_registry_binds_only_the_matching_key_and_clear_recovers() {
        let directory = tempfile::tempdir().unwrap();
        let mesh_path = directory.path().join("mesh.ply");
        std::fs::write(&mesh_path, include_bytes!("../tests/fixtures/tetra.ply")).unwrap();
        let database = directory.path().join("scenes.sqlite3");
        let config = Config::fresh();
        {
            let registry = Registry::open_at(&config, database.clone()).unwrap();
            let scene = SceneDescriptor::create(std::slice::from_ref(&mesh_path), None)
                .await
                .unwrap();
            registry.register(&scene).unwrap();
            registry
                .lock()
                .unwrap()
                .execute("DELETE FROM registry_meta", [])
                .unwrap();
        }

        let other_config = Config::fresh();
        let error = match Registry::open_at(&other_config, database.clone()) {
            Ok(_) => panic!("wrong key unexpectedly opened the registry"),
            Err(error) => error,
        };
        assert!(is_key_mismatch(&error));
        assert!(Registry::open_at(&config, database.clone()).is_ok());
        assert!(Registry::open_at(&other_config, database.clone()).is_err());
        assert_eq!(Registry::clear_at_without_key(&database).unwrap(), 1);
        assert!(Registry::open_at(&other_config, database).is_ok());
    }

    #[test]
    fn repair_rejects_a_malformed_expiry_index() {
        let directory = tempfile::tempdir().unwrap();
        let config = Config::fresh();
        let registry = Registry::open_at(&config, directory.path().join("scenes.sqlite3")).unwrap();
        registry
            .lock()
            .unwrap()
            .execute_batch(
                "DROP INDEX scenes_expires_at;
                 CREATE INDEX scenes_expires_at ON scenes(created_at);",
            )
            .unwrap();

        assert!(
            registry
                .repair()
                .unwrap_err()
                .to_string()
                .contains("expiry index is malformed")
        );
    }

    #[test]
    fn repair_restores_authoritative_key_identity() {
        let directory = tempfile::tempdir().unwrap();
        let config = Config::fresh();
        let registry = Registry::open_at(&config, directory.path().join("scenes.sqlite3")).unwrap();
        registry
            .lock()
            .unwrap()
            .execute(
                "UPDATE registry_meta SET value = 'drifted' WHERE key = 'scene_key_id'",
                [],
            )
            .unwrap();

        registry.repair().unwrap();
        let stored: String = registry
            .lock()
            .unwrap()
            .query_row(
                "SELECT value FROM registry_meta WHERE key = 'scene_key_id'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(stored, registry.key_id);
    }
}
