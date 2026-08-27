use std::{
    cmp::Reverse,
    collections::HashSet,
    net::{IpAddr, Ipv4Addr},
};

use anyhow::Result;
use if_addrs::get_if_addrs;
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct HostCandidate {
    pub origin: String,
    pub address: String,
    pub scope: &'static str,
    pub interface: String,
    pub primary: bool,
}

pub fn discover(port: u16, preferred: Option<&str>) -> Result<Vec<HostCandidate>> {
    let mut candidates = Vec::new();
    let mut seen = HashSet::new();

    if let Some(origin) = preferred {
        seen.insert(origin.to_string());
        candidates.push(HostCandidate {
            origin: origin.to_string(),
            address: origin.to_string(),
            scope: "configured",
            interface: "configured".into(),
            primary: false,
        });
    }

    let mut addresses: Vec<_> = get_if_addrs()?
        .into_iter()
        .filter_map(|interface| {
            let ip = interface.ip();
            if ip.is_loopback() || ip.is_unspecified() || is_link_local(ip) {
                return None;
            }
            let score = address_score(ip);
            Some((score, interface.name, ip))
        })
        .collect();
    addresses.sort_by_key(|(score, name, ip)| (Reverse(*score), name.clone(), ip.to_string()));

    for (_, interface, ip) in addresses {
        let host = match ip {
            IpAddr::V4(ip) => ip.to_string(),
            IpAddr::V6(ip) => format!("[{ip}]"),
        };
        let origin = format!("http://{host}:{port}");
        if !seen.insert(origin.clone()) {
            continue;
        }
        candidates.push(HostCandidate {
            origin,
            address: ip.to_string(),
            scope: scope(ip),
            interface,
            primary: false,
        });
    }

    let local = format!("http://127.0.0.1:{port}");
    if seen.insert(local.clone()) {
        candidates.push(HostCandidate {
            origin: local,
            address: "127.0.0.1".into(),
            scope: "local",
            interface: "loopback".into(),
            primary: false,
        });
    }
    if let Some(first) = candidates.first_mut() {
        first.primary = true;
    }
    Ok(candidates)
}

fn is_cgnat_v4(ip: Ipv4Addr) -> bool {
    ip.octets()[0] == 100 && (64..=127).contains(&ip.octets()[1])
}

fn address_score(ip: IpAddr) -> u8 {
    match ip {
        IpAddr::V4(ip) if is_cgnat_v4(ip) => 5,
        IpAddr::V4(ip) if ip.is_private() => 4,
        IpAddr::V6(ip) if is_unique_local(ip) => 3,
        IpAddr::V4(_) => 2,
        IpAddr::V6(_) => 1,
    }
}

fn scope(ip: IpAddr) -> &'static str {
    match ip {
        IpAddr::V4(ip) if ip.is_private() || is_cgnat_v4(ip) => "private",
        IpAddr::V6(ip) if is_unique_local(ip) => "private",
        _ => "global",
    }
}

fn is_link_local(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => ip.is_link_local(),
        IpAddr::V6(ip) => ip.is_unicast_link_local(),
    }
}

fn is_unique_local(ip: std::net::Ipv6Addr) -> bool {
    ip.segments()[0] & 0xfe00 == 0xfc00
}
