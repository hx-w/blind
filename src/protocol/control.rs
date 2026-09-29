use crate::geometry::lod::LodCacheStats;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ControlHealth {
    pub(crate) service: String,
    pub pid: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
}

#[derive(Debug, Clone, Copy)]
pub enum DoctorAction {
    Audit,
    CleanInvalid,
    ClearAll,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DoctorRegistryReport {
    #[serde(default)]
    pub unavailable: usize,
    pub valid: usize,
    pub expired: usize,
    pub source_gone: usize,
    pub tombstoned: usize,
    pub corrupt: usize,
    pub removed: usize,
    pub preserved: usize,
    #[serde(default)]
    pub audit_skipped: bool,
    pub key_repaired: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lod_cache: Option<LodCacheStats>,
}

impl DoctorRegistryReport {
    pub fn invalid(&self) -> usize {
        self.expired + self.source_gone + self.tombstoned + self.corrupt
    }

    /// Report for a clear that removed every link without auditing its sources.
    pub fn cleared(removed: usize) -> Self {
        Self {
            valid: 0,
            unavailable: 0,
            expired: 0,
            source_gone: 0,
            tombstoned: 0,
            corrupt: 0,
            removed,
            preserved: 0,
            audit_skipped: true,
            key_repaired: false,
            lod_cache: None,
        }
    }

    pub fn total(&self) -> usize {
        if self.audit_skipped {
            self.removed
        } else {
            self.valid + self.unavailable + self.invalid()
        }
    }
}
