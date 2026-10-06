use crate::scene::SceneSource;
use std::{
    collections::{BTreeMap, HashMap, VecDeque},
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
    plugin::RendererBundle,
    runtime::config::{Config, random_b64, registry_path},
    scene::{MeshRef, SceneDescriptor},
    storage::sources::{Observed, SourceError, Sources},
    storage::token::{Scope, TokenCodec},
};

pub const SHORT_CODE_LEN: usize = 6;
const TOMBSTONE_SECONDS: i64 = 24 * 60 * 60;
const MAX_ACTIVE_SCENES: i64 = 10_000;
const MAX_REGISTRY_ROWS: i64 = 12_000;

pub struct Registry {
    pub sources: crate::storage::sources::Sources,
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
    path: String,
    byte_size: u64,
    modified_ns: Option<u64>,
    change_ns: Option<u64>,
    revision: String,
}

impl ObservedSource {
    fn matches(&self, mesh: &MeshRef, check_metadata: bool) -> bool {
        self.path == mesh.path
            && self.byte_size == mesh.byte_size
            && self.revision == mesh.revision
            && (!check_metadata
                || (mesh
                    .modified_ns
                    .is_none_or(|value| self.modified_ns == Some(value))
                    && mesh
                        .change_ns
                        .is_none_or(|value| self.change_ns == Some(value))))
    }
}

impl From<Observed> for ObservedSource {
    fn from(observed: Observed) -> Self {
        Self {
            path: observed.path,
            byte_size: observed.size,
            modified_ns: observed.modified_ns,
            change_ns: observed.change_ns,
            revision: observed.revision,
        }
    }
}

struct SourceCache {
    entries: HashMap<(Option<String>, String), ObservedSource>,
    insertion_order: VecDeque<(Option<String>, String)>,
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
            sources: crate::storage::sources::Sources::open(
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
        transaction.execute("DELETE FROM renderer_bundles", [])?;
        transaction.execute("DELETE FROM registry_meta WHERE key = 'scene_key_id'", [])?;
        transaction.commit()?;
        Ok(removed)
    }

    pub fn register(
        &self,
        scene: &SceneDescriptor,
        renderers: &[RendererBundle],
    ) -> Result<Registration> {
        let now = now();
        let fingerprint = self.fingerprint(scene)?;
        let days = scene.link_ttl_days();
        let expires_at = if days == 0 {
            i64::MAX
        } else {
            now + i64::from(days) * 86_400
        };
        let mut connection = self.lock()?;
        let transaction =
            connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let bundles = referenced_bundles(scene, renderers, &self.sources)?;
        if let Some(existing) = existing_registration(&transaction, &fingerprint, now)? {
            transaction.commit()?;
            return Ok(existing);
        }
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
        collect_renderer_garbage(&transaction, now)?;
        let payload = self.codec.seal(scene)?;
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
                store_renderers(&transaction, &registration.code, &bundles)?;
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
        let mut connection = self.lock()?;
        let transaction = connection.transaction()?;
        transaction.execute(
            "UPDATE scenes SET owner_secret = NULL, payload = NULL, fingerprint = NULL,
             gone_at = ?2, expires_at = min(expires_at, ?3) WHERE code = ?1",
            params![code, now, now + TOMBSTONE_SECONDS],
        )?;
        collect_renderer_garbage(&transaction, now)?;
        transaction.commit()?;
        Ok(())
    }

    /// Revoke credentials and immediately release snapshots that are no longer
    /// reachable through an active source. Collections keep their IDs and payload
    /// while at least one entry remains accessible; revoked entries fail the
    /// existing per-entry source authorization before any renderer lookup.
    pub fn revoke_source(&self, id: &str) -> Result<()> {
        let current = now();
        let mut connection = self.lock()?;
        let transaction =
            connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        self.sources.revoke(id)?;
        let mut statement = transaction.prepare(
            "SELECT code, payload FROM scenes
             WHERE payload IS NOT NULL AND gone_at IS NULL AND expires_at > ?1",
        )?;
        let mut rows = statement.query([current])?;
        while let Some(row) = rows.next()? {
            let code: String = row.get(0)?;
            let payload: String = row.get(1)?;
            let envelope = self.codec.open(&payload)?;
            if !envelope
                .scene
                .scene_entries()
                .any(|(_, part)| part.source.as_ref().is_some_and(|source| source.id == id))
            {
                continue;
            }
            let mut live = false;
            let mut revisions = std::collections::BTreeSet::new();
            for (_, part) in envelope.scene.scene_entries() {
                if scene_source_is_live(part, &self.sources)? {
                    live = true;
                    for entity in &part.entities {
                        if let Some(binding) = &entity.renderer {
                            revisions.insert(binding.revision.as_str());
                        }
                    }
                }
            }
            if !live {
                transaction.execute(
                    "UPDATE scenes SET owner_secret = NULL, payload = NULL, fingerprint = NULL,
                     gone_at = ?2, expires_at = min(expires_at, ?3) WHERE code = ?1",
                    params![code, current, current + TOMBSTONE_SECONDS],
                )?;
            } else {
                let retained = transaction
                    .prepare("SELECT revision FROM scene_renderers WHERE code = ?1")?
                    .query_map([&code], |row| row.get::<_, String>(0))?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                for revision in retained {
                    if !revisions.contains(revision.as_str()) {
                        transaction.execute(
                            "DELETE FROM scene_renderers WHERE code = ?1 AND revision = ?2",
                            params![code, revision],
                        )?;
                    }
                }
            }
        }
        drop(rows);
        drop(statement);
        collect_renderer_garbage(&transaction, current)?;
        transaction.commit()?;
        Ok(())
    }

