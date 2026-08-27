use std::{fs, path::PathBuf, process::Command};

use anyhow::{Context, Result, bail};

const LABEL: &str = "dev.blind.viewer";

pub fn install() -> Result<PathBuf> {
    let _ = crate::process::stop()?;
    let executable = std::env::current_exe()?.canonicalize()?;
    let home = std::env::var_os("HOME").context("HOME is not set")?;
    let agents = PathBuf::from(&home).join("Library/LaunchAgents");
    let logs = PathBuf::from(home).join("Library/Logs");
    fs::create_dir_all(&agents)?;
    fs::create_dir_all(&logs)?;
    let plist = agents.join(format!("{LABEL}.plist"));
    let previous = fs::read(&plist).ok();
    let staged = agents.join(format!(".{LABEL}.plist.{}", std::process::id()));
    let content = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>{LABEL}</string>
  <key>ProgramArguments</key><array><string>{}</string><string>serve</string></array>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>{}/blind.log</string>
  <key>StandardErrorPath</key><string>{}/blind.error.log</string>
</dict></plist>"#,
        xml_escape(&executable.to_string_lossy()),
        xml_escape(&logs.to_string_lossy()),
        xml_escape(&logs.to_string_lossy())
    );
    fs::write(&staged, content)?;
    let lint = Command::new("plutil")
        .args(["-lint", staged.to_string_lossy().as_ref()])
        .status()?;
    if !lint.success() {
        let _ = fs::remove_file(&staged);
        bail!("generated launchd configuration is invalid");
    }
    fs::rename(&staged, &plist)?;
    let domain = format!("gui/{}", unsafe { libc::getuid() });
    let _ = Command::new("launchctl")
        .args(["bootout", &domain, plist.to_string_lossy().as_ref()])
        .status();
    let status = Command::new("launchctl")
        .args(["bootstrap", &domain, plist.to_string_lossy().as_ref()])
        .status()?;
    if !status.success() {
        match previous {
            Some(previous) => {
                fs::write(&plist, previous)?;
                let _ = Command::new("launchctl")
                    .args(["bootstrap", &domain, plist.to_string_lossy().as_ref()])
                    .status();
            }
            None => {
                let _ = fs::remove_file(&plist);
            }
        }
        bail!("launchctl could not start Blind");
    }
    Ok(plist)
}

pub fn uninstall() -> Result<PathBuf> {
    let plist = plist_path()?;
    if plist.exists() {
        let domain = format!("gui/{}", unsafe { libc::getuid() });
        let _ = Command::new("launchctl")
            .args(["bootout", &domain, plist.to_string_lossy().as_ref()])
            .status();
        fs::remove_file(&plist)?;
    }
    Ok(plist)
}

pub fn is_installed() -> Result<bool> {
    Ok(plist_path()?.exists())
}

fn plist_path() -> Result<PathBuf> {
    let home = std::env::var_os("HOME").context("HOME is not set")?;
    Ok(PathBuf::from(home).join(format!("Library/LaunchAgents/{LABEL}.plist")))
}

fn xml_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}
