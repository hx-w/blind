use crate::{
    geometry::lod::LodCache, render::Renderer, runtime::config::Config, storage::registry::Registry,
};
use std::{
    collections::HashMap,
    net::IpAddr,
    sync::{Arc, Mutex},
    time::Instant,
};

#[derive(Clone)]
pub struct AppState {
    pub config: Arc<Config>,
    pub registry: Arc<Registry>,
    pub renderer: Option<Arc<Renderer>>,
    pub image_slots: Arc<tokio::sync::Semaphore>,
    pub lod_slots: Arc<tokio::sync::Semaphore>,
    pub lod_memory: Arc<tokio::sync::Semaphore>,
    pub(super) response_memory: Arc<tokio::sync::Semaphore>,
    pub(super) join_slots: Arc<tokio::sync::Semaphore>,
    pub(super) plugin_slots: Arc<tokio::sync::Semaphore>,
    pub lod_cache: LodCache,
    pub shutdown: tokio::sync::mpsc::Sender<()>,
    pub(super) doctor_lock: Arc<tokio::sync::Mutex<()>>,
    pub(super) short_misses: Arc<Mutex<MissLimiter>>,
}

pub(super) const LOD_MEMORY_MIB: u32 = 512;
pub(super) const RESPONSE_MEMORY_MIB: u32 = 512;
pub(super) const LOD_MEMORY_EXPANSION: u64 = 3;
pub(super) const MIB: u64 = 1024 * 1024;

#[derive(Default)]
pub(super) struct MissLimiter {
    pub(super) clients: HashMap<IpAddr, MissWindow>,
}

pub(super) struct MissWindow {
    pub(super) started: Instant,
    pub(super) misses: u16,
}
