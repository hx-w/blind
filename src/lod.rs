use std::{
    collections::{HashMap, VecDeque},
    sync::{Arc, Mutex},
};

use anyhow::Result;
use bytes::Bytes;
use serde::{Deserialize, Serialize};

use crate::{
    mesh::{self, Geometry},
    scene::MeshFormat,
};

const CACHE_BYTES: usize = 256 * 1024 * 1024;
const SCENE_TARGET_PRIMITIVES: usize = 150_000;
const MIN_MESH_PRIMITIVES: usize = 1;
const MAX_MESH_PRIMITIVES: usize = 50_000;
const TARGET_ERROR: f32 = 0.002;

#[derive(Debug, Clone)]
pub struct LodAsset {
    pub bytes: Bytes,
    pub raw_bytes: usize,
    /// Every asset is exactly one primitive kind, so only one count pair is live.
    pub point_cloud: bool,
    pub source_primitives: usize,
    pub primitives: usize,
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
    #[serde(default)]
    pub source_points: usize,
    #[serde(default)]
    pub lod_points: usize,
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
        let state = self
            .inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state.entries.get(key).cloned()
    }

    pub fn insert(&self, key: String, asset: Arc<LodAsset>) {
        let mut state = self
            .inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
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
        let mut source_points = 0_usize;
        let mut lod_points = 0_usize;
        for asset in state.entries.values() {
            raw_bytes = raw_bytes.saturating_add(asset.raw_bytes);
            let (source, lod) = (asset.source_primitives, asset.primitives);
            if asset.point_cloud {
                source_points = source_points.saturating_add(source);
                lod_points = lod_points.saturating_add(lod);
            } else {
                source_triangles = source_triangles.saturating_add(source);
                lod_triangles = lod_triangles.saturating_add(lod);
            }
        }
        LodCacheStats {
            entries: state.entries.len(),
            resident_bytes: state.bytes,
            capacity_bytes: self.max_bytes,
            raw_bytes,
            source_triangles,
            lod_triangles,
            source_points,
            lod_points,
        }
    }
}

pub fn target_primitives(mesh_count: usize) -> usize {
    SCENE_TARGET_PRIMITIVES
        .div_ceil(mesh_count.max(1))
        .clamp(MIN_MESH_PRIMITIVES, MAX_MESH_PRIMITIVES)
}

#[cfg(test)]
pub fn build(
    path: &std::path::Path,
    format: MeshFormat,
    target_primitives: usize,
) -> Result<LodAsset> {
    build_bytes(&std::fs::read(path)?, format, target_primitives)
}

pub fn build_bytes(bytes: &[u8], format: MeshFormat, target_primitives: usize) -> Result<LodAsset> {
    let (raw_bytes, source_primitives, geometry) = if format == MeshFormat::Pts {
        mesh::pts_raw_size_and_lod_geometry(bytes, target_primitives)?
    } else {
        let raw_bytes = bytes.len();
        let geometry = Geometry::from_bytes(bytes, format)?;
        (raw_bytes, geometry.primitive_count(), geometry)
    };
    // Both feeds already reject non-finite coordinates: Geometry::load scans
    // PLY/STL/OBJ, and the PTS parser skips non-finite points per line.
    let point_cloud = geometry.is_point_cloud();
    // A PTS tube is already a controlled procedural preview. Mesh decimation
    // collapses its thin cross sections and introduces visible kinks.
    let geometry = if format == MeshFormat::Pts {
        geometry
    } else {
        simplify_geometry(geometry, target_primitives)
    };
    let asset = LodAsset {
        bytes: Bytes::from(geometry.to_binary_ply()?),
        raw_bytes,
        point_cloud,
        source_primitives,
        primitives: geometry.primitive_count(),
    };
    Ok(asset)
}

