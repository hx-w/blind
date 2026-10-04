//! Combine local process state and remote registration state for the status command.
use crate::{
    client::{ApiError, api, load},
    runtime::config::{Config, config_path},
};
use anyhow::Result;
use serde_json::json;
use std::fs;

pub(super) async fn run(as_json: bool) -> Result<()> {
    let path = config_path()?;
    let mut local = json!({"state":"unconfigured"});
    let mut local_target = None;
    if path.exists() {
        match fs::read(&path)
            .map_err(anyhow::Error::from)
            .and_then(|b| Ok(serde_json::from_slice::<Config>(&b)?))
        {
            Ok(config) => {
                let probe = tokio::time::timeout(
                    std::time::Duration::from_secs(5),
                    crate::client::control::probe(&config),
                )
                .await;
                local = match probe {
                    Ok(Ok(Some(health))) => {
                        local_target = Some(format!(
                            "http://{}{}",
                            crate::runtime::config::control_address(&config)?,
                            config.base_path().unwrap_or_default()
                        ));
                        json!({"state":"running","pid":health.pid,"version":health.version})
                    }
                    Ok(Ok(None)) => json!({"state":"stopped"}),
                    _ => json!({"state":"probe_failed"}),
                };
            }
            Err(_) => local = json!({"state":"invalid_config"}),
        }
    }
    let mut connection = json!({"state":"not_connected"});
    let mut target = local_target
        .clone()
        .map(|server| json!({"kind":"local","server":server}));
    let plugins = crate::plugin::list(&crate::plugin::root()?)?["plugins"].clone();
    let mut remote_catalog = json!({"state":"not_connected"});
    match load() {
        Ok(Some(c)) => {
            target =
                Some(json!({"kind":if c.source.local{"local"}else{"remote"},"server":c.server}));
            let result = tokio::time::timeout(
                std::time::Duration::from_secs(5),
                api(&c.server, "/api/v1/client", &c.credential, None),
            )
            .await;
            let state = match result {
                Ok(Ok(ref v)) if v["active"] == true => "connected",
                Ok(Ok(_)) => "pending",
                Ok(Err(ref e))
                    if e.downcast_ref::<ApiError>()
                        .is_some_and(|e| e.status == reqwest::StatusCode::UNAUTHORIZED) =>
                {
                    if c.source.active {
                        "credential_invalid"
                    } else {
                        "pending"
                    }
                }
                _ => "unreachable",
            };
            connection = json!({"state":state,"server":c.server,"source_id":c.source.id,"name":c.source.name});
            if state == "connected" {
                remote_catalog = match tokio::time::timeout(
                    std::time::Duration::from_secs(5),
                    api(&c.server, "/api/v1/client/plugins", &c.credential, None),
                )
                .await
                {
                    Ok(Ok(v)) => v["plugins"].clone(),
                    _ => json!({"state":"unavailable"}),
                };
            }
        }
        Ok(None) => {}
        Err(_) => connection = json!({"state":"invalid_config"}),
    }
    let report = json!({"schema_version":1,"local_server":local,"connection":connection,"target":target,"plugins":plugins,"remote_catalog":remote_catalog});
    if as_json {
        println!("{}", serde_json::to_string_pretty(&report)?);
    } else {
        println!(
            "Local Server: {}",
            report["local_server"]["state"].as_str().unwrap()
        );
        println!(
            "Client: {}",
            report["connection"]["state"].as_str().unwrap()
        );
        if let Some(target) = report["target"].as_object() {
            println!(
                "Target: {} ({})",
                target["server"].as_str().unwrap(),
                target["kind"].as_str().unwrap()
            );
        } else {
            println!("Target: none");
        }
        if let Some(plugins) = report["plugins"].as_array() {
            for p in plugins {
                println!(
                    "Local plugin: {} {} ({})",
                    p["id"].as_str().unwrap_or("?"),
                    p["version"].as_str().unwrap_or(""),
                    p["state"].as_str().unwrap_or("unknown")
                );
            }
        }
        if let Some(plugins) = report["remote_catalog"].as_array() {
            for p in plugins {
                println!(
                    "Remote catalog: {} {}",
                    p["id"].as_str().unwrap_or("?"),
                    p["version"].as_str().unwrap_or("")
                );
            }
        } else {
            println!(
                "Remote catalog: {}",
                report["remote_catalog"]["state"]
                    .as_str()
                    .unwrap_or("unavailable")
            );
        }
    }
    Ok(())
}
