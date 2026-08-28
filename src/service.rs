use std::{
    fs,
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
    process::Command,
    thread,
    time::{Duration, Instant},
};

use anyhow::{Context, Result, bail};

const LABEL: &str = "dev.blind.viewer";

#[derive(Debug, PartialEq, Eq)]
pub enum Installation {
    None,
    CurrentExecutable,
    OtherExecutable(PathBuf),
}

pub struct PreparedInstall {
    domain: String,
    plist: PathBuf,
    staged: PathBuf,
    previous: Option<Vec<u8>>,
    previous_loaded: bool,
    committed: bool,
}

pub struct CommittedInstall {
    domain: String,
    plist: PathBuf,
    previous: Option<Vec<u8>>,
    previous_loaded: bool,
    finished: bool,
}

pub fn validate_user() -> Result<()> {
    let uid = current_uid()?;
    let _ = home_dir_for(uid)?;
    Ok(())
}

pub fn installation() -> Result<Installation> {
    validate_user()?;
    let plist = plist_path()?;
    if !plist.exists() {
        return Ok(Installation::None);
    }
    let output = Command::new("/usr/bin/plutil")
        .args(["-extract", "ProgramArguments.0", "raw", "-o", "-"])
        .arg(&plist)
        .output()
        .context("could not run plutil")?;
    if !output.status.success() {
        let diagnostic = command_diagnostic(&output);
        bail!("could not read {}: {diagnostic}", plist.display());
    }
    let configured = std::str::from_utf8(&output.stdout)
        .context("Blind service executable path is not UTF-8")?
        .trim();
    if configured.is_empty() {
        bail!("Blind service has no executable path");
    }
    let configured = PathBuf::from(configured);
    let current = std::env::current_exe()
        .context("could not locate the running Blind executable")?
        .canonicalize()
        .context("could not resolve the running Blind executable")?;
    let resolved = configured
        .canonicalize()
        .unwrap_or_else(|_| configured.clone());
    if resolved == current {
        Ok(Installation::CurrentExecutable)
    } else {
        Ok(Installation::OtherExecutable(configured))
    }
}

pub fn is_loaded() -> Result<bool> {
    let domain = user_domain()?;
    let domain_output = Command::new("/bin/launchctl")
        .args(["print", domain.as_str()])
        .output()
        .context("could not run launchctl")?;
    if !domain_output.status.success() {
        return Ok(false);
    }
    launchctl_is_loaded(&format!("{domain}/{LABEL}"))
}

pub fn unload() -> Result<()> {
    let domain = user_domain()?;
    ensure_domain(&domain)?;
    let target = format!("{domain}/{LABEL}");
    bootout_if_loaded(&target).context("could not stop the existing Blind service")
}

pub fn load_existing() -> Result<()> {
    let domain = user_domain()?;
    ensure_domain(&domain)?;
    let plist = plist_path()?;
    if !plist.exists() {
        bail!("Blind service is not installed at {}", plist.display());
    }
    bootstrap_plist(&domain, &plist).context("could not start the Blind service")
}

pub fn restart() -> Result<()> {
    let domain = user_domain()?;
    ensure_domain(&domain)?;
    let target = format!("{domain}/{LABEL}");
    if !launchctl_is_loaded(&target)? {
        bail!("Blind background service is not loaded");
    }
    run_launchctl(["kickstart", "-k", target.as_str()])
        .context("could not restart the Blind service")
}

pub fn prepare_install() -> Result<PreparedInstall> {
    let domain = user_domain()?;
    ensure_domain(&domain)?;
    let previous_loaded = launchctl_is_loaded(&format!("{domain}/{LABEL}"))?;
    let executable = std::env::current_exe()?.canonicalize()?;
    let home = home_dir_for(current_uid()?)?;
    let agents = home.join("Library/LaunchAgents");
    let logs = home.join("Library/Logs");
    fs::create_dir_all(&agents)?;
    fs::create_dir_all(&logs)?;
    let plist = agents.join(format!("{LABEL}.plist"));
    let previous = match fs::read(&plist) {
        Ok(previous) => Some(previous),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(error).context("could not read the existing Blind service"),
    };
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
    if let Err(error) = lint_plist(&staged) {
        let _ = fs::remove_file(&staged);
        return Err(error);
    }
    Ok(PreparedInstall {
        domain,
        plist,
        staged,
        previous,
        previous_loaded,
        committed: false,
    })
}

