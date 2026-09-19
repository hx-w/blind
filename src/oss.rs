//! Named stores using S3 or signed download URLs. Credentials stay in the Server's private config.
use std::{
    collections::BTreeMap,
    fs,
    io::{self, IsTerminal, Write},
    path::Path,
    time::Duration,
};

use anyhow::{Context, Result, bail};
use base64::{Engine, engine::general_purpose::URL_SAFE};
use clap::{Subcommand, ValueEnum};
use futures_util::StreamExt;
use hmac::{Hmac, Mac};
use object_store::{ClientOptions, ObjectStore, RetryConfig, aws::AmazonS3Builder};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::source::{MAX_SOURCE_BYTES, Observed, SourceError, write_private};

#[derive(Subcommand)]
pub enum Command {
    /// Configure a Server-side alias. Prompts for endpoint, region, Access Key, Secret Key.
    #[command(
        long_about = "Create or replace an OSS alias on this Server. Enter endpoint, region, Access Key and Secret Key in that order; the secret is hidden in a terminal. For automation, pipe four lines on stdin, or three with --signing hmac-sha1-url --bucket BUCKET (no region). Credentials are never command-line arguments. Changes take effect on the next read."
    )]
    Set {
        alias: String,
        /// Request signing protocol. URL signing prompts for endpoint, Access Key, Secret Key.
        #[arg(long, value_enum, default_value = "s3-v4")]
        signing: Signing,
        /// Bucket bound to the download domain (required for URL signing).
        #[arg(
            long,
            value_name = "BUCKET",
            required_if_eq("signing", "hmac-sha1-url")
        )]
        bucket: Option<String>,
    },
    /// List the connected Server's aliases (or local aliases when not a remote Client).
    List,
    /// Remove an alias, invalidating shares that use it.
    Remove { alias: String },
}