    pub fn owner_matches(&self, expected: &str, candidate: &str) -> bool {
        expected.len() == candidate.len() && expected.as_bytes().ct_eq(candidate.as_bytes()).into()
    }

    pub fn clear(&self) -> Result<usize> {
        let mut connection = self.lock()?;
        let transaction = connection.transaction()?;
        let removed = transaction.execute("DELETE FROM scenes", [])?;
        transaction.execute("DELETE FROM renderer_bundles", [])?;
        transaction.commit()?;
        Ok(removed)
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
                                    || self.renderers_for_scene(&envelope.scene).is_err()
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
            collect_renderer_garbage(&transaction, now())?;
            transaction.commit()?;
        }
        Ok(removed)
    }

    pub fn prune(&self) -> Result<()> {
        self.prune_at(now())
    }

    fn prune_at(&self, now: i64) -> Result<()> {
        let mut connection = self.lock()?;
        let transaction = connection.transaction()?;
        transaction.execute(
            "DELETE FROM scenes WHERE expires_at < ?1",
            [now - TOMBSTONE_SECONDS],
        )?;
        collect_renderer_garbage(&transaction, now)?;
        transaction.commit()?;
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
        // Explicit default TTL and earlier short scenes have identical lifetimes.
        if canonical.ttl_days == Some(crate::scene::DEFAULT_TTL_DAYS) {
            canonical.ttl_days = None;
        }
        let mut hasher = Sha256::new();
        hasher.update(self.fingerprint_key);
        hasher.update(serde_json::to_vec(&canonical)?);
        Ok(hasher.finalize().to_vec())
    }

    /// Read the snapshots carried by a previously authorized scene for reshare.
    pub fn renderers_for_scene(&self, scene: &SceneDescriptor) -> Result<Vec<RendererBundle>> {
        let connection = self.lock()?;
        let mut bundles = BTreeMap::new();
        for (_, part) in scene.scene_entries() {
            if !scene_source_is_live(part, &self.sources)? {
                continue;
            }
            for entity in &part.entities {
                if let Some(binding) = &entity.renderer {
                    if !bundles.contains_key(&binding.revision) {
                        bundles.insert(
                            binding.revision.clone(),
                            load_renderer(&connection, &binding.revision)?,
                        );
                    }
                }
            }
        }
        let bundles: Vec<_> = bundles.into_values().collect();
        referenced_bundles(scene, &bundles, &self.sources)?;
        Ok(bundles)
    }

    /// A revision is never an authorization credential: the caller must have
    /// selected the entity binding from this active, authorized scene.
    pub fn renderer_document(
        &self,
        code: &str,
        binding: &crate::scene::component::RendererBinding,
    ) -> Result<(Vec<u8>, Vec<String>)> {
        let connection = self.lock()?;
        let retained: bool = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM scene_renderers r JOIN scenes s ON s.code = r.code
             WHERE r.code = ?1 AND r.revision = ?2 AND s.payload IS NOT NULL
               AND s.gone_at IS NULL AND s.expires_at > ?3)",
            params![code, binding.revision, now()],
            |row| row.get(0),
        )?;
        anyhow::ensure!(retained, "renderer is not retained by this active scene");
        let bundle = load_renderer(&connection, &binding.revision)?;
        crate::plugin::validate_binding_metadata(&bundle, binding)?;
        let definition = bundle
            .components
            .iter()
            .find(|c| c.name == binding.name)
            .context("renderer definition missing")?;
        let document = bundle
            .documents
            .get(&definition.entrypoint)
            .context("renderer document missing")?;
        Ok((document.as_bytes().to_vec(), binding.frame_origins.clone()))
    }

    fn lock(&self) -> Result<MutexGuard<'_, Connection>> {
        self.connection
            .lock()
            .map_err(|_| anyhow::anyhow!("short-link registry lock was poisoned"))
    }
}