impl PreparedInstall {
    pub fn commit(mut self) -> Result<CommittedInstall> {
        if let Err(error) = fs::rename(&self.staged, &self.plist) {
            if self.previous_loaded
                && let Err(restore_error) = bootstrap_plist(&self.domain, &self.plist)
            {
                bail!(
                    "could not install the Blind service: {error}; restoring the previous service also failed: {restore_error:#}"
                );
            }
            return Err(error).context("could not install the Blind service");
        }
        if let Err(start_error) = bootstrap_plist(&self.domain, &self.plist) {
            let restore_error = self.restore_previous().err();
            if let Some(restore_error) = restore_error {
                bail!(
                    "launchctl could not start Blind: {start_error:#}; restoring the previous service also failed: {restore_error:#}"
                );
            }
            bail!("launchctl could not start Blind: {start_error:#}");
        }
        self.committed = true;
        Ok(CommittedInstall {
            domain: self.domain.clone(),
            plist: self.plist.clone(),
            previous: self.previous.take(),
            previous_loaded: self.previous_loaded,
            finished: false,
        })
    }

    fn restore_previous(&mut self) -> Result<()> {
        let target = format!("{}/{LABEL}", self.domain);
        bootout_if_loaded(&target)?;
        match &self.previous {
            Some(previous) => {
                fs::write(&self.plist, previous)?;
                if self.previous_loaded {
                    bootstrap_plist(&self.domain, &self.plist)?;
                }
            }
            None => match fs::remove_file(&self.plist) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            },
        }
        Ok(())
    }
}

impl CommittedInstall {
    pub fn rollback(mut self) -> Result<()> {
        self.restore_previous()?;
        self.finished = true;
        Ok(())
    }

    pub fn finish(mut self) -> PathBuf {
        self.finished = true;
        self.plist.clone()
    }

    fn restore_previous(&mut self) -> Result<()> {
        let target = format!("{}/{LABEL}", self.domain);
        bootout_if_loaded(&target)?;
        match &self.previous {
            Some(previous) => {
                fs::write(&self.plist, previous)?;
                if self.previous_loaded {
                    bootstrap_plist(&self.domain, &self.plist)?;
                }
            }
            None => match fs::remove_file(&self.plist) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            },
        }
        Ok(())
    }
}

impl Drop for CommittedInstall {
    fn drop(&mut self) {
        if !self.finished {
            let _ = self.restore_previous();
        }
    }
}

impl Drop for PreparedInstall {
    fn drop(&mut self) {
        if !self.committed {
            let _ = fs::remove_file(&self.staged);
        }
    }
}

pub fn uninstall() -> Result<PathBuf> {
    validate_user()?;
    let plist = plist_path()?;
    let unload_error = unload().err();
    let remove_error = if plist.exists() {
        fs::remove_file(&plist).err()
    } else {
        None
    };
    match (unload_error, remove_error) {
        (Some(unload_error), Some(remove_error)) => bail!(
            "could not stop the Blind service: {unload_error:#}; could not remove {}: {remove_error}",
            plist.display()
        ),
        (Some(unload_error), None) => bail!(
            "Removed {} so Blind will not start at login, but could not stop the current service: {unload_error:#}",
            plist.display()
        ),
        (None, Some(remove_error)) => {
            bail!("could not remove {}: {remove_error}", plist.display())
        }
        (None, None) => {}
    }
    Ok(plist)
}

pub fn is_installed() -> Result<bool> {
    validate_user()?;
    Ok(plist_path()?.exists())
}

fn plist_path() -> Result<PathBuf> {
    Ok(home_dir_for(current_uid()?)?.join(format!("Library/LaunchAgents/{LABEL}.plist")))
}

fn current_uid() -> Result<libc::uid_t> {
    let uid = unsafe { libc::getuid() };
    require_non_root(uid)?;
    Ok(uid)
}

