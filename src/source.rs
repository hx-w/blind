//! Registered OS-user sources. The server owns SSH credentials; clients never upload private keys.
use crate::{
    config::random_b64,
    scene::{MeshRef, SceneDescriptor, hash_bytes},
};
use anyhow::{Context, Result, bail};
use base64::{
    Engine,
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs,
    io::{Read, Write},
    net::{TcpStream, ToSocketAddrs},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

pub const MAX_SOURCE_BYTES: u64 = 512 * 1024 * 1024;
const IO_TIMEOUT: Duration = Duration::from_secs(15);
const READ_DEADLINE: Duration = Duration::from_secs(120);

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SceneSource {
    pub id: String,
    pub name: String,
    pub host: String,
    pub user: String,
}
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
#[derive(Debug, Clone, thiserror::Error)]
pub enum SourceError {
    #[error("source was deleted, changed, or revoked")]
    Gone,
    #[error("source is temporarily unavailable: {0}")]
    Unavailable(String),
    #[error("source exceeds the 512 MiB file limit")]
    TooLarge,
}
impl SourceError {
    fn io(e: std::io::Error) -> Self {
        if e.kind() == std::io::ErrorKind::NotFound {
            Self::Gone
        } else {
            Self::Unavailable(e.to_string())
        }
    }
    fn ssh(e: ssh2::Error) -> Self {
        if matches!(e.code(), ssh2::ErrorCode::SFTP(2 | 10)) {
            Self::Gone
        } else {
            Self::Unavailable(e.to_string())
        }
    }
}
type SftpPool = Arc<Mutex<HashMap<String, Arc<tokio::sync::Mutex<Option<(Instant, ssh2::Sftp)>>>>>>;
#[derive(Clone)]
pub struct Sources {
    pool: SftpPool,
    db: Arc<Mutex<Connection>>,
    dir: PathBuf,
    slots: Arc<tokio::sync::Semaphore>,
}
pub struct Observed {
    pub path: String,
    pub size: u64,
    pub modified_ns: Option<u64>,
    pub change_ns: Option<u64>,
    pub revision: String,
    pub bytes: Vec<u8>,
}

#[derive(Clone, Copy)]
enum AccessMode {
    Metadata,
    Hash,
    Bytes,
}

fn ensure_invitations_schema(db: &mut Connection) -> Result<()> {
    let transaction = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let columns = {
        let mut statement = transaction.prepare("PRAGMA table_info(invitations)")?;
        statement
            .query_map([], |row| row.get::<_, String>(1))?
            .collect::<rusqlite::Result<Vec<_>>>()?
    };
    if columns != ["hash", "created"] {
        transaction.execute_batch(
            "DROP TABLE IF EXISTS invitations;
             CREATE TABLE invitations (
                 hash TEXT PRIMARY KEY,
                 created INTEGER NOT NULL
             );",
        )?;
    }
    transaction.commit()?;
    Ok(())
}

impl Sources {
    pub fn open(dir: &Path) -> Result<Self> {
        fs::create_dir_all(dir)?;
        private_dir(&dir.join("source-keys"))?;
        let path = dir.join("sources.sqlite3");
        let mut db = Connection::open(&path)?;
        db.busy_timeout(Duration::from_secs(5))?;
        ensure_invitations_schema(&mut db)?;
        db.execute_batch("CREATE TABLE IF NOT EXISTS sources (id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, record TEXT NOT NULL, challenge TEXT NOT NULL, expires INTEGER NOT NULL);")?;
        private_file(&path)?;
        Ok(Self {
            pool: Default::default(),
            db: Arc::new(Mutex::new(db)),
            dir: dir.to_owned(),
            slots: Arc::new(tokio::sync::Semaphore::new(4)),
        })
    }
    pub fn invite(&self, server: String) -> Result<Invitation> {
        let token = random_b64(32);
        let db = self
            .db
            .lock()
            .map_err(|_| anyhow::anyhow!("source registry poisoned"))?;
        let count: i64 = db.query_row("SELECT count(*) FROM invitations", [], |r| r.get(0))?;
        if count >= 128 {
            bail!("too many active invitations; revoke unused invitations first");
        }
        db.execute(
            "INSERT INTO invitations VALUES (?1,?2)",
            params![hash_bytes(token.as_bytes()), now()],
        )?;
        Ok(Invitation { server, token })
    }

    pub fn revoke_invitations(&self) -> Result<usize> {
        let mut db = self
            .db
            .lock()
            .map_err(|_| anyhow::anyhow!("source registry poisoned"))?;
        let transaction = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let pending = transaction
            .prepare("SELECT id FROM sources WHERE expires>0")?
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let revoked = transaction.execute("DELETE FROM invitations", [])?;
        transaction.execute("DELETE FROM sources WHERE expires>0", [])?;
        transaction.commit()?;
        drop(db);
        for id in pending {
            if valid_id(&id) {
                let _ = fs::remove_file(self.key_path(&id));
                let _ = fs::remove_file(self.key_path(&id).with_extension("pub"));
            }
        }
        Ok(revoked)
    }
    pub fn begin(&self, invite: &str, req: JoinRequest) -> Result<JoinResponse> {
        validate_label(&req.name)?;
        validate_label(&req.user)?;
        validate_address(&req.host, req.port)?;
        if !req.hostname.is_empty() {
            validate_label(&req.hostname)?;
        }
        self.prune_pending()?;
        let key = STANDARD
            .decode(&req.host_key)
            .context("invalid SSH host key")?;
        if key.len() < 32 || key.len() > 4096 {
            bail!("invalid SSH host key");
        }
        let id = random_b64(18);
        let source = Source {
            id: id.clone(),
            name: req.name,
            host: req.host,
            hostname: req.hostname,
            port: req.port,
            user: req.user,
            host_key: req.host_key,
            local: false,
            active: false,
        };
        let credential = format!("blind_client_{}", random_b64(32));
        let challenge = random_b64(32);
        let mut db = self
            .db
            .lock()
            .map_err(|_| anyhow::anyhow!("source registry poisoned"))?;
        let tx = db.transaction()?;
        let valid: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM invitations WHERE hash=?1)",
            [hash_bytes(invite.as_bytes())],
            |row| row.get(0),
        )?;
        if !valid {
            bail!("invitation invalid or revoked");
        }
        let count: i64 = tx.query_row("SELECT count(*) FROM sources", [], |r| r.get(0))?;
        if count >= 1024 {
            bail!("source registry is full");
        }
        let pending: i64 =
            tx.query_row("SELECT count(*) FROM sources WHERE expires>0", [], |row| {
                row.get(0)
            })?;
        if pending >= 32 {
            bail!("too many pending registrations; complete or revoke them first");
        }
        let key_path = self.key_path(&id);
        let output = std::process::Command::new("ssh-keygen")
            .args([
                "-q",
                "-t",
                "ed25519",
                "-N",
                "",
                "-C",
                "blind-readonly",
                "-f",
            ])
            .arg(&key_path)
            .output()?;
        if !output.status.success() {
            bail!("SSH key generation failed");
        }
        let public_key = fs::read_to_string(key_path.with_extension("pub"))?
            .trim()
            .to_owned();
        tx.execute(
            "INSERT INTO sources VALUES (?1,?2,?3,?4,?5)",
            params![
                id,
                hash_bytes(credential.as_bytes()),
                serde_json::to_string(&source)?,
                challenge,
                now() + 600
            ],
        )?;
        tx.commit()?;
        Ok(JoinResponse {
            source,
            credential,
            public_key,
            challenge,
        })
    }
    pub fn local(&self, name: String, host: String, user: String) -> Result<JoinResponse> {
        validate_label(&name)?;
        validate_label(&host)?;
        validate_label(&user)?;
        let source = Source {
            id: random_b64(18),
            name,
            hostname: host.clone(),
            host,
            user,
            port: 0,
            host_key: String::new(),
            local: true,
            active: true,
        };
        let credential = format!("blind_client_{}", random_b64(32));
        self.db.lock().unwrap().execute(
            "INSERT INTO sources VALUES (?1,?2,?3,'',0)",
            params![
                source.id,
                hash_bytes(credential.as_bytes()),
                serde_json::to_string(&source)?
            ],
        )?;
        Ok(JoinResponse {
            source,
            credential,
            public_key: String::new(),
            challenge: String::new(),
        })
    }
    pub fn authenticate(&self, token: &str, pending: bool) -> Result<Source> {
        let row: Option<(String, i64)> = self
            .db
            .lock()
            .unwrap()
            .query_row(
                "SELECT record,expires FROM sources WHERE token_hash=?1",
                [hash_bytes(token.as_bytes())],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        let (record, expires) = row.context("invalid Client credential")?;
        let source: Source = serde_json::from_str(&record)?;
        if !source.active && (!pending || expires < now()) {
            bail!("source is not active");
        }
        Ok(source)
    }
    pub fn get(&self, id: &str) -> std::result::Result<Source, SourceError> {
        let row: Option<String> = self
            .db
            .lock()
            .unwrap()
            .query_row("SELECT record FROM sources WHERE id=?1", [id], |r| r.get(0))
            .optional()
            .map_err(|e| SourceError::Unavailable(e.to_string()))?;
        let source: Source = serde_json::from_str(&row.ok_or(SourceError::Gone)?)
            .map_err(|e| SourceError::Unavailable(e.to_string()))?;
        if !source.active {
            return Err(SourceError::Gone);
        }
        Ok(source)
    }
    pub fn list(&self) -> Result<Vec<Source>> {
        let db = self.db.lock().unwrap();
        let mut stmt = db.prepare("SELECT record FROM sources ORDER BY id")?;
        let records = stmt
            .query_map([], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        records
            .into_iter()
            .map(|r| Ok(serde_json::from_str(&r)?))
            .collect()
    }
    pub fn revoke(&self, id: &str) -> Result<()> {
        self.db
            .lock()
            .unwrap()
            .execute("DELETE FROM sources WHERE id=?1", [id])?;
        // IDs come from an authenticated database record or validated admin input.
        self.pool.lock().unwrap().remove(id);
        if valid_id(id) {
            let _ = fs::remove_file(self.key_path(id));
            let _ = fs::remove_file(self.key_path(id).with_extension("pub"));
        }
        Ok(())
    }
    fn prune_pending(&self) -> Result<()> {
        let db = self.db.lock().unwrap();
        let ids = db
            .prepare("SELECT id FROM sources WHERE expires>0 AND expires<?1")?
            .query_map([now()], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for id in ids {
            db.execute("DELETE FROM sources WHERE id=?1", [&id])?;
            if valid_id(&id) {
                let _ = fs::remove_file(self.key_path(&id));
                let _ = fs::remove_file(self.key_path(&id).with_extension("pub"));
            }
        }
        Ok(())
    }
    pub async fn finish(&self, mut source: Source, request: FinishRequest) -> Result<Source> {
        if let Some(host) = request.host {
            source.host = host;
        }
        if let Some(port) = request.port {
            source.port = port;
        }
        validate_address(&source.host, source.port)?;
        let path = request.challenge_path;
        let expected: String = self.db.lock().unwrap().query_row(
            "SELECT challenge FROM sources WHERE id=?1",
            [&source.id],
            |r| r.get(0),
        )?;
        let source_copy = source.clone();
        let key = self.key_path(&source.id);
        let permit = self.slots.clone().acquire_owned().await?;
        tokio::task::spawn_blocking(move || -> Result<()> {
            let _permit = permit;
            validate_path(&path)?;
            let sftp = connect(&source_copy, &key).map_err(anyhow::Error::from)?;
            let data = read_sftp(&sftp, &path, true, 4096).map_err(anyhow::Error::from)?;
            if data.bytes != expected.as_bytes() {
                bail!("source ownership verification failed");
            }
            // This file is an explicit disposable registration probe. An unrestricted key must never activate.
            let mut writable = false;
            match sftp.open_mode(
                Path::new(&path),
                ssh2::OpenFlags::WRITE,
                0,
                ssh2::OpenType::File,
            ) {
                Ok(_) => writable = true,
                Err(e) if matches!(e.code(), ssh2::ErrorCode::SFTP(3)) => {}
                Err(e) => return Err(e.into()),
            }
            if writable {
                bail!("SFTP key is writable; install the forced read-only SFTP authorization");
            }
            Ok(())
        })
        .await??;
        source.active = true;
        let n = self.db.lock().unwrap().execute(
            "UPDATE sources SET record=?1,challenge='',expires=0 WHERE id=?2 AND expires>=?3",
            params![serde_json::to_string(&source)?, source.id, now()],
        )?;
        if n != 1 {
            bail!("registration expired or revoked while verifying");
        }
        Ok(source)
    }
    fn key_path(&self, id: &str) -> PathBuf {
        self.dir.join("source-keys").join(id)
    }
    pub async fn observe(
        &self,
        source: Option<&SceneSource>,
        path: &str,
        bytes: bool,
    ) -> std::result::Result<Observed, SourceError> {
        self.access(
            source,
            path,
            if bytes {
                AccessMode::Bytes
            } else {
                AccessMode::Hash
            },
        )
        .await
    }
    pub async fn metadata(
        &self,
        source: Option<&SceneSource>,
        path: &str,
    ) -> std::result::Result<Observed, SourceError> {
        self.access(source, path, AccessMode::Metadata).await
    }
    async fn access(
        &self,
        source: Option<&SceneSource>,
        path: &str,
        mode: AccessMode,
    ) -> std::result::Result<Observed, SourceError> {
        let registered = source.map(|s| self.get(&s.id)).transpose()?;
        let path = path.to_owned();
        let key = registered.as_ref().map(|s| self.key_path(&s.id));
        let pool = registered.as_ref().filter(|s| !s.local).map(|s| {
            let mut pool = self.pool.lock().unwrap();
            if pool.len() >= 32 && !pool.contains_key(&s.id) {
                pool.clear();
            }
            pool.entry(s.id.clone()).or_default().clone()
        });
        // Wait for this source before reserving global I/O capacity, so a slow host
        // cannot consume all transport slots with requests queued on one connection.
        let cached = match pool {
            Some(pool) => Some(pool.lock_owned().await),
            None => None,
        };
        let permit = self
            .slots
            .clone()
            .acquire_owned()
            .await
            .map_err(|e| SourceError::Unavailable(e.to_string()))?;
        let result = tokio::task::spawn_blocking(move || {
            let _permit = permit;
            validate_path(&path).map_err(|e| SourceError::Unavailable(e.to_string()))?;
            match registered {
                Some(s) if !s.local => {
                    let mut cached = cached.unwrap();
                    if cached
                        .as_ref()
                        .is_some_and(|(t, _)| t.elapsed() > Duration::from_secs(30))
                    {
                        *cached = None;
                    }
                    if cached.is_none() {
                        *cached = Some((Instant::now(), connect(&s, key.as_ref().unwrap())?));
                    }
                    let result = match mode {
                        AccessMode::Metadata => {
                            stat_sftp(&cached.as_ref().unwrap().1, &path, MAX_SOURCE_BYTES)
                        }
                        AccessMode::Hash => {
                            read_sftp(&cached.as_ref().unwrap().1, &path, false, MAX_SOURCE_BYTES)
                        }
                        AccessMode::Bytes => {
                            read_sftp(&cached.as_ref().unwrap().1, &path, true, MAX_SOURCE_BYTES)
                        }
                    };
                    if result.is_err() {
                        *cached = None;
                    } else if let Some((t, _)) = &mut *cached {
                        *t = Instant::now();
                    }
                    result
                }
                _ => match mode {
                    AccessMode::Metadata => stat_local(&path),
                    AccessMode::Hash => read_local(&path, false),
                    AccessMode::Bytes => read_local(&path, true),
                },
            }
        })
        .await
        .map_err(|e| SourceError::Unavailable(e.to_string()))??;
        if let Some(source) = source {
            self.get(&source.id)?;
        }
        Ok(result)
    }
    pub async fn validate(&self, scene: &SceneDescriptor) -> std::result::Result<(), SourceError> {
        for mesh in &scene.meshes {
            self.read_mesh(scene, mesh, false).await?;
        }
        Ok(())
    }
    pub fn validate_source(&self, scene: &SceneDescriptor) -> std::result::Result<(), SourceError> {
        if let Some(source) = &scene.source {
            self.get(&source.id)?;
        }
        Ok(())
    }
    pub async fn validate_mesh_metadata(
        &self,
        scene: &SceneDescriptor,
        mesh: &MeshRef,
    ) -> std::result::Result<(), SourceError> {
        if mesh.modified_ns.is_none() {
            self.read_mesh(scene, mesh, false).await?;
            return Ok(());
        }
        let result = self.metadata(scene.source.as_ref(), &mesh.path).await?;
        if result.size != mesh.byte_size
            || result.path != mesh.path
            || result.modified_ns != mesh.modified_ns
            || mesh
                .change_ns
                .is_some_and(|changed| result.change_ns != Some(changed))
        {
            return Err(SourceError::Gone);
        }
        Ok(())
    }
    pub async fn read_mesh(
        &self,
        scene: &SceneDescriptor,
        mesh: &MeshRef,
        bytes: bool,
    ) -> std::result::Result<Observed, SourceError> {
        let result = self
            .observe(scene.source.as_ref(), &mesh.path, bytes)
            .await
            .map_err(|error| match error {
                // Registered meshes were within the limit. Exceeding it now is a
                // confirmed content change, including growth during the read.
                SourceError::TooLarge if mesh.byte_size <= MAX_SOURCE_BYTES => SourceError::Gone,
                error => error,
            })?;
        if result.size != mesh.byte_size
            || result.revision != mesh.revision
            || result.path != mesh.path
            || mesh
                .modified_ns
                .is_some_and(|modified| result.modified_ns != Some(modified))
            || mesh
                .change_ns
                .is_some_and(|changed| result.change_ns != Some(changed))
        {
            return Err(SourceError::Gone);
        }
        Ok(result)
    }
}
fn connect(source: &Source, key: &Path) -> std::result::Result<ssh2::Sftp, SourceError> {
    let addresses = (source.host.as_str(), source.port)
        .to_socket_addrs()
        .map_err(SourceError::io)?;
    let mut connected = None;
    for addr in addresses.take(4) {
        if let Ok(socket) = TcpStream::connect_timeout(&addr, Duration::from_secs(3)) {
            connected = Some(socket);
            break;
        }
    }
    let socket =
        connected.ok_or_else(|| SourceError::Unavailable("SSH host unreachable".into()))?;
    socket
        .set_read_timeout(Some(IO_TIMEOUT))
        .map_err(SourceError::io)?;
    socket
        .set_write_timeout(Some(IO_TIMEOUT))
        .map_err(SourceError::io)?;
    let mut session = ssh2::Session::new().map_err(SourceError::ssh)?;
    session.set_tcp_stream(socket);
    session.set_timeout(IO_TIMEOUT.as_millis() as u32);
    let blob = STANDARD
        .decode(&source.host_key)
        .map_err(|e| SourceError::Unavailable(e.to_string()))?;
    if blob.len() < 4 {
        return Err(SourceError::Unavailable("invalid host key".into()));
    }
    let len = u32::from_be_bytes(blob[..4].try_into().unwrap()) as usize;
    let kind = std::str::from_utf8(
        blob.get(4..4 + len)
            .ok_or_else(|| SourceError::Unavailable("invalid host key".into()))?,
    )
    .map_err(|e| SourceError::Unavailable(e.to_string()))?;
    session
        .method_pref(
            ssh2::MethodType::HostKey,
            if kind == "ssh-rsa" {
                "rsa-sha2-512,rsa-sha2-256,ssh-rsa"
            } else {
                kind
            },
        )
        .map_err(SourceError::ssh)?;
    session.handshake().map_err(SourceError::ssh)?;
    let (host_key, _) = session
        .host_key()
        .ok_or_else(|| SourceError::Unavailable("SSH host has no key".into()))?;
    if STANDARD.encode(host_key) != source.host_key {
        return Err(SourceError::Unavailable("SSH host identity changed".into()));
    }
    session
        .userauth_pubkey_file(&source.user, None, key, None)
        .map_err(SourceError::ssh)?;
    session.sftp().map_err(SourceError::ssh)
}
fn read_sftp(
    sftp: &ssh2::Sftp,
    path: &str,
    keep: bool,
    limit: u64,
) -> std::result::Result<Observed, SourceError> {
    let canonical = sftp.realpath(Path::new(path)).map_err(SourceError::ssh)?;
    let mut file = sftp.open(&canonical).map_err(SourceError::ssh)?;
    let stat = file.stat().map_err(SourceError::ssh)?;
    if !stat.is_file() {
        return Err(SourceError::Gone);
    }
    let expected = stat
        .size
        .ok_or_else(|| SourceError::Unavailable("SFTP server omitted file size".into()))?;
    let result = read_stream(
        &mut file,
        canonical.to_string_lossy().into_owned(),
        expected,
        stat.mtime.and_then(seconds_to_nanos),
        None,
        keep,
        limit,
    )?;
    let after = file.stat().map_err(SourceError::ssh)?;
    if stat.size != after.size || stat.mtime != after.mtime {
        return Err(SourceError::Unavailable(
            "file changed while reading; retry".into(),
        ));
    }
    Ok(result)
}
fn stat_sftp(
    sftp: &ssh2::Sftp,
    path: &str,
    limit: u64,
) -> std::result::Result<Observed, SourceError> {
    let canonical = sftp.realpath(Path::new(path)).map_err(SourceError::ssh)?;
    let stat = sftp.stat(&canonical).map_err(SourceError::ssh)?;
    if !stat.is_file() {
        return Err(SourceError::Gone);
    }
    let size = stat
        .size
        .ok_or_else(|| SourceError::Unavailable("SFTP server omitted file size".into()))?;
    if size > limit {
        return Err(SourceError::TooLarge);
    }
    Ok(Observed {
        path: canonical.to_string_lossy().into_owned(),
        size,
        modified_ns: stat.mtime.and_then(seconds_to_nanos),
        change_ns: None,
        revision: String::new(),
        bytes: Vec::new(),
    })
}
fn read_local(path: &str, keep: bool) -> std::result::Result<Observed, SourceError> {
    let canonical = fs::canonicalize(path).map_err(SourceError::io)?;
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        // A file replaced by a FIFO must not block before we can inspect its type.
        options.custom_flags(libc::O_NONBLOCK);
    }
    let mut file = options.open(&canonical).map_err(SourceError::io)?;
    let stat = file.metadata().map_err(SourceError::io)?;
    if !stat.is_file() {
        return Err(SourceError::Gone);
    }
    read_stream(
        &mut file,
        canonical.to_string_lossy().into_owned(),
        stat.len(),
        modified_nanos(&stat),
        change_nanos(&stat),
        keep,
        MAX_SOURCE_BYTES,
    )
}
fn stat_local(path: &str) -> std::result::Result<Observed, SourceError> {
    let canonical = fs::canonicalize(path).map_err(SourceError::io)?;
    let stat = fs::metadata(&canonical).map_err(SourceError::io)?;
    if !stat.is_file() {
        return Err(SourceError::Gone);
    }
    if stat.len() > MAX_SOURCE_BYTES {
        return Err(SourceError::TooLarge);
    }
    Ok(Observed {
        path: canonical.to_string_lossy().into_owned(),
        size: stat.len(),
        modified_ns: modified_nanos(&stat),
        change_ns: change_nanos(&stat),
        revision: String::new(),
        bytes: Vec::new(),
    })
}
fn read_stream(
    r: &mut impl Read,
    path: String,
    size: u64,
    modified_ns: Option<u64>,
    change_ns: Option<u64>,
    keep: bool,
    limit: u64,
) -> std::result::Result<Observed, SourceError> {
    if size > limit {
        return Err(SourceError::TooLarge);
    }
    let start = Instant::now();
    let mut buf = [0; 64 * 1024];
    let mut hash = Sha256::new();
    let mut actual = 0u64;
    let mut bytes = Vec::new();
    loop {
        if start.elapsed() > READ_DEADLINE {
            return Err(SourceError::Unavailable(
                "file read deadline exceeded".into(),
            ));
        }
        let n = r.read(&mut buf).map_err(SourceError::io)?;
        if n == 0 {
            break;
        }
        actual += n as u64;
        if actual > limit {
            return Err(SourceError::TooLarge);
        }
        hash.update(&buf[..n]);
        if keep {
            bytes.extend_from_slice(&buf[..n]);
        }
    }
    if actual != size {
        return Err(SourceError::Unavailable(
            "file size changed while reading".into(),
        ));
    }
    Ok(Observed {
        path,
        size,
        modified_ns,
        change_ns,
        revision: format!("sha256:{}", hex::encode(hash.finalize())),
        bytes,
    })
}
fn seconds_to_nanos(seconds: u64) -> Option<u64> {
    seconds.checked_mul(1_000_000_000)
}
fn modified_nanos(metadata: &fs::Metadata) -> Option<u64> {
    let duration = metadata.modified().ok()?.duration_since(UNIX_EPOCH).ok()?;
    u64::try_from(duration.as_nanos()).ok()
}

#[cfg(unix)]
fn change_nanos(metadata: &fs::Metadata) -> Option<u64> {
    use std::os::unix::fs::MetadataExt;
    let seconds = u64::try_from(metadata.ctime()).ok()?;
    let nanos = u64::try_from(metadata.ctime_nsec()).ok()?;
    seconds.checked_mul(1_000_000_000)?.checked_add(nanos)
}

#[cfg(not(unix))]
fn change_nanos(_metadata: &fs::Metadata) -> Option<u64> {
    None
}
pub fn validate_path(path: &str) -> Result<()> {
    if !Path::new(path).is_absolute() || path.len() > 16_384 || path.contains('\0') {
        bail!("source path must be absolute");
    }
    Ok(())
}
fn validate_address(host: &str, port: u16) -> Result<()> {
    if host.is_empty()
        || host.len() > 253
        || host.chars().any(|c| c.is_whitespace() || c.is_control())
        || port == 0
    {
        bail!("invalid SSH address");
    }
    Ok(())
}
pub fn validate_label(label: &str) -> Result<()> {
    if label.trim().is_empty() || label.len() > 128 || label.chars().any(char::is_control) {
        bail!("name must contain 1–128 bytes without control characters");
    }
    Ok(())
}
pub fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}
pub fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}
pub fn private_dir(path: &Path) -> Result<()> {
    fs::create_dir_all(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}
pub fn private_file(path: &Path) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}
pub fn write_private(path: &Path, bytes: &[u8]) -> Result<()> {
    let parent = path.parent().context("path has no parent")?;
    fs::create_dir_all(parent)?;
    let tmp = parent.join(format!(".blind-{}", random_b64(12)));
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let result = (|| -> Result<()> {
        let mut f = options.open(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        fs::rename(&tmp, path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn users_have_independent_credentials_and_revocation() {
        let dir = tempfile::tempdir().unwrap();
        let sources = Sources::open(dir.path()).unwrap();
        let a = sources
            .local("Carol".into(), "workstation".into(), "carol".into())
            .unwrap();
        let b = sources
            .local("Alice".into(), "workstation".into(), "alice".into())
            .unwrap();
        assert_ne!(a.source.id, b.source.id);
        assert_eq!(
            sources.authenticate(&a.credential, false).unwrap().user,
            "carol"
        );
        assert_eq!(
            sources.authenticate(&b.credential, false).unwrap().user,
            "alice"
        );
        let file = dir.path().join("tetra.ply");
        fs::write(&file, include_bytes!("../tests/fixtures/tetra.ply")).unwrap();
        let mut scene = SceneDescriptor::create(&[file], None).await.unwrap();
        scene.source = Some(a.source.scene_source());
        sources.validate(&scene).await.unwrap();
        sources.revoke(&a.source.id).unwrap();
        assert!(matches!(
            sources.validate(&scene).await,
            Err(SourceError::Gone)
        ));
        assert!(sources.authenticate(&a.credential, false).is_err());
        assert!(sources.authenticate(&b.credential, false).is_ok());
    }
    #[tokio::test]
    async fn local_read_uses_exact_bytes_and_detects_same_size_changes() {
        let dir = tempfile::tempdir().unwrap();
        let sources = Sources::open(dir.path()).unwrap();
        let file = dir.path().join("tetra.ply");
        let original = include_bytes!("../tests/fixtures/tetra.ply");
        fs::write(&file, original).unwrap();
        let scene = SceneDescriptor::create(std::slice::from_ref(&file), None)
            .await
            .unwrap();
        let data = sources
            .read_mesh(&scene, &scene.meshes[0], true)
            .await
            .unwrap();
        assert_eq!(data.bytes, original);
        sources
            .validate_mesh_metadata(&scene, &scene.meshes[0])
            .await
            .unwrap();
        let mut changed = original.to_vec();
        changed[0] = b'x';
        fs::write(&file, changed).unwrap();
        assert!(matches!(
            sources
                .validate_mesh_metadata(&scene, &scene.meshes[0])
                .await,
            Err(SourceError::Gone)
        ));
        assert!(matches!(
            sources.validate(&scene).await,
            Err(SourceError::Gone)
        ));
    }
    #[tokio::test]
    async fn offline_source_is_unavailable_not_gone() {
        let dir = tempfile::tempdir().unwrap();
        let sources = Sources::open(dir.path()).unwrap();
        let registration = sources
            .local("B".into(), "127.0.0.1".into(), "user".into())
            .unwrap();
        let mut remote = registration.source;
        remote.local = false;
        remote.port = 1;
        sources
            .db
            .lock()
            .unwrap()
            .execute(
                "UPDATE sources SET record=?1 WHERE id=?2",
                params![serde_json::to_string(&remote).unwrap(), remote.id],
            )
            .unwrap();
        let e = sources
            .observe(Some(&remote.scene_source()), "/tmp/mesh.ply", false)
            .await
            .err()
            .unwrap();
        assert!(matches!(e, SourceError::Unavailable(_)));
        assert!(sources.get(&remote.id).is_ok());
    }
    #[test]
    fn invitation_is_permanent_reusable_and_pending_credentials_cannot_share() {
        let dir = tempfile::tempdir().unwrap();
        let sources = Sources::open(dir.path()).unwrap();
        let invite = sources.invite("http://server:7400".into()).unwrap();
        let req = || JoinRequest {
            name: "user@B".into(),
            host: "127.0.0.1".into(),
            hostname: "B".into(),
            port: 22,
            user: "user".into(),
            host_key: STANDARD.encode([0u8; 64]),
        };
        let receipt = sources.begin(&invite.token, req()).unwrap();
        let second = sources.begin(&invite.token, req()).unwrap();
        assert!(sources.authenticate(&receipt.credential, false).is_err());
        assert!(sources.authenticate(&receipt.credential, true).is_ok());
        assert!(sources.authenticate(&second.credential, true).is_ok());
        assert!(!receipt.public_key.contains("PRIVATE"));
        let stored = fs::read(dir.path().join("sources.sqlite3")).unwrap();
        assert!(
            !stored
                .windows(receipt.credential.len())
                .any(|w| w == receipt.credential.as_bytes())
        );
    }

    #[test]
    fn invitations_can_be_revoked_and_legacy_temporary_tokens_are_invalidated() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("sources.sqlite3");
        let db = Connection::open(&path).unwrap();
        db.execute_batch(
            "CREATE TABLE invitations (hash TEXT PRIMARY KEY, expires INTEGER NOT NULL);
             INSERT INTO invitations VALUES ('legacy', 4102444800);",
        )
        .unwrap();
        drop(db);

        let sources = Sources::open(dir.path()).unwrap();
        let columns: Vec<String> = sources
            .db
            .lock()
            .unwrap()
            .prepare("PRAGMA table_info(invitations)")
            .unwrap()
            .query_map([], |row| row.get(1))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        assert_eq!(columns, ["hash", "created"]);

        let invitation = sources.invite("http://server:7400".into()).unwrap();
        let request = || JoinRequest {
            name: "user@B".into(),
            host: "127.0.0.1".into(),
            hostname: "B".into(),
            port: 22,
            user: "user".into(),
            host_key: STANDARD.encode([0u8; 64]),
        };
        let pending = sources.begin(&invitation.token, request()).unwrap();
        assert!(sources.key_path(&pending.source.id).is_file());
        assert_eq!(sources.revoke_invitations().unwrap(), 1);
        assert!(sources.begin(&invitation.token, request()).is_err());
        assert!(sources.authenticate(&pending.credential, true).is_err());
        assert!(!sources.key_path(&pending.source.id).exists());
    }
    #[cfg(unix)]
    #[test]
    fn local_fifo_is_rejected_without_waiting_for_a_writer() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("pipe.ply");
        assert!(
            std::process::Command::new("mkfifo")
                .arg(&path)
                .status()
                .unwrap()
                .success()
        );
        assert!(matches!(
            read_local(path.to_str().unwrap(), true),
            Err(SourceError::Gone)
        ));
    }

    #[tokio::test]
    async fn oversized_replacement_is_gone_but_new_share_is_too_large() {
        let dir = tempfile::tempdir().unwrap();
        let sources = Sources::open(dir.path()).unwrap();
        let file = dir.path().join("tetra.ply");
        fs::write(&file, include_bytes!("../tests/fixtures/tetra.ply")).unwrap();
        let scene = SceneDescriptor::create(std::slice::from_ref(&file), None)
            .await
            .unwrap();
        fs::OpenOptions::new()
            .write(true)
            .open(&file)
            .unwrap()
            .set_len(MAX_SOURCE_BYTES + 1)
            .unwrap();
        assert!(matches!(
            sources.validate(&scene).await,
            Err(SourceError::Gone)
        ));
        assert!(matches!(
            sources.observe(None, file.to_str().unwrap(), false).await,
            Err(SourceError::TooLarge)
        ));
    }

    #[tokio::test]
    async fn queued_remote_reads_leave_capacity_for_other_sources() {
        let dir = tempfile::tempdir().unwrap();
        let sources = Arc::new(Sources::open(dir.path()).unwrap());
        let mut remote = sources
            .local("B".into(), "127.0.0.1".into(), "user".into())
            .unwrap()
            .source;
        remote.local = false;
        sources
            .db
            .lock()
            .unwrap()
            .execute(
                "UPDATE sources SET record=?1 WHERE id=?2",
                params![serde_json::to_string(&remote).unwrap(), remote.id],
            )
            .unwrap();
        let pool = Arc::new(tokio::sync::Mutex::new(None));
        sources
            .pool
            .lock()
            .unwrap()
            .insert(remote.id.clone(), pool.clone());
        let _busy = pool.lock().await;
        let mut requests = tokio::task::JoinSet::new();
        for _ in 0..4 {
            let sources = sources.clone();
            let remote = remote.scene_source();
            requests.spawn(async move {
                sources
                    .observe(Some(&remote), "/tmp/queued.ply", false)
                    .await
            });
        }
        for _ in 0..10 {
            tokio::task::yield_now().await;
        }
        let file = dir.path().join("healthy.ply");
        fs::write(&file, b"healthy").unwrap();
        tokio::time::timeout(
            Duration::from_secs(1),
            sources.observe(None, file.to_str().unwrap(), true),
        )
        .await
        .expect("queued requests exhausted global capacity")
        .unwrap();
        requests.abort_all();
    }

    #[test]
    fn bounded_reader_rejects_growth_and_oversize() {
        assert!(matches!(
            read_stream(&mut &b"abc"[..], "x".into(), 3, None, None, true, 2),
            Err(SourceError::TooLarge)
        ));
        assert!(matches!(
            read_stream(&mut &b"abc"[..], "x".into(), 2, None, None, true, 10),
            Err(SourceError::Unavailable(_))
        ));
    }
}