#[derive(Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, ValueEnum)]
#[serde(rename_all = "kebab-case")]
pub enum Signing {
    #[default]
    #[serde(rename = "s3-v4")]
    #[value(name = "s3-v4")]
    S3V4,
    HmacSha1Url,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Store {
    endpoint: String,
    #[serde(default)]
    signing: Signing,
    region: String,
    access_key: String,
    secret_key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    bucket: Option<String>,
}

#[derive(Serialize, Deserialize)]
pub struct StoreInfo {
    pub alias: String,
    pub endpoint: String,
    pub region: String,
    #[serde(default)]
    pub signing: Signing,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bucket: Option<String>,
}

pub fn list(dir: &Path) -> Result<Vec<StoreInfo>> {
    load(dir)?
        .into_iter()
        .map(|(alias, store)| {
            store.validate()?;
            Ok(StoreInfo {
                alias,
                endpoint: store.endpoint,
                region: store.region,
                signing: store.signing,
                bucket: store.bucket,
            })
        })
        .collect()
}

pub fn print_list(stores: &[StoreInfo], can_share: bool) {
    for store in stores {
        let mode = store
            .bucket
            .as_ref()
            .map(|bucket| format!("bucket:{bucket}"))
            .unwrap_or_else(|| store.region.clone());
        let signing = match store.signing {
            Signing::S3V4 => "s3-v4",
            Signing::HmacSha1Url => "hmac-sha1-url",
        };
        println!("{}\t{}\t{}\t{}", store.alias, store.endpoint, signing, mode);
    }
    eprintln!(
        "Create OSS shares: {}",
        if can_share {
            "allowed"
        } else {
            "not enabled for this Client on this Server"
        }
    );
}

fn valid_alias(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 64
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

pub fn is_oss(path: &str) -> bool {
    path.starts_with("oss:")
}

pub struct Location {
    pub alias: String,
    pub bucket: String,
    pub key: object_store::path::Path,
}

impl Location {
    pub fn parse(value: &str) -> Result<Self> {
        let rest = value
            .strip_prefix("oss://")
            .context("expected oss://ALIAS/BUCKET/KEY")?;
        let mut parts = rest.splitn(3, '/');
        let alias = parts.next().unwrap_or_default();
        let bucket = parts.next().unwrap_or_default();
        let key = parts.next().unwrap_or_default();
        if !valid_alias(alias)
            || bucket.is_empty()
            || !bucket
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'.')
            || bucket == "."
            || bucket == ".."
            || key.is_empty()
            || key.starts_with('/')
            || key.ends_with('/')
            || key.to_ascii_lowercase().starts_with("%2f")
            || key.to_ascii_lowercase().ends_with("%2f")
            || value.contains(['?', '#'])
        {
            bail!(
                "expected oss://ALIAS/BUCKET/KEY without query or fragment; percent-encode reserved key characters"
            );
        }
        let key = object_store::path::Path::from_url_path(key).context("invalid OSS object key")?;
        if key.as_ref().is_empty() {
            bail!("OSS object key is empty");
        }
        Ok(Self {
            alias: alias.into(),
            bucket: bucket.into(),
            key,
        })
    }
}

impl Store {
    fn validate(&self) -> Result<()> {
        let url = url::Url::parse(&self.endpoint).context("invalid OSS endpoint")?;
        let loopback = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
        if !(url.scheme() == "https" || (url.scheme() == "http" && loopback))
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
            || url.path() != "/"
        {
            bail!(
                "OSS endpoint must be an HTTPS origin without credentials (HTTP allowed only on loopback)"
            );
        }
        if (self.signing == Signing::S3V4 && self.region.trim().is_empty())
            || self.access_key.trim().is_empty()
            || self.secret_key.trim().is_empty()
        {
            bail!("region, Access Key and Secret Key are required");
        }
        if self.signing == Signing::HmacSha1Url && self.bucket.is_none() {
            bail!("URL signing requires a bucket bound to the download domain");
        }
        if let Some(bucket) = &self.bucket {
            Location::parse(&format!("oss://check/{bucket}/check")).context("invalid bucket")?;
            if bucket.contains('/') {
                bail!("invalid bucket");
            }
        }
        Ok(())
    }