/// Conflict domains are individual scenes, not collections: separate children
/// may intentionally pin different releases of the same plugin.
fn referenced_bundles<'a>(
    scene: &SceneDescriptor,
    supplied: &'a [RendererBundle],
    sources: &Sources,
) -> Result<Vec<(String, &'a RendererBundle)>> {
    let mut available = BTreeMap::new();
    for bundle in supplied {
        // revision() validates browser paths, protocol, capabilities and limits.
        available.insert(bundle.revision()?, bundle);
    }
    anyhow::ensure!(
        available.len() <= 64,
        "too many renderer snapshots in one share"
    );
    let bytes: usize = available
        .values()
        .flat_map(|bundle| bundle.documents.values())
        .map(String::len)
        .sum();
    anyhow::ensure!(bytes <= 8 * 1024 * 1024, "renderer documents exceed 8 MiB");
    let mut retained = BTreeMap::new();
    let mut live = false;
    for (_, part) in scene.scene_entries() {
        if !scene_source_is_live(part, sources)? {
            continue;
        }
        live = true;
        let mut candidates = BTreeMap::new();
        for entity in &part.entities {
            match (&entity.component, &entity.renderer) {
                (crate::scene::component::ComponentKind::Plugin(kind), Some(binding)) => {
                    anyhow::ensure!(
                        kind.split_once(':')
                            == Some((binding.plugin.as_str(), binding.name.as_str())),
                        "component and renderer binding differ"
                    );
                    let bundle = *available
                        .get(&binding.revision)
                        .context("required renderer bundle missing")?;
                    crate::plugin::validate_binding_metadata(bundle, binding)?;
                    if let Some(previous) = candidates.insert(&bundle.id, &binding.revision) {
                        anyhow::ensure!(
                            previous == &binding.revision,
                            "conflicting renderer versions within one scene"
                        );
                    }
                    retained.insert(binding.revision.clone(), bundle);
                }
                (crate::scene::component::ComponentKind::Plugin(_), None) => {
                    bail!("plugin component has no renderer binding");
                }
                (_, Some(_)) => bail!("built-in component cannot carry a plugin renderer"),
                (_, None) => {}
            }
        }
    }
    anyhow::ensure!(live, "scene has no active source");
    Ok(retained.into_iter().collect())
}

fn load_renderer(connection: &Connection, revision: &str) -> Result<RendererBundle> {
    let json: String = connection
        .query_row(
            "SELECT bundle FROM renderer_bundles WHERE revision = ?1",
            [revision],
            |row| row.get(0),
        )
        .optional()?
        .context("pinned renderer snapshot missing")?;
    let bundle: RendererBundle = serde_json::from_str(&json)?;
    // Hash once, including the same validation as initial upload.
    anyhow::ensure!(
        bundle.revision()? == revision,
        "renderer snapshot hash mismatch"
    );
    Ok(bundle)
}

fn store_renderers(
    connection: &Connection,
    code: &str,
    bundles: &[(String, &RendererBundle)],
) -> Result<()> {
    for (revision, bundle) in bundles {
        let exists: bool = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM renderer_bundles WHERE revision = ?1)",
            [revision],
            |row| row.get(0),
        )?;
        if !exists {
            connection.execute(
                "INSERT INTO renderer_bundles(revision, bundle) VALUES (?1, ?2)",
                params![revision, serde_json::to_string(bundle)?],
            )?;
        }
        connection.execute(
            "INSERT OR IGNORE INTO scene_renderers(code, revision) VALUES (?1, ?2)",
            params![code, revision],
        )?;
    }
    Ok(())
}

fn collect_renderer_garbage(connection: &Connection, current: i64) -> Result<()> {
    connection.execute(
        "DELETE FROM scene_renderers WHERE code IN (
            SELECT code FROM scenes WHERE payload IS NULL OR gone_at IS NOT NULL OR expires_at <= ?1
        )",
        [current],
    )?;
    connection.execute(
        "DELETE FROM renderer_bundles WHERE NOT EXISTS (
            SELECT 1 FROM scene_renderers WHERE scene_renderers.revision = renderer_bundles.revision
        )",
        [],
    )?;
    Ok(())
}

pub fn is_key_mismatch(error: &anyhow::Error) -> bool {
    error.downcast_ref::<RegistryKeyMismatch>().is_some()
}

fn scene_source_is_live(scene: &SceneDescriptor, sources: &Sources) -> Result<bool> {
    match sources.validate_source(scene) {
        Ok(()) => Ok(true),
        Err(SourceError::Gone) => Ok(false),
        Err(error) => Err(error.into()),
    }
}

