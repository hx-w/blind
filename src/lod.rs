use std::{
    collections::{HashMap, VecDeque},
    path::Path,
    sync::{Arc, Mutex},
};

use anyhow::{Result, bail};
use bytes::Bytes;
use serde::{Deserialize, Serialize};

use crate::{
    mesh::{self, Geometry},
    scene::MeshFormat,
};

const CACHE_BYTES: usize = 256 * 1024 * 1024;
const TARGET_ERROR: f32 = 0.002;

#[derive(Debug, Clone)]
pub struct LodAsset {
    pub bytes: Bytes,
    pub raw_bytes: usize,
    pub triangles: usize,
    pub source_triangles: usize,
    pub error: f32,
}

#[derive(Clone)]
pub struct LodCache {
    inner: Arc<Mutex<CacheState>>,
    max_bytes: usize,
}

#[derive(Default)]
struct CacheState {
    entries: HashMap<String, Arc<LodAsset>>,
    order: VecDeque<String>,
    bytes: usize,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub struct LodCacheStats {
    pub entries: usize,
    pub resident_bytes: usize,
    pub capacity_bytes: usize,
    pub raw_bytes: usize,
    pub source_triangles: usize,
    pub lod_triangles: usize,
}

impl Default for LodCache {
    fn default() -> Self {
        Self {
            inner: Arc::new(Mutex::new(CacheState::default())),
            max_bytes: CACHE_BYTES,
        }
    }
}

impl LodCache {
    pub fn get(&self, key: &str) -> Option<Arc<LodAsset>> {
        self.inner.lock().ok()?.entries.get(key).cloned()
    }

    pub fn insert(&self, key: String, asset: Arc<LodAsset>) {
        let Ok(mut state) = self.inner.lock() else {
            return;
        };
        if asset.bytes.len() > self.max_bytes {
            return;
        }
        if state.entries.contains_key(&key) {
            return;
        }
        while state.bytes + asset.bytes.len() > self.max_bytes {
            let Some(oldest) = state.order.pop_front() else {
                break;
            };
            if let Some(removed) = state.entries.remove(&oldest) {
                state.bytes = state.bytes.saturating_sub(removed.bytes.len());
            }
        }
        state.bytes += asset.bytes.len();
        state.order.push_back(key.clone());
        state.entries.insert(key, asset);
    }

