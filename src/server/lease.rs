use crate::runtime::config::config_path;
use anyhow::Context;
use std::fs;
#[cfg(not(target_os = "linux"))]
use std::{path::PathBuf, process::Command};

pub struct ServerLease {
    #[cfg(not(target_os = "linux"))]
    path: PathBuf,
    #[cfg(not(target_os = "linux"))]
    pid: u32,
    #[cfg(target_os = "linux")]
    _file: fs::File,
}

pub fn acquire_offline_maintenance_lease() -> anyhow::Result<ServerLease> {
    ServerLease::acquire().context(
        "a Blind server is still running; restore its configured listen address before offline maintenance",
    )
}

impl ServerLease {
    pub(super) fn acquire() -> anyhow::Result<Self> {
        let path = config_path()?
            .parent()
            .context("config path has no parent")?
            .join("server.lock");
        let pid = std::process::id();
        #[cfg(target_os = "linux")]
        {
            use std::io::Write;
            use std::os::fd::AsRawFd;
            let mut file = fs::OpenOptions::new()
                .read(true)
                .write(true)
                .create(true)
                .truncate(false)
                .open(&path)?;
            // Keep the inode in place so all competing processes lock the same file.
            if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
                anyhow::bail!("another Blind server or offline maintenance operation is active");
            }
            file.set_len(0)?;
            writeln!(file, "{pid}")?;
            Ok(Self { _file: file })
        }
        #[cfg(not(target_os = "linux"))]
        {
            let output = Command::new("/usr/bin/shlock")
                .args(["-f"])
                .arg(&path)
                .args(["-p", &pid.to_string()])
                .output()
                .context("could not run the macOS server lock helper")?;
            if !output.status.success() {
                anyhow::bail!("another Blind server or offline maintenance operation is active");
            }
            Ok(Self { path, pid })
        }
    }
}

#[cfg(not(target_os = "linux"))]
impl Drop for ServerLease {
    fn drop(&mut self) {
        let owned = fs::read_to_string(&self.path)
            .ok()
            .and_then(|value| value.trim().parse::<u32>().ok())
            == Some(self.pid);
        if owned {
            let _ = fs::remove_file(&self.path);
        }
    }
}
