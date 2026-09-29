//! Invitation input and registration output for CLI commands.
use crate::{client, protocol::registration::Invitation};
use anyhow::Result;
use std::io::Read;

pub(super) async fn join(
    stdin: bool,
    local: bool,
    client_only: bool,
    address: Option<String>,
    port: Option<u16>,
    name: Option<String>,
) -> Result<()> {
    // Existing registrations resume without waiting for another invitation.
    let invitation = if stdin && !local && client::load()?.is_none() {
        let mut input = String::new();
        std::io::stdin().take(16_385).read_to_string(&mut input)?;
        Some(Invitation::decode(&input)?)
    } else {
        None
    };
    let result = client::join(invitation, local, client_only, address, port, name).await?;
    let action = if result.already_registered {
        "Already registered"
    } else {
        "Registered"
    };
    eprintln!("{action}: {} → {}", result.name, result.server);
    Ok(())
}