    fn signed_download_url(&self, location: &Location, deadline: i64) -> Result<url::Url> {
        if self.bucket.as_deref() != Some(&location.bucket) {
            bail!("domain is configured for a different bucket");
        }
        let mut url = url::Url::parse(&self.endpoint)?;
        url.path_segments_mut()
            .map_err(|_| anyhow::anyhow!("invalid CDN origin"))?
            .clear()
            .extend(location.key.as_ref().split('/'));
        url.query_pairs_mut()
            .append_pair("e", &deadline.to_string());
        let mut mac = Hmac::<sha1::Sha1>::new_from_slice(self.secret_key.as_bytes())?;
        mac.update(url.as_str().as_bytes());
        let token = format!(
            "{}:{}",
            self.access_key,
            URL_SAFE.encode(mac.finalize().into_bytes())
        );
        url.query_pairs_mut().append_pair("token", &token);
        Ok(url)
    }
}

fn load(dir: &Path) -> Result<BTreeMap<String, Store>> {
    match fs::read(dir.join("oss.json")) {
        Ok(bytes) => serde_json::from_slice(&bytes).context("invalid oss.json"),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(BTreeMap::new()),
        Err(e) => Err(e).context("cannot read oss.json"),
    }
}

fn prompt(label: &str, secret: bool) -> Result<String> {
    if secret && io::stdin().is_terminal() {
        return rpassword::prompt_password(format!("{label}: ")).context("cannot read secret");
    }
    eprint!("{label}: ");
    io::stderr().flush()?;
    let mut line = String::new();
    if io::stdin().read_line(&mut line)? == 0 {
        bail!("missing {label} on stdin");
    }
    Ok(line.trim_end_matches(['\r', '\n']).to_owned())
}

pub fn run(command: Command) -> Result<()> {
    let config = crate::config::config_path()?;
    let dir = config.parent().context("missing config directory")?;
    let (alias, replacement) = match command {
        Command::List => {
            print_list(&list(dir)?, true);
            return Ok(());
        }
        Command::Set {
            alias,
            signing,
            bucket,
        } => {
            if !valid_alias(&alias) {
                bail!("alias must contain 1-64 letters, digits, '-' or '_'");
            }
            let store = Store {
                endpoint: prompt("Endpoint", false)?.trim_end_matches('/').into(),
                signing,
                region: if signing == Signing::S3V4 {
                    prompt("Region", false)?
                } else {
                    String::new()
                },
                access_key: prompt("Access Key", true)?,
                secret_key: prompt("Secret Key", true)?,
                bucket,
            };
            store.validate()?;
            (alias, Some(store))
        }
        Command::Remove { alias } => (alias, None),
    };
    // Do not hold a snapshot or lock while waiting for interactive input.
    let _lock = config_lock(dir)?;
    let mut stores = load(dir)?;
    if let Some(store) = replacement {
        stores.insert(alias, store);
    } else if stores.remove(&alias).is_none() {
        bail!("OSS alias not found");
    }
    write_private(&dir.join("oss.json"), &serde_json::to_vec_pretty(&stores)?)?;
    eprintln!("OSS configuration saved; no Server restart required.");
    Ok(())
}

fn config_lock(dir: &Path) -> Result<fs::File> {
    fs::create_dir_all(dir)?;
    let mut options = fs::OpenOptions::new();
    options.create(true).read(true).write(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::{fs::OpenOptionsExt, io::AsRawFd};
        options.mode(0o600);
        let file = options.open(dir.join("oss.lock"))?;
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX) } != 0 {
            return Err(io::Error::last_os_error()).context("cannot lock OSS configuration");
        }
        Ok(file)
    }
    #[cfg(not(unix))]
    bail!("OSS configuration currently requires Unix file locking")
}

fn unavailable(message: &str) -> SourceError {
    SourceError::Unavailable(message.into())
}

fn storage_error(error: object_store::Error) -> SourceError {
    match error {
        object_store::Error::NotFound { .. } => SourceError::Gone,
        // SDK errors can contain response bodies, URLs and credentials. Never forward them.
        _ => unavailable(
            "OSS read failed; check the alias credentials, endpoint and bucket permissions",
        ),
    }
}

#[derive(Debug)]
struct Connector(reqwest::Client);

impl object_store::client::HttpConnector for Connector {
    fn connect(&self, _: &ClientOptions) -> object_store::Result<object_store::client::HttpClient> {
        Ok(object_store::client::HttpClient::new(self.0.clone()))
    }
}

