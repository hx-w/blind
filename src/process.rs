use std::{
    fs,
    io::Write,
    path::PathBuf,
    process::Command,
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

use crate::config::config_path;

#[derive(Debug)]
pub enum Acquire {
    AlreadyRunning(u32),
    Acquired(ServerGuard),
}

#[derive(Debug)]
pub struct ServerGuard {
    path: PathBuf,
    pid: u32,
}

#[derive(Debug, Serialize, Deserialize)]
struct PidRecord {
    pid: u32,
    executable: String,
    started_at: u64,
}

pub fn acquire() -> Result<Acquire> {
    let path = pid_path()?;
    if let Some(record) = read_record(&path) {
        if is_expected_process(&record) {
            return Ok(Acquire::AlreadyRunning(record.pid));
        }
        let _ = fs::remove_file(&path);
    }

    let executable = std::env::current_exe()?
        .canonicalize()?
        .to_string_lossy()
        .into_owned();
    let record = PidRecord {
        pid: std::process::id(),
        executable,
        started_at: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs(),
    };
    let parent = path.parent().context("PID path has no parent")?;
    fs::create_dir_all(parent)?;
    let mut file = fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&path)
        .context("another Blind server is starting; retry `blind serve`")?;
    file.write_all(&serde_json::to_vec(&record)?)?;
    Ok(Acquire::Acquired(ServerGuard {
        path,
        pid: record.pid,
    }))
}

pub fn stop() -> Result<String> {
    let path = pid_path()?;
    let Some(record) = read_record(&path) else {
        return Ok("Blind server is already stopped.".into());
    };
    if !is_expected_process(&record) {
        let _ = fs::remove_file(&path);
        return Ok("Blind server is already stopped. Removed a stale PID record.".into());
    }
    let result = unsafe { libc::kill(record.pid as i32, libc::SIGTERM) };
    if result != 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    for _ in 0..30 {
        if !is_expected_process(&record) {
            let _ = fs::remove_file(&path);
            return Ok(format!("Stopped Blind server (PID {}).", record.pid));
        }
        thread::sleep(Duration::from_millis(100));
    }
    Ok(format!(
        "Sent stop signal to Blind server (PID {}).",
        record.pid
    ))
}

pub fn running_pid() -> Result<Option<u32>> {
    let path = pid_path()?;
    let Some(record) = read_record(&path) else {
        return Ok(None);
    };
    if is_expected_process(&record) {
        Ok(Some(record.pid))
    } else {
        let _ = fs::remove_file(path);
        Ok(None)
    }
}

impl Drop for ServerGuard {
    fn drop(&mut self) {
        if read_record(&self.path).is_some_and(|record| record.pid == self.pid) {
            let _ = fs::remove_file(&self.path);
        }
    }
}

fn pid_path() -> Result<PathBuf> {
    Ok(config_path()?
        .parent()
        .context("config path has no parent")?
        .join("server.pid"))
}

fn read_record(path: &PathBuf) -> Option<PidRecord> {
    serde_json::from_slice(&fs::read(path).ok()?).ok()
}

fn is_expected_process(record: &PidRecord) -> bool {
    let output = Command::new("ps")
        .args(["-p", &record.pid.to_string(), "-o", "command="])
        .output();
    let Ok(output) = output else {
        return false;
    };
    if !output.status.success() {
        return false;
    }
    let command = String::from_utf8_lossy(&output.stdout);
    let Some(actual_executable) = command.split_whitespace().next() else {
        return false;
    };
    let actual_executable = std::path::Path::new(actual_executable).canonicalize().ok();
    actual_executable.as_deref() == Some(std::path::Path::new(&record.executable))
        && command.split_whitespace().any(|part| part == "serve")
}