fn require_non_root(uid: libc::uid_t) -> Result<()> {
    if uid == 0 {
        bail!(
            "Blind installs a per-user service and must not run as root; run `blind service install` without sudo"
        );
    }
    Ok(())
}

fn user_domain() -> Result<String> {
    user_domain_for(current_uid()?)
}

fn user_domain_for(uid: libc::uid_t) -> Result<String> {
    require_non_root(uid)?;
    Ok(format!("gui/{uid}"))
}

fn home_dir_for(uid: libc::uid_t) -> Result<PathBuf> {
    let home = PathBuf::from(std::env::var_os("HOME").context("HOME is not set")?);
    let owner = fs::metadata(&home)
        .with_context(|| format!("could not inspect HOME {}", home.display()))?
        .uid();
    if owner != uid {
        bail!(
            "HOME {} belongs to user {owner}, but Blind is running as user {uid}",
            home.display()
        );
    }
    Ok(home)
}

fn ensure_domain(domain: &str) -> Result<()> {
    run_launchctl(["print", domain]).with_context(|| {
        format!(
            "Blind requires an active macOS GUI login session for user {}",
            domain.trim_start_matches("gui/")
        )
    })
}

fn launchctl_is_loaded(target: &str) -> Result<bool> {
    let output = Command::new("/bin/launchctl")
        .args(["print", target])
        .output()
        .context("could not run launchctl")?;
    if output.status.success() {
        return Ok(true);
    }
    if output.status.code() == Some(113) {
        return Ok(false);
    }
    let diagnostic = command_diagnostic(&output);
    bail!("could not inspect the existing Blind service: {diagnostic}");
}

fn bootout_if_loaded(target: &str) -> Result<()> {
    if !launchctl_is_loaded(target)? {
        return Ok(());
    }
    let result = run_launchctl(["bootout", target]);
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if !launchctl_is_loaded(target)? {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return match result {
                Ok(()) => bail!("Blind service remained loaded after bootout"),
                Err(error) => Err(error).context("Blind service remained loaded after bootout"),
            };
        }
        thread::sleep(Duration::from_millis(100));
    }
}

fn bootstrap_plist(domain: &str, plist: &Path) -> Result<()> {
    let target = format!("{domain}/{LABEL}");
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let result = run_launchctl(["bootstrap", domain, plist.to_string_lossy().as_ref()]);
        if result.is_ok() || launchctl_is_loaded(&target).unwrap_or(false) {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return result.context("launchd did not accept the Blind service within 5 seconds");
        }
        thread::sleep(Duration::from_millis(100));
    }
}

fn run_launchctl<const N: usize>(args: [&str; N]) -> Result<()> {
    let output = Command::new("/bin/launchctl")
        .args(args)
        .output()
        .context("could not run launchctl")?;
    if !output.status.success() {
        let diagnostic = command_diagnostic(&output);
        bail!("launchctl failed: {diagnostic}");
    }
    Ok(())
}

fn lint_plist(plist: &Path) -> Result<()> {
    let output = Command::new("/usr/bin/plutil")
        .args(["-lint", plist.to_string_lossy().as_ref()])
        .output()
        .context("could not run plutil")?;
    if !output.status.success() {
        let diagnostic = command_diagnostic(&output);
        bail!("generated launchd configuration is invalid: {diagnostic}");
    }
    Ok(())
}

fn command_diagnostic(output: &std::process::Output) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr);
    let stdout = String::from_utf8_lossy(&output.stdout);
    let message = stderr.trim();
    let message = if message.is_empty() {
        stdout.trim()
    } else {
        message
    };
    if message.is_empty() {
        output.status.to_string()
    } else {
        message.to_owned()
    }
}

fn xml_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn root_cannot_target_a_per_user_gui_domain() {
        let error = user_domain_for(0).unwrap_err().to_string();
        assert!(error.contains("without sudo"));
    }

    #[test]
    fn non_root_user_targets_its_gui_domain() {
        assert_eq!(user_domain_for(501).unwrap(), "gui/501");
    }

    #[test]
    fn escapes_values_inserted_into_plist_xml() {
        assert_eq!(xml_escape("a&<b>\""), "a&amp;&lt;b&gt;&quot;");
    }
}