    pub fn stats(&self) -> LodCacheStats {
        let state = self
            .inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut raw_bytes = 0_usize;
        let mut source_triangles = 0_usize;
        let mut lod_triangles = 0_usize;
        for asset in state.entries.values() {
            raw_bytes = raw_bytes.saturating_add(asset.raw_bytes);
            source_triangles = source_triangles.saturating_add(asset.source_triangles);
            lod_triangles = lod_triangles.saturating_add(asset.triangles);
        }
        LodCacheStats {
            entries: state.entries.len(),
            resident_bytes: state.bytes,
            capacity_bytes: self.max_bytes,
            raw_bytes,
            source_triangles,
            lod_triangles,
        }
    }
}

pub fn target_triangles(mesh_count: usize) -> usize {
    (150_000 / mesh_count.max(1)).clamp(2_000, 50_000)
}

pub fn build(
    path: &Path,
    source: Vec<u8>,
    format: MeshFormat,
    target_triangles: usize,
) -> Result<LodAsset> {
    let (raw_bytes, geometry) = if format == MeshFormat::Pts {
        (
            mesh::pts_geometry(&source)?.to_binary_ply()?.len(),
            mesh::pts_lod_geometry(&source)?,
        )
    } else {
        let raw_bytes = source.len();
        drop(source);
        (raw_bytes, Geometry::load(path, format)?)
    };
    if geometry
        .positions
        .iter()
        .flatten()
        .any(|value| !value.is_finite())
    {
        bail!("Mesh contains non-finite vertex coordinates");
    }
    let source_triangles = geometry.indices.len() / 3;
    let (geometry, error) = simplify_geometry(geometry, target_triangles);
    let triangles = geometry.indices.len() / 3;
    let bytes = Bytes::from(geometry.to_binary_ply()?);
    Ok(LodAsset {
        bytes,
        raw_bytes,
        triangles,
        source_triangles,
        error,
    })
}

fn simplify_geometry(mut geometry: Geometry, target_triangles: usize) -> (Geometry, f32) {
    let target_count = target_triangles
        .saturating_mul(3)
        .min(geometry.indices.len());
    if target_count >= geometry.indices.len() || target_count < 3 {
        return (geometry, 0.0);
    }
    let mut error = 0.0;
    let mut indices = meshopt::simplify_decoder(
        &geometry.indices,
        &geometry.positions,
        target_count,
        TARGET_ERROR,
        meshopt::SimplifyOptions::None,
        Some(&mut error),
    );
    if indices.len() < 3 {
        return (geometry, 0.0);
    }
    geometry.positions = meshopt::optimize_vertex_fetch(&mut indices, &geometry.positions);
    geometry.indices = indices;
    (geometry, error)
}

pub fn cache_key(revision: &str, format: MeshFormat, target_triangles: usize) -> String {
    format!("{revision}:{format:?}:{target_triangles}:v2")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn grid(size: usize) -> Geometry {
        let mut positions = Vec::new();
        for y in 0..=size {
            for x in 0..=size {
                positions.push([x as f32, y as f32, ((x + y) % 3) as f32 * 0.01]);
            }
        }
        let mut indices = Vec::new();
        for y in 0..size {
            for x in 0..size {
                let a = (y * (size + 1) + x) as u32;
                let b = a + 1;
                let c = a + (size + 1) as u32;
                let d = c + 1;
                indices.extend_from_slice(&[a, b, d, a, d, c]);
            }
        }
        Geometry { positions, indices }
    }

    #[test]
    fn simplification_compacts_geometry_in_memory() {
        let source = grid(80);
        let source_triangles = source.indices.len() / 3;
        let (lod, _) = simplify_geometry(source, 2_000);
        assert!(lod.indices.len() / 3 < source_triangles);
        assert!(lod.indices.len() / 3 <= 2_100);
        assert!(
            lod.indices
                .iter()
                .all(|index| (*index as usize) < lod.positions.len())
        );
        assert!(
            lod.positions
                .iter()
                .flatten()
                .all(|value| value.is_finite())
        );
    }

    #[test]
    fn pts_lod_keeps_semantic_points_but_reduces_procedural_detail() {
        let source = b"0 0 0\n2 0 0\n2 2 0\n0 2 0\n";
        let raw = mesh::pts_geometry(source).unwrap().to_binary_ply().unwrap();
        let preview = mesh::pts_lod_geometry(source)
            .unwrap()
            .to_binary_ply()
            .unwrap();
        assert!(preview.len() < raw.len());
    }

    #[test]
    fn cache_is_memory_bounded() {
        let cache = LodCache {
            inner: Arc::new(Mutex::new(CacheState::default())),
            max_bytes: 8,
        };
        let asset = |value| {
            Arc::new(LodAsset {
                bytes: Bytes::from(vec![value; 6]),
                raw_bytes: 12,
                triangles: 1,
                source_triangles: 2,
                error: 0.0,
            })
        };
        cache.insert("a".into(), asset(1));
        cache.insert("b".into(), asset(2));
        assert!(cache.get("a").is_none());
        assert!(cache.get("b").is_some());
        assert_eq!(
            cache.stats(),
            LodCacheStats {
                entries: 1,
                resident_bytes: 6,
                capacity_bytes: 8,
                raw_bytes: 12,
                source_triangles: 2,
                lod_triangles: 1,
            }
        );
    }

    #[test]
    fn lightweight_profile_distributes_a_fixed_scene_budget() {
        assert_eq!(target_triangles(1), 50_000);
        assert_eq!(target_triangles(3), 50_000);
        assert_eq!(target_triangles(6), 25_000);
        assert_eq!(target_triangles(30), 5_000);
        assert_eq!(target_triangles(100), 2_000);
    }

    #[test]
    fn non_finite_vertices_are_rejected_before_simplification() {
        let source = b"ply\nformat ascii 1.0\nelement vertex 3\nproperty float x\nproperty float y\nproperty float z\nelement face 1\nproperty list uchar uint vertex_indices\nend_header\n0 0 0\nnan 0 0\n0 1 0\n3 0 1 2\n";
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("non-finite.ply");
        std::fs::write(&path, source).unwrap();
        let error = build(&path, source.to_vec(), MeshFormat::Ply, 2_000).unwrap_err();
        assert!(error.to_string().contains("non-finite"));
    }
}
