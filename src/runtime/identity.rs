use anyhow::{Result, bail};
use std::process::Command;

pub(crate) fn local_identity() -> Result<(String, String)> {
    let user = Command::new("id").arg("-un").output()?;
    let host = Command::new("hostname").output()?;
    if !user.status.success() || !host.status.success() {
        bail!("could not identify this OS user");
    }
    Ok((
        String::from_utf8(user.stdout)?.trim().to_owned(),
        String::from_utf8(host.stdout)?.trim().to_owned(),
    ))
}