async fn scene_sources_are_valid(
    scene: &SceneDescriptor,
    cache: &mut SourceCache,
    sources: &crate::storage::sources::Sources,
) -> Result<bool, crate::storage::sources::SourceError> {
    if scene.collection.is_some() {
        let mut valid = false;
        let mut unavailable = None;
        for (_, child) in scene.scene_entries() {
            match single_scene_sources_are_valid(child, cache, sources).await {
                Ok(true) => valid = true,
                Ok(false) | Err(crate::storage::sources::SourceError::Gone) => {}
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
    sources: &Sources,
) -> Result<bool, SourceError> {
    match sources.validate_source(scene) {
        Ok(()) => {}
        Err(SourceError::Gone) => return Ok(false),
        Err(error) => return Err(error),
    }
    for mesh in &scene.meshes {
        let observed = match cache
            .observe(sources, scene.source.as_ref(), &mesh.path)
            .await
        {
            Ok(observed) => observed,
            Err(SourceError::Gone) | Err(SourceError::TooLarge) => return Ok(false),
            Err(error) => return Err(error),
        };
        if !observed.matches(
            mesh,
            scene.source.is_some() || crate::storage::oss::is_oss(&mesh.path),
        ) {
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

    async fn observe(
        &mut self,
        sources: &Sources,
        source: Option<&SceneSource>,
        path: &str,
    ) -> Result<&ObservedSource, SourceError> {
        let key = (
            if crate::storage::oss::is_oss(path) {
                None
            } else {
                source.map(|source| source.id.clone())
            },
            path.to_owned(),
        );
        if !self.entries.contains_key(&key) {
            let observed = ObservedSource::from(sources.observe(source, path, false).await?);
            if self.entries.len() >= Self::MAX_ENTRIES
                && let Some(oldest) = self.insertion_order.pop_front()
            {
                self.entries.remove(&oldest);
            }
            self.insertion_order.push_back(key.clone());
            self.entries.insert(key.clone(), observed);
        }
        Ok(&self.entries[&key])
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
    let mut connection =
        Connection::open(path).with_context(|| format!("failed to open {}", path.display()))?;
    connection.busy_timeout(std::time::Duration::from_secs(2))?;
    if is_new {
        connection.pragma_update(None, "auto_vacuum", "INCREMENTAL")?;
    }
    connection.pragma_update(None, "journal_mode", "WAL")?;
    connection.pragma_update(None, "synchronous", "NORMAL")?;
    // Saved URLs may share canonical content. Registration deduplicates inside
    // its write transaction rather than a unique fingerprint constraint.
    let scene_schema: Option<String> = connection
        .query_row(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'scenes'",
            [],
            |row| row.get(0),
        )
        .optional()?;
    if scene_schema
        .as_ref()
        .is_some_and(|sql| sql.contains("fingerprint BLOB UNIQUE"))
    {
        let transaction = connection.transaction()?;
        transaction.execute_batch(
            "ALTER TABLE scenes RENAME TO scenes_before_renderer_snapshots;
             CREATE TABLE scenes (
                code TEXT PRIMARY KEY CHECK(length(code) = 6),
                owner_secret TEXT, payload TEXT, fingerprint BLOB,
                created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, gone_at INTEGER
             );
             INSERT INTO scenes SELECT * FROM scenes_before_renderer_snapshots;
             DROP TABLE scenes_before_renderer_snapshots;",
        )?;
        transaction.commit()?;
    }
    connection.pragma_update(None, "foreign_keys", "ON")?;
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS scenes (
            code TEXT PRIMARY KEY CHECK(length(code) = 6),
            owner_secret TEXT,
            payload TEXT,
            fingerprint BLOB,
            created_at INTEGER NOT NULL,
            expires_at INTEGER NOT NULL,
            gone_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS scenes_expires_at ON scenes(expires_at);
        CREATE INDEX IF NOT EXISTS scenes_fingerprint ON scenes(fingerprint);
        CREATE TABLE IF NOT EXISTS renderer_bundles (
            revision TEXT PRIMARY KEY,
            bundle TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS scene_renderers (
            code TEXT NOT NULL REFERENCES scenes(code) ON DELETE CASCADE,
            revision TEXT NOT NULL REFERENCES renderer_bundles(revision),
            PRIMARY KEY(code, revision)
        );
        CREATE INDEX IF NOT EXISTS scene_renderers_revision ON scene_renderers(revision);
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

impl crate::protocol::control::DoctorRegistryReport {
    pub fn new(audit: &RegistryAudit, removed: usize) -> Self {
        Self {
            valid: audit.valid,
            unavailable: audit.unavailable,
            expired: audit.expired,
            source_gone: audit.source_gone,
            tombstoned: audit.tombstoned,
            corrupt: audit.corrupt,
            removed,
            preserved: audit.invalid().saturating_sub(removed),
            audit_skipped: false,
            key_repaired: false,
            lod_cache: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn renderer(version: &str, document: &str) -> RendererBundle {
        RendererBundle {
            id: "reader".into(),
            version: version.into(),
            components: vec![crate::plugin::RendererDefinition {
                name: "document".into(),
                entrypoint: "viewer.html".into(),
                api_version: 1,
                capabilities: Default::default(),
                extensions: vec!["reader".into()],
                frame_origins: Vec::new(),
            }],
            documents: BTreeMap::from([("viewer.html".into(), document.into())]),
        }
    }

    fn renderer_scene(title: &str, bundle: &RendererBundle) -> SceneDescriptor {
        let kind = crate::scene::component::ComponentKind::Plugin("reader:document".into());
        SceneDescriptor {
            schema: 5,
            source: None,
            title: title.into(),
            created_at: now() as u64,
            ttl_days: Some(0),
            meshes: Vec::new(),
            entities: vec![crate::scene::component::SceneEntity {
                id: "document".into(),
                placement: crate::scene::component::Placement::World,
                renderer: crate::plugin::bind_renderer(&kind, std::slice::from_ref(bundle))
                    .unwrap(),
                component: kind,
                source: crate::scene::component::ComponentSource::Attachment(0),
                label: "Document".into(),
                group: None,
                position: None,
                size: None,
                visible: true,
                opacity: 1.,
                state: None,
            }],
            attachments: vec![crate::scene::SceneAttachment {
                id: "document".into(),
                path: "oss://assets/document.reader".into(),
                label: "Document".into(),
                byte_size: Some(1),
                revision: Some("sha256:source".into()),
                unavailable: None,
                member: None,
            }],
            warnings: Vec::new(),
            collection: None,
            label_groups: Vec::new(),
            state: Default::default(),
        }
    }

    fn snapshot_counts(registry: &Registry) -> (i64, i64) {
        registry.lock().unwrap().query_row(
            "SELECT (SELECT count(*) FROM renderer_bundles), (SELECT count(*) FROM scene_renderers)",
            [], |row| Ok((row.get(0)?, row.get(1)?)),
        ).unwrap()
    }

    #[test]
    fn source_revocation_releases_permanent_snapshots_without_opening_a_link() {
        let directory = tempfile::tempdir().unwrap();
        let config = Config::fresh();
        let path = directory.path().join("scenes.sqlite3");
        let registry = Registry::open_at(&config, path.clone()).unwrap();
        let client = registry
            .sources
            .local("Client".into(), "host".into(), "user".into())
            .unwrap();
        let bundle = renderer("1.0.0", "<p>Permanent</p>");
        let mut scene = renderer_scene("Permanent", &bundle);
        scene.source = Some(client.source.scene_source());
        let link = registry
            .register(&scene, std::slice::from_ref(&bundle))
            .unwrap();
        assert_eq!(snapshot_counts(&registry), (1, 1));

        // No resolve, viewer request, audit, or prune is needed to release CAS.
        registry.revoke_source(&client.source.id).unwrap();
        assert_eq!(snapshot_counts(&registry), (0, 0));
        assert!(
            registry
                .sources
                .authenticate(&client.credential, false)
                .is_err()
        );
        assert!(matches!(
            registry.resolve(&link.code),
            Err(RegistryLookupError::Gone)
        ));
        assert!(
            registry
                .register(&scene, std::slice::from_ref(&bundle))
                .is_err()
        );
        assert_eq!(snapshot_counts(&registry), (0, 0));
        registry.revoke_source(&client.source.id).unwrap();
        drop(registry);

        let registry = Registry::open_at(&config, path).unwrap();
        assert_eq!(snapshot_counts(&registry), (0, 0));
        assert!(matches!(
            registry.resolve(&link.code),
            Err(RegistryLookupError::Gone)
        ));
        registry.prune_at(now() + 3 * 86_400).unwrap();
        assert!(matches!(
            registry.resolve(&link.code),
            Err(RegistryLookupError::NotFound)
        ));
    }

    #[test]
    fn mixed_source_collection_retains_only_reachable_revisions_and_can_reshare() {
        let directory = tempfile::tempdir().unwrap();
        let registry =
            Registry::open_at(&Config::fresh(), directory.path().join("scenes.sqlite3")).unwrap();
        let a = registry
            .sources
            .local("A".into(), "host".into(), "a".into())
            .unwrap();
        let b = registry
            .sources
            .local("B".into(), "host".into(), "b".into())
            .unwrap();
        let old = renderer("1.0.0", "<p>Revoked only</p>");
        let active = renderer("2.0.0", "<p>Active only</p>");
        let common = renderer("3.0.0", "<p>Both sources</p>");
        let mut root = renderer_scene("Revoked root", &old);
        root.source = Some(a.source.scene_source());
        root.schema = 6;
        let mut next = renderer_scene("Active child", &active);
        next.source = Some(b.source.scene_source());
        let mut shared_a = renderer_scene("Revoked shared", &common);
        shared_a.source = Some(a.source.scene_source());
        let mut shared_b = renderer_scene("Active shared", &common);
        shared_b.source = Some(b.source.scene_source());
        root.collection = Some(crate::scene::SceneCollection {
            title: "Mixed".into(),
            first_id: "root".into(),
            active_scene_id: "next".into(),
            scenes: vec![
                crate::scene::CollectionEntry {
                    id: "next".into(),
                    scene: next,
                },
                crate::scene::CollectionEntry {
                    id: "shared-a".into(),
                    scene: shared_a,
                },
                crate::scene::CollectionEntry {
                    id: "shared-b".into(),
                    scene: shared_b,
                },
            ],
            strokes: Vec::new(),
            layout: None,
        });
        let bundles = vec![old, active, common];
        let link = registry.register(&root, &bundles).unwrap();
        assert_eq!(snapshot_counts(&registry), (3, 3));

        registry.revoke_source(&a.source.id).unwrap();
        assert_eq!(snapshot_counts(&registry), (2, 2));
        assert!(registry.sources.authenticate(&b.credential, false).is_ok());
        let mut stored = registry.resolve(&link.code).unwrap().scene;
        assert_eq!(stored.scene_entries().count(), 4);
        assert!(matches!(
            registry.sources.validate_source(&stored),
            Err(SourceError::Gone)
        ));
        assert!(
            registry
                .renderer_document(&link.code, stored.entities[0].renderer.as_ref().unwrap())
                .is_err()
        );
        let next_binding = stored.scene_by_id("next").unwrap().entities[0]
            .renderer
            .as_ref()
            .unwrap();
        assert_eq!(
            registry
                .renderer_document(&link.code, next_binding)
                .unwrap()
                .0,
            b"<p>Active only</p>"
        );
        let shared_binding = stored.scene_by_id("shared-b").unwrap().entities[0]
            .renderer
            .as_ref()
            .unwrap();
        assert_eq!(
            registry
                .renderer_document(&link.code, shared_binding)
                .unwrap()
                .0,
            b"<p>Both sources</p>"
        );

        // Reshare uses only live snapshots; dead children keep stable collection
        // IDs but neither require nor re-pin their collected renderer revision.
        stored.collection.as_mut().unwrap().title = "Reshared mixed".into();
        let inherited = registry.renderers_for_scene(&stored).unwrap();
        assert_eq!(inherited.len(), 2);
        let reshared = registry.register(&stored, &inherited).unwrap();
        assert_ne!(link.code, reshared.code);
        assert_eq!(snapshot_counts(&registry), (2, 4));
        registry.revoke_source(&b.source.id).unwrap();
        assert_eq!(snapshot_counts(&registry), (0, 0));
        assert!(matches!(
            registry.resolve(&link.code),
            Err(RegistryLookupError::Gone)
        ));
        assert!(matches!(
            registry.resolve(&reshared.code),
            Err(RegistryLookupError::Gone)
        ));
        assert!(registry.renderers_for_scene(&stored).is_err());
    }

    #[test]
    fn shared_snapshot_survives_reshare_and_is_collected_after_last_reference() {
        let directory = tempfile::tempdir().unwrap();
        let registry =
            Registry::open_at(&Config::fresh(), directory.path().join("scenes.sqlite3")).unwrap();
        let bundle = renderer("1.0.0", "<!doctype html><p>Reader</p>");
        let original = renderer_scene("first client", &bundle);
        let first = registry
            .register(&original, std::slice::from_ref(&bundle))
            .unwrap();
        let mut second_scene = original.clone();
        second_scene.title = "second client".into();
        let second = registry
            .register(&second_scene, std::slice::from_ref(&bundle))
            .unwrap();
        let inherited = registry.renderers_for_scene(&original).unwrap();
        let mut edited = original.clone();
        edited.entities[0].position = Some([1., 2., 3.]);
        let reshare = registry.register(&edited, &inherited).unwrap();
        assert_eq!(snapshot_counts(&registry), (1, 3));
        registry.mark_gone(&first.code).unwrap();
        registry.mark_gone(&second.code).unwrap();
        assert_eq!(snapshot_counts(&registry), (1, 1));
        let binding = edited.entities[0].renderer.as_ref().unwrap();
        assert!(registry.renderer_document(&first.code, binding).is_err());
        assert_eq!(
            registry
                .renderer_document(&reshare.code, binding)
                .unwrap()
                .0,
            b"<!doctype html><p>Reader</p>"
        );
        registry.mark_gone(&reshare.code).unwrap();
        assert_eq!(snapshot_counts(&registry), (0, 0));
    }

    #[test]
    fn expiry_releases_only_expired_references_and_preserves_ttl_zero_after_restart() {
        let directory = tempfile::tempdir().unwrap();
        let config = Config::fresh();
        let path = directory.path().join("scenes.sqlite3");
        let registry = Registry::open_at(&config, path.clone()).unwrap();
        let bundle = renderer("1.0.0", "<p>Reader</p>");
        let permanent = renderer_scene("permanent", &bundle);
        let permanent_link = registry
            .register(&permanent, std::slice::from_ref(&bundle))
            .unwrap();
        let mut expiring = permanent.clone();
        expiring.title = "expiring".into();
        expiring.ttl_days = Some(1);
        let expired_link = registry
            .register(&expiring, std::slice::from_ref(&bundle))
            .unwrap();
        registry
            .lock()
            .unwrap()
            .execute(
                "UPDATE scenes SET expires_at = ?1 WHERE code = ?2",
                params![now() - 1, expired_link.code],
            )
            .unwrap();
        registry.prune().unwrap();
        assert_eq!(snapshot_counts(&registry), (1, 1));
        assert!(registry.resolve(&permanent_link.code).is_ok());
        assert!(matches!(
            registry.resolve(&expired_link.code),
            Err(RegistryLookupError::Gone)
        ));
        drop(registry);
        let registry = Registry::open_at(&config, path).unwrap();
        assert_eq!(snapshot_counts(&registry), (1, 1));
        registry.clear().unwrap();
        assert_eq!(snapshot_counts(&registry), (0, 0));
    }

    #[test]
    fn collection_children_can_pin_distinct_versions_but_one_scene_cannot() {
        let directory = tempfile::tempdir().unwrap();
        let registry =
            Registry::open_at(&Config::fresh(), directory.path().join("scenes.sqlite3")).unwrap();
        let first_bundle = renderer("1.0.0", "<p>first</p>");
        let next_bundle = renderer("2.0.0", "<p>next</p>");
        let mut first = renderer_scene("first", &first_bundle);
        let second = renderer_scene("next", &next_bundle);
        let mut conflict = first.clone();
        let mut next_entity = second.entities[0].clone();
        next_entity.id = "another-document".into();
        conflict.entities.push(next_entity);
        let bundles = vec![first_bundle, next_bundle];
        assert!(registry.register(&conflict, &bundles).is_err());
        assert_eq!(snapshot_counts(&registry), (0, 0));
        first.schema = 6;
        first.collection = Some(crate::scene::SceneCollection {
            title: "Releases".into(),
            first_id: "first".into(),
            active_scene_id: "next".into(),
            scenes: vec![crate::scene::CollectionEntry {
                id: "next".into(),
                scene: second,
            }],
            strokes: Vec::new(),
            layout: None,
        });
        let link = registry.register(&first, &bundles).unwrap();
        assert_eq!(snapshot_counts(&registry), (2, 2));
        let stored = registry.resolve(&link.code).unwrap().scene;
        let next = stored.scene_by_id("next").unwrap().entities[0]
            .renderer
            .as_ref()
            .unwrap();
        assert_eq!(
            registry.renderer_document(&link.code, next).unwrap().0,
            b"<p>next</p>"
        );
        registry.mark_gone(&link.code).unwrap();
        assert_eq!(snapshot_counts(&registry), (0, 0));
    }

    #[test]
    fn registration_failure_rolls_back_scene_and_renderer_and_rejects_incomplete_binding() {
        let directory = tempfile::tempdir().unwrap();
        let registry =
            Registry::open_at(&Config::fresh(), directory.path().join("scenes.sqlite3")).unwrap();
        let bundle = renderer("1.0.0", "<p>Reader</p>");
        let scene = renderer_scene("Reader", &bundle);
        assert!(registry.register(&scene, &[]).is_err());
        let mut forged = scene.clone();
        forged.entities[0]
            .renderer
            .as_mut()
            .unwrap()
            .capabilities
            .resizable = true;
        assert!(
            registry
                .register(&forged, std::slice::from_ref(&bundle))
                .is_err()
        );
        registry
            .lock()
            .unwrap()
            .execute_batch(
                "CREATE TRIGGER refuse_scene_renderer BEFORE INSERT ON scene_renderers
             BEGIN SELECT RAISE(ABORT, 'injected transaction failure'); END;",
            )
            .unwrap();
        assert!(
            registry
                .register(&scene, std::slice::from_ref(&bundle))
                .is_err()
        );
        assert_eq!(snapshot_counts(&registry), (0, 0));
        let scenes: i64 = registry
            .lock()
            .unwrap()
            .query_row("SELECT count(*) FROM scenes", [], |row| row.get(0))
            .unwrap();
        assert_eq!(scenes, 0);
    }

    #[tokio::test]
    async fn ttl_preserves_legacy_dedup_and_permanent_links_across_time_and_restart() {
        let directory = tempfile::tempdir().unwrap();
        let mesh_path = directory.path().join("mesh.ply");
        fs::write(&mesh_path, include_bytes!("../../tests/fixtures/tetra.ply")).unwrap();
        let config = Config::fresh();
        let db = directory.path().join("scenes.sqlite3");
        let registry = Registry::open_at(&config, db.clone()).unwrap();
        let mut scene = SceneDescriptor::create(std::slice::from_ref(&mesh_path), None)
            .await
            .unwrap();
        let legacy = registry.register(&scene, &[]).unwrap();
        scene.ttl_days = Some(7);
        assert_eq!(legacy.code, registry.register(&scene, &[]).unwrap().code);
        scene.ttl_days = Some(30);
        let monthly = registry.register(&scene, &[]).unwrap();
        scene.ttl_days = Some(0);
        let permanent = registry.register(&scene, &[]).unwrap();
        assert_ne!(permanent.code, legacy.code);
        assert_ne!(permanent.code, monthly.code);
        assert_eq!(permanent.code, registry.register(&scene, &[]).unwrap().code);
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
        fs::write(&mesh_path, include_bytes!("../../tests/fixtures/tetra.ply")).unwrap();
        let registry =
            Registry::open_at(&Config::fresh(), directory.path().join("scenes.sqlite3")).unwrap();
        let mut scene = SceneDescriptor::create(&[mesh_path], None).await.unwrap();
        scene.ttl_days = Some(0);
        let permanent = registry.register(&scene, &[]).unwrap();
        {
            let mut connection = registry.lock().unwrap();
            let transaction = connection.transaction().unwrap();
            for index in 0..MAX_REGISTRY_ROWS - 1 {
                transaction.execute("INSERT INTO scenes (code, created_at, expires_at, gone_at) VALUES (?1, ?2, ?2, ?2)", params![format!("{index:06}"), now() - 1]).unwrap();
            }
            transaction.commit().unwrap();
        }
        scene.title = "another permanent scene".into();
        registry.register(&scene, &[]).unwrap();
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
        std::fs::write(&mesh_path, include_bytes!("../../tests/fixtures/tetra.ply")).unwrap();
        let config = Config::fresh();
        let registry = Registry::open_at(&config, directory.path().join("scenes.sqlite3")).unwrap();
        let scene = SceneDescriptor::create(std::slice::from_ref(&mesh_path), None)
            .await
            .unwrap();
        let valid = registry.register(&scene, &[]).unwrap();

        let payload = registry.codec.seal(&scene).unwrap();
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
        std::fs::write(&gone_path, include_bytes!("../../tests/fixtures/tetra.ply")).unwrap();
        let gone_scene = SceneDescriptor::create(std::slice::from_ref(&gone_path), None)
            .await
            .unwrap();
        registry.register(&gone_scene, &[]).unwrap();
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
        let mesh = include_bytes!("../../tests/fixtures/tetra.ply");
        std::fs::write(&mesh_path, mesh).unwrap();
        let config = Config::fresh();
        let registry = Registry::open_at(&config, directory.path().join("scenes.sqlite3")).unwrap();
        let scene = SceneDescriptor::create(std::slice::from_ref(&mesh_path), None)
            .await
            .unwrap();
        let registration = registry.register(&scene, &[]).unwrap();

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
        std::fs::write(&mesh_path, include_bytes!("../../tests/fixtures/tetra.ply")).unwrap();
        let config = Config::fresh();
        let database = directory.path().join("scenes.sqlite3");
        let server_registry = Registry::open_at(&config, database.clone()).unwrap();
        let maintenance_registry = Registry::open_at(&config, database).unwrap();
        let scene = SceneDescriptor::create(std::slice::from_ref(&mesh_path), None)
            .await
            .unwrap();
        let registration = server_registry.register(&scene, &[]).unwrap();

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
        std::fs::write(&mesh_path, include_bytes!("../../tests/fixtures/tetra.ply")).unwrap();
        let database = directory.path().join("scenes.sqlite3");
        let config = Config::fresh();
        let registry = Registry::open_at(&config, database.clone()).unwrap();
        let scene = SceneDescriptor::create(std::slice::from_ref(&mesh_path), None)
            .await
            .unwrap();
        registry.register(&scene, &[]).unwrap();

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
        std::fs::write(&mesh_path, include_bytes!("../../tests/fixtures/tetra.ply")).unwrap();
        let database = directory.path().join("scenes.sqlite3");
        let config = Config::fresh();
        {
            let registry = Registry::open_at(&config, database.clone()).unwrap();
            let scene = SceneDescriptor::create(std::slice::from_ref(&mesh_path), None)
                .await
                .unwrap();
            registry.register(&scene, &[]).unwrap();
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