pub async fn read(
    dir: &Path,
    path: &str,
    keep: bool,
) -> std::result::Result<Observed, SourceError> {
    let location =
        Location::parse(path).map_err(|_| unavailable("invalid OSS resource address"))?;
    let stores = load(dir).map_err(|_| unavailable("cannot load OSS configuration"))?;
    let store = stores.get(&location.alias).ok_or(SourceError::Gone)?;
    store
        .validate()
        .map_err(|_| unavailable("invalid OSS configuration"))?;
    let http = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .https_only(!store.endpoint.starts_with("http://"))
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(120))
        .no_gzip()
        .no_brotli()
        .no_zstd()
        .no_deflate()
        .build()
        .map_err(|_| unavailable("cannot initialize OSS HTTP client"))?;
    if store
        .bucket
        .as_ref()
        .is_some_and(|bucket| bucket != &location.bucket)
    {
        return Err(unavailable(
            "OSS alias is configured for a different bucket",
        ));
    }
    let download = async {
        let (size, mut stream): (
            Option<u64>,
            futures_util::stream::BoxStream<'_, std::result::Result<bytes::Bytes, SourceError>>,
        ) = if store.signing == Signing::HmacSha1Url {
            let url = store
                .signed_download_url(&location, crate::source::now() + 300)
                .map_err(|_| unavailable("invalid CDN configuration or bucket"))?;
            let response = http
                .get(url)
                .send()
                .await
                .map_err(|_| unavailable("CDN request failed"))?;
            if response.status() == reqwest::StatusCode::NOT_FOUND {
                return Err(SourceError::Gone);
            }
            if response.status() != reqwest::StatusCode::OK {
                return Err(unavailable(
                    "CDN read failed; check credentials and domain permissions",
                ));
            }
            (
                response.content_length(),
                response
                    .bytes_stream()
                    .map(|chunk| chunk.map_err(|_| unavailable("CDN response failed")))
                    .boxed(),
            )
        } else {
            let client = AmazonS3Builder::new()
                .with_endpoint(&store.endpoint)
                .with_region(&store.region)
                .with_bucket_name(&location.bucket)
                .with_access_key_id(&store.access_key)
                .with_secret_access_key(&store.secret_key)
                .with_virtual_hosted_style_request(false)
                .with_http_connector(Connector(http))
                .with_retry(RetryConfig {
                    max_retries: 0,
                    ..Default::default()
                })
                .build()
                .map_err(|_| unavailable("cannot initialize OSS reader"))?;
            let response = client.get(&location.key).await.map_err(storage_error)?;
            (
                Some(response.meta.size),
                response
                    .into_stream()
                    .map(|chunk| chunk.map_err(storage_error))
                    .boxed(),
            )
        };
        if size.is_some_and(|size| size > MAX_SOURCE_BYTES) {
            return Err(SourceError::TooLarge);
        }
        let mut hash = Sha256::new();
        let mut bytes = Vec::new();
        let mut actual = 0u64;
        while let Some(chunk) = stream.next().await {
            let chunk = chunk?;
            actual += chunk.len() as u64;
            if actual > MAX_SOURCE_BYTES {
                return Err(SourceError::TooLarge);
            }
            hash.update(&chunk);
            if keep {
                bytes.extend_from_slice(&chunk);
            }
        }
        if size.is_some_and(|size| actual != size) {
            return Err(unavailable("OSS response length changed during read"));
        }
        Ok(Observed {
            path: path.into(),
            size: actual,
            modified_ns: None,
            change_ns: None,
            revision: format!("sha256:{}", hex::encode(hash.finalize())),
            bytes,
        })
    };
    tokio::time::timeout(Duration::from_secs(120), download)
        .await
        .map_err(|_| unavailable("OSS read timed out"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn locations_select_explicit_aliases_and_preserve_keys() {
        let p = Location::parse("oss://prod/my-bucket/a/%E7%89%99%20%2B%25.ply").unwrap();
        assert_eq!(p.alias, "prod");
        assert_eq!(p.bucket, "my-bucket");
        assert_eq!(p.key.as_ref(), "a/牙 +%.ply");
        for p in [
            "oss:/prod/b/k",
            "oss://prod/b/",
            "oss://a:b/b/k",
            "oss://prod/../k",
            "oss://prod/b/../k",
            "oss://prod/b/k?token=x",
            "oss://prod/b/k#x",
            "oss://prod/b//k",
            "oss://prod/b/k/",
            "oss://prod/b/%2Fk",
            "oss://prod/b/k%2F",
        ] {
            assert!(Location::parse(p).is_err(), "{p}");
        }
    }

    #[test]
    fn endpoints_cannot_embed_credentials_or_send_them_over_plain_http() {
        for endpoint in [
            "http://example.com",
            "https://user:secret@example.com",
            "https://example.com?token=secret",
            "https://example.com/path",
        ] {
            let s = Store {
                endpoint: endpoint.into(),
                region: "r".into(),
                access_key: "a".into(),
                secret_key: "s".into(),
                bucket: None,
                signing: Signing::S3V4,
            };
            assert!(s.validate().is_err());
        }
    }
}
