//! OSS command parsing, prompting, and terminal formatting.
use crate::storage::oss::{Signing, Store, StoreInfo, list, save_store, valid_alias};
use anyhow::{Context, Result, bail};
use clap::{Subcommand, ValueEnum};
use std::io::{self, IsTerminal, Write};

#[derive(Clone, Copy, ValueEnum)]
pub enum CliSigning {
    #[value(name = "s3-v4")]
    S3V4,
    HmacSha1Url,
}

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
        signing: CliSigning,
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
    let config = crate::runtime::config::config_path()?;
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
            let signing = match signing {
                CliSigning::S3V4 => Signing::S3V4,
                CliSigning::HmacSha1Url => Signing::HmacSha1Url,
            };
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
    save_store(dir, alias, replacement)?;
    eprintln!("OSS configuration saved; no Server restart required.");
    Ok(())
}