fn simplify_geometry(mut geometry: Geometry, target_primitives: usize) -> Geometry {
    if geometry.is_point_cloud() {
        let target_points = target_primitives.min(geometry.positions.len());
        if target_points >= geometry.positions.len() {
            return geometry;
        }
        if target_points == 1 {
            geometry.positions.truncate(1);
            return geometry;
        }
        let last = geometry.positions.len() - 1;
        geometry.positions = (0..target_points)
            .map(|index| geometry.positions[index * last / (target_points - 1)])
            .collect();
        return geometry;
    }
    let target_count = target_primitives
        .saturating_mul(3)
        .min(geometry.indices.len());
    if target_count >= geometry.indices.len() || target_count < 3 {
        return geometry;
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
    if indices.len() < 3 || indices.len() > target_count {
        indices = meshopt::simplify_sloppy_decoder(
            &geometry.indices,
            &geometry.positions,
            target_count,
            1.0,
            Some(&mut error),
        );
    }
    if indices.len() < 3 {
        return geometry;
    }
    geometry.positions = meshopt::optimize_vertex_fetch(&mut indices, &geometry.positions);
    geometry.indices = indices;
    geometry
}

pub fn cache_key(revision: &str, format: MeshFormat, target_primitives: usize) -> String {
    // Encoding the profile parameters (instead of a hand-bumped suffix) makes
    // any profile change invalidate cached entries automatically.
    format!("{revision}:{format:?}:{target_primitives}:{TARGET_ERROR}:curve3")
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
        let lod = simplify_geometry(source, 2_000);
        assert!(lod.indices.len() / 3 < source_triangles);
        assert!(lod.indices.len() / 3 <= 2_000);
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
        let (raw_size, _, preview) = mesh::pts_raw_size_and_lod_geometry(source, 2_000).unwrap();
        assert!(preview.to_binary_ply().unwrap().len() < raw_size);
    }

    #[test]
    fn dense_pts_build_respects_the_shared_scene_budget() {
        let mut source = String::new();
        for i in 0..4_096 {
            let angle = std::f32::consts::TAU * i as f32 / 4_096.0;
            source.push_str(&format!("{} {} 0\n", 4.0 * angle.cos(), 4.0 * angle.sin()));
        }
        let target = target_primitives(13);
        let asset = build_bytes(source.as_bytes(), MeshFormat::Pts, target).unwrap();
        assert!(!asset.point_cloud);
        assert!(asset.primitives <= target);
        assert!(asset.primitives * 13 <= SCENE_TARGET_PRIMITIVES);
        assert!(asset.source_primitives > asset.primitives);
        assert!(asset.raw_bytes > asset.bytes.len());
    }

    #[test]
    fn point_cloud_lod_samples_the_full_input_range() {
        let source = Geometry {
            positions: (0..10_000).map(|index| [index as f32, 0.0, 0.0]).collect(),
            indices: Vec::new(),
        };
        let lod = simplify_geometry(source.clone(), 2_000);
        assert!(lod.is_point_cloud());
        assert_eq!(lod.positions.len(), 2_000);
        assert_eq!(lod.positions.first(), Some(&[0.0, 0.0, 0.0]));
        assert_eq!(lod.positions.last(), Some(&[9_999.0, 0.0, 0.0]));

        let minimal = simplify_geometry(source, 1);
        assert_eq!(minimal.positions, [[0.0, 0.0, 0.0]]);
    }

    #[test]
    fn point_cloud_build_reports_point_counts() {
        let mut source = String::from(
            "ply\nformat ascii 1.0\nelement vertex 3000\nproperty float x\nproperty float y\nproperty float z\nend_header\n",
        );
        for index in 0..3_000 {
            source.push_str(&format!("{index} 0 0\n"));
        }
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("cloud.ply");
        std::fs::write(&path, source).unwrap();

        let asset = build(&path, MeshFormat::Ply, 2_000).unwrap();
        assert!(asset.point_cloud);
        assert_eq!(asset.source_primitives, 3_000);
        assert_eq!(asset.primitives, 2_000);
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
                point_cloud: false,
                source_primitives: 2,
                primitives: 1,
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
                source_points: 0,
                lod_points: 0,
            }
        );
    }

    #[test]
    fn cache_stats_accept_legacy_servers_without_point_counts() {
        let stats: LodCacheStats = serde_json::from_value(serde_json::json!({
            "entries": 1,
            "resident_bytes": 12,
            "capacity_bytes": 24,
            "raw_bytes": 48,
            "source_triangles": 2,
            "lod_triangles": 1
        }))
        .unwrap();
        assert_eq!(stats.source_points, 0);
        assert_eq!(stats.lod_points, 0);
    }

    #[test]
    fn lightweight_profile_distributes_a_fixed_scene_budget() {
        assert_eq!(target_primitives(1), 50_000);
        assert_eq!(target_primitives(3), 50_000);
        assert_eq!(target_primitives(6), 25_000);
        assert_eq!(target_primitives(30), 5_000);
        assert_eq!(target_primitives(100), 1_500);
        assert_eq!(target_primitives(1_000), 150);
        assert_eq!(target_primitives(10_000), 15);
        assert_eq!(target_primitives(1_000_000), 1);
    }

    #[test]
    fn non_finite_vertices_are_rejected_before_simplification() {
        // Binary NaN reaches geometry validation; the ASCII PLY grammar itself rejects "nan".
        let source = Geometry {
            positions: vec![[0., 0., 0.], [f32::NAN, 0., 0.], [0., 1., 0.]],
            indices: vec![0, 1, 2],
        }
        .to_binary_ply()
        .unwrap();
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("non-finite.ply");
        std::fs::write(&path, source).unwrap();
        let error = build(&path, MeshFormat::Ply, 2_000).unwrap_err();
        assert!(error.to_string().contains("non-finite"));
    }
}
