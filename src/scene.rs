use std::path::Path;
#[cfg(test)]
use std::{
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};

use anyhow::{Context, Result, bail, ensure};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
#[cfg(test)]
use tokio::io::AsyncReadExt;

pub const PALETTE: [&str; 6] = [
    "#8fa9c9", "#8ca49c", "#b2a4ad", "#bf8078", "#8f8bb2", "#b7b3aa",
];
/// Curves need a distinct, saturated palette against the muted scan surfaces.
pub fn default_color(format: MeshFormat, index: usize) -> &'static str {
    const CURVES: [&str; 6] = [
        "#ffce54", "#44d7ff", "#ff765e", "#68e0b0", "#c798ff", "#ff8dca",
    ];
    if format == MeshFormat::Pts {
        CURVES[index % CURVES.len()]
    } else {
        PALETTE[index % PALETTE.len()]
    }
}

pub const MAX_SCREEN_STROKES: usize = 64;
pub const MAX_SCREEN_STROKE_POINTS: usize = 512;
pub const MAX_SCREEN_POINTS: usize = 4_096;
pub const MAX_MESH_LABEL_CHARS: usize = 120;
pub const MAX_LABEL_GROUPS: usize = 64;
pub const DEFAULT_TTL_DAYS: u32 = 7;

pub const fn default_ttl_days() -> u32 {
    DEFAULT_TTL_DAYS
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SceneDescriptor {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<crate::source::SceneSource>,
    pub schema: u8,
    pub title: String,
    pub created_at: u64,
    /// None preserves earlier descriptors; zero explicitly disables time expiry.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ttl_days: Option<u32>,
    pub meshes: Vec<MeshRef>,
    #[serde(default, alias = "components", skip_serializing_if = "Vec::is_empty")]
    pub entities: Vec<crate::component::SceneEntity>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub label_groups: Vec<MeshLabelGroup>,
    pub state: ViewState,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub attachments: Vec<SceneAttachment>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<crate::plugin::Warning>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub collection: Option<SceneCollection>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SceneCollection {
    pub title: String,
    pub first_id: String,
    pub active_scene_id: String,
    pub scenes: Vec<CollectionEntry>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub strokes: Vec<ScreenStroke>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub layout: Option<CollectionLayout>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct CollectionLayout {
    pub width: u32,
    pub height: u32,
    pub columns: u32,
}

impl CollectionLayout {
    pub fn validate(self, scenes: usize) -> Result<()> {
        let rows = (scenes as u32).div_ceil(self.columns.max(1));
        if !(320..=4096).contains(&self.width)
            || !(240..=4096).contains(&self.height)
            || self.columns == 0
            || self.columns as usize > scenes
            || u64::from(self.width) * u64::from(self.height) > 16_000_000
            || self.width < 16 + self.columns * 160 + (self.columns - 1) * 8
            || self.height < 16 + rows * 135 + (rows - 1) * 8
        {
            bail!("invalid collection layout");
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CollectionEntry {
    pub id: String,
    pub scene: SceneDescriptor,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MeshRef {
    pub path: String,
    pub name: String,
    pub format: MeshFormat,
    pub revision: String,
    pub byte_size: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub modified_ns: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub change_ns: Option<u64>,
    pub color: String,
    pub opacity: f32,
    pub visible: bool,
    #[serde(default)]
    pub quality: MeshQuality,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<MeshLabel>,
    #[serde(default)]
    pub translation: [f32; 3],
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SceneAttachment {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub member: Option<String>,
    pub id: String,
    pub path: String,
    pub label: String,
    pub byte_size: Option<u64>,
    pub revision: Option<String>,
    pub unavailable: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MeshLabel {
    pub text: String,
    /// World-space attachment point. None uses the Mesh bounds center.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub anchor: Option<[f32; 3]>,
}

impl MeshLabel {
    pub fn validate(&self) -> Result<()> {
        if self.text.trim().is_empty() || self.text.chars().count() > MAX_MESH_LABEL_CHARS {
            bail!("Mesh label must contain 1 to {MAX_MESH_LABEL_CHARS} characters");
        }
        if self
            .anchor
            .is_some_and(|point| point.iter().any(|v| !v.is_finite()))
        {
            bail!("Mesh label anchor must contain finite coordinates");
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MeshLabelGroup {
    pub text: String,
    /// Zero-based Mesh indices. A group always contains at least two Meshes.
    pub meshes: Vec<usize>,
}

impl MeshLabelGroup {
    pub fn validate(&self, mesh_count: usize) -> Result<()> {
        if self.text.trim().is_empty() || self.text.chars().count() > MAX_MESH_LABEL_CHARS {
            bail!("Mesh label must contain 1 to {MAX_MESH_LABEL_CHARS} characters");
        }
        if self.meshes.len() < 2 {
            bail!("A grouped label must contain at least two Meshes");
        }
        let mut unique = self.meshes.clone();
        unique.sort_unstable();
        unique.dedup();
        if unique.len() != self.meshes.len() {
            bail!("A grouped label cannot contain the same Mesh twice");
        }
        if self.meshes.iter().any(|index| *index >= mesh_count) {
            bail!("label index out of range");
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum MeshFormat {
    Ply,
    Stl,
    Obj,
    Pts,
}

#[derive(Debug, Default, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum MeshQuality {
    #[default]
    Lod,
    Raw,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ViewState {
    pub selected: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub focused_component_id: Option<String>,
    pub shading: Shading,
    #[serde(default)]
    pub render_mode: RenderMode,
    #[serde(default)]
    pub light: LightSettings,
    pub projection: Projection,
    pub background: Background,
    pub axes: bool,
    pub frame: Frame,
    pub camera: Option<CameraState>,
    #[serde(default)]
    pub strokes: Vec<ScreenStroke>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub annotations: Vec<SurfaceAnnotation>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub section: Option<SectionState>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SectionState {
    pub entity_id: String,
    pub mesh: usize,
    pub revision: String,
    pub origin: [f64; 3],
    pub normal: [f64; 3],
    pub axis: [f64; 3],
    pub radius: f64,
    pub offset: f64,
    pub fit: bool,
    #[serde(default)]
    pub pan: [f64; 2],
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub targets: Vec<SectionTarget>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub panel_size: Option<[f64; 2]>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub measurements: Vec<SectionMeasurement>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SectionMeasurement {
    pub a: [f64; 2],
    pub b: [f64; 2],
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub opposite: Option<[f64; 2]>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SectionTarget {
    pub entity_id: String,
    pub mesh: usize,
    pub revision: String,
}

impl SectionState {
    fn validate(
        &self,
        meshes: &[MeshRef],
        entities: &[crate::component::SceneEntity],
    ) -> Result<()> {
        let mesh = meshes
            .get(self.mesh)
            .context("section target is not in the scene")?;
        ensure!(
            entities.iter().any(|entity| entity.id == self.entity_id
                && entity.source == crate::component::ComponentSource::Mesh(self.mesh)
                && entity.component == crate::component::ComponentKind::Mesh),
            "section entity is not a Mesh in the scene"
        );
        ensure!(
            mesh.revision == self.revision,
            "section target revision changed"
        );
        ensure!(
            self.targets.len() <= meshes.len(),
            "too many section targets"
        );
        ensure!(
            self.measurements.len() <= 2,
            "too many section measurements"
        );
        let mut seen = std::collections::HashSet::new();
        for target in &self.targets {
            ensure!(seen.insert(target.mesh), "duplicate section target");
            let source = meshes
                .get(target.mesh)
                .context("section target is not in the scene")?;
            ensure!(
                source.revision == target.revision,
                "section target revision changed"
            );
            ensure!(
                entities.iter().any(|entity| entity.id == target.entity_id
                    && entity.source == crate::component::ComponentSource::Mesh(target.mesh)
                    && entity.component == crate::component::ComponentKind::Mesh),
                "section entity is not a Mesh in the scene"
            );
        }
        ensure!(
            self.origin
                .iter()
                .chain(self.normal.iter())
                .chain(self.axis.iter())
                .chain(self.pan.iter())
                .all(|v| v.is_finite()),
            "section coordinates must be finite"
        );
        ensure!(
            self.panel_size.is_none_or(|size| size
                .iter()
                .all(|v| v.is_finite() && *v >= 160.0 && *v <= 1200.0)),
            "invalid section panel size"
        );
        ensure!(
            self.measurements.iter().all(|line| line
                .a
                .iter()
                .chain(line.b.iter())
                .chain(line.opposite.iter().flatten())
                .all(|v| v.is_finite() && v.abs() <= 1e9)),
            "invalid section measurement"
        );
        ensure!(
            self.radius.is_finite() && self.radius > 0.0 && self.offset.is_finite(),
            "section extent must be finite"
        );
        let length = |v: [f64; 3]| v.iter().map(|x| x * x).sum::<f64>().sqrt();
        ensure!(
            (length(self.normal) - 1.0).abs() < 0.01 && (length(self.axis) - 1.0).abs() < 0.01,
            "section axes must be unit vectors"
        );
        let dot = self
            .normal
            .iter()
            .zip(self.axis.iter())
            .map(|(a, b)| a * b)
            .sum::<f64>();
        ensure!(dot.abs() < 0.01, "section axes must be perpendicular");
        Ok(())
    }
}

/// Frozen surface samples. Sharing never reprojects or refits these coordinates.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SurfaceAnnotation {
    pub id: String,
    pub mesh: usize,
    pub revision: String,
    pub kind: SurfaceAnnotationKind,
    pub label: String,
    pub color: String,
    pub visible: bool,
    pub closed: bool,
    pub points: Vec<[f64; 3]>,
    pub normals: Vec<[f64; 3]>,
    pub controls: Vec<usize>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SurfaceAnnotationKind {
    Point,
    Line,
}

pub fn validate_annotations(marks: &[SurfaceAnnotation], meshes: &[MeshRef]) -> Result<()> {
    if marks.len() > 64 || marks.iter().map(|m| m.points.len()).sum::<usize>() > 16384 {
        bail!("surface annotations exceed the scene limit");
    }
    let mut ids = std::collections::HashSet::new();
    for mark in marks {
        let mesh = meshes
            .get(mark.mesh)
            .context("annotation Mesh is missing")?;
        if mark.id.is_empty()
            || mark.id.len() > 64
            || !ids.insert(&mark.id)
            || mark.revision != mesh.revision
            || mesh.format == MeshFormat::Pts
            || mark.label.chars().count() > 120
            || !is_hex_color(&mark.color)
            || mark.points.is_empty()
            || mark.points.len() > 4096
            || mark.normals.len() != mark.points.len()
            || mark
                .points
                .iter()
                .flatten()
                .any(|v| !v.is_finite() || v.abs() > 1e9)
            || mark.normals.iter().any(|n| {
                let length = n.iter().map(|v| v * v).sum::<f64>();
                !length.is_finite() || !(0.5..=1.5).contains(&length)
            })
            || mark.controls.first() != Some(&0)
            || mark.controls.last() != Some(&(mark.points.len() - 1))
            || mark.controls.windows(2).any(|w| w[0] >= w[1])
            || mark.controls.iter().any(|&i| i >= mark.points.len())
        {
            bail!("invalid surface annotation");
        }
        match mark.kind {
            SurfaceAnnotationKind::Point if mark.points.len() != 1 || mark.closed => {
                bail!("invalid surface point")
            }
            SurfaceAnnotationKind::Line
                if mark.points.len() < 2 || (mark.closed && mark.controls.len() < 3) =>
            {
                bail!("invalid surface line")
            }
            _ => {}
        }
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScreenStroke {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    pub color: String,
    pub aspect: f32,
    pub points: Vec<[f32; 2]>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Frame {
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CameraState {
    pub position: [f32; 3],
    pub target: [f32; 3],
    pub up: [f32; 3],
    pub fov: f32,
    pub zoom: f32,
    pub orthographic_height: f32,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Shading {
    Smooth,
    Flat,
    Wire,
}

#[derive(Debug, Default, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum RenderMode {
    #[default]
    Matte,
    Raking,
    Normals,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct LightSettings {
    pub azimuth: f32,
    pub elevation: f32,
    pub intensity: f32,
}

impl Default for LightSettings {
    fn default() -> Self {
        Self {
            azimuth: 45.0,
            elevation: 20.0,
            intensity: 1.0,
        }
    }
}

impl LightSettings {
    pub fn validate(self) -> Result<()> {
        ensure!(
            self.azimuth.is_finite() && (-180.0..=180.0).contains(&self.azimuth),
            "invalid light azimuth"
        );
        ensure!(
            self.elevation.is_finite() && (0.0..=90.0).contains(&self.elevation),
            "invalid light elevation"
        );
        ensure!(
            self.intensity.is_finite() && (0.0..=2.0).contains(&self.intensity),
            "invalid light intensity"
        );
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Projection {
    Perspective,
    Orthographic,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Background {
    Dark,
    Light,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SceneUpdate {
    #[serde(default, alias = "components")]
    pub entities: Option<Vec<crate::component::EntityUpdate>>,
    pub meshes: Vec<MeshStyleUpdate>,
    pub state: ViewState,
}

#[derive(Debug, Clone, Deserialize)]
pub struct MeshStyleUpdate {
    pub color: String,
    pub opacity: f32,
    pub visible: bool,
    #[serde(default)]
    pub quality: MeshQuality,
    // Omitted by older clients: preserve. Explicit null: remove the label.
    #[serde(default, deserialize_with = "deserialize_label_update")]
    pub label: Option<Option<MeshLabel>>,
}

fn deserialize_label_update<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Option<MeshLabel>>, D::Error> {
    Option::<MeshLabel>::deserialize(deserializer).map(Some)
}

impl Default for ViewState {
    fn default() -> Self {
        Self {
            selected: 0,
            focused_component_id: None,
            shading: Shading::Flat,
            render_mode: RenderMode::Matte,
            light: LightSettings::default(),
            projection: Projection::Perspective,
            background: Background::Dark,
            axes: true,
            frame: Frame {
                width: 1200,
                height: 900,
            },
            camera: None,
            strokes: Vec::new(),
            annotations: Vec::new(),
            section: None,
        }
    }
}

impl SceneDescriptor {
    /// Every scene in a share, in display order. Standalone scenes have no ID;
    /// collection scenes all have one. This keeps the persisted first-child
    /// layout at the storage boundary instead of repeating it in consumers.
    pub fn scene_entries(&self) -> impl Iterator<Item = (Option<&str>, &SceneDescriptor)> {
        let collection = self.collection.as_ref();
        std::iter::once((collection.map(|c| c.first_id.as_str()), self)).chain(
            collection
                .into_iter()
                .flat_map(|c| c.scenes.iter())
                .map(|entry| (Some(entry.id.as_str()), &entry.scene)),
        )
    }

    pub fn scene_by_id(&self, id: &str) -> Option<&SceneDescriptor> {
        self.collection.as_ref()?;
        self.scene_entries()
            .find_map(|(scene_id, scene)| (scene_id == Some(id)).then_some(scene))
    }

    pub fn scene_by_id_mut(&mut self, id: &str) -> Option<&mut SceneDescriptor> {
        if self.collection.as_ref()?.first_id == id {
            return Some(self);
        }
        self.collection
            .as_mut()?
            .scenes
            .iter_mut()
            .find(|entry| entry.id == id)
            .map(|entry| &mut entry.scene)
    }

    pub fn active_scene(&self) -> &SceneDescriptor {
        self.collection
            .as_ref()
            .and_then(|collection| self.scene_by_id(&collection.active_scene_id))
            .unwrap_or(self)
    }

    /// Adapt older geometry descriptors without changing their source identity or layout.
    pub fn entity_descriptors(&self) -> Vec<crate::component::SceneEntity> {
        if !self.entities.is_empty() {
            return self.entities.clone();
        }
        self.meshes
            .iter()
            .enumerate()
            .map(|(index, mesh)| crate::component::SceneEntity {
                renderer: None,
                state: None,
                id: format!("mesh-{index}"),
                component: if mesh.format == MeshFormat::Pts {
                    crate::component::ComponentKind::Points
                } else {
                    crate::component::ComponentKind::Mesh
                },
                source: crate::component::ComponentSource::Mesh(index),
                label: mesh
                    .label
                    .as_ref()
                    .map(|l| l.text.clone())
                    .unwrap_or_else(|| mesh.name.clone()),
                group: self
                    .label_groups
                    .iter()
                    .find(|g| g.meshes.contains(&index))
                    .map(|g| g.text.clone()),
                position: Some(mesh.translation),
                size: None,
                visible: mesh.visible,
                opacity: mesh.opacity,
            })
            .collect()
    }

    pub fn link_ttl_days(&self) -> u32 {
        self.ttl_days.unwrap_or(DEFAULT_TTL_DAYS)
    }

    pub fn set_labels(&mut self, labels: Vec<Option<MeshLabel>>) -> Result<()> {
        if !self.entities.is_empty() && labels.len() == self.entities.len() {
            for label in labels.iter().flatten() {
                label.validate()?;
            }
            for (c, label) in self.entities.iter_mut().zip(labels) {
                if let Some(label) = label {
                    c.label = label.text.clone();
                    if let crate::component::ComponentSource::Mesh(i) = c.source {
                        self.meshes[i].label = Some(label);
                    }
                }
            }
            return Ok(());
        }
        if labels.len() != self.meshes.len() {
            bail!("Mesh label count does not match the scene");
        }
        for label in labels.iter().flatten() {
            label.validate()?;
        }
        for (mesh, label) in self.meshes.iter_mut().zip(labels) {
            mesh.label = label;
        }
        Ok(())
    }

    pub fn set_label_groups(&mut self, groups: Vec<MeshLabelGroup>) -> Result<()> {
        if groups.len() > MAX_LABEL_GROUPS {
            bail!("A scene can contain at most {MAX_LABEL_GROUPS} grouped labels");
        }
        if !self.entities.is_empty() {
            for group in &groups {
                group.validate(self.entities.len())?;
            }
            let mut grouped = std::collections::HashSet::new();
            for group in &groups {
                for &index in &group.meshes {
                    if !grouped.insert(index)
                        || self.entities[index]
                            .group
                            .as_ref()
                            .is_some_and(|label| label != &group.text)
                    {
                        bail!(
                            "An element can belong to only one flat group; repeat its resource to display another instance"
                        );
                    }
                    self.entities[index].group = Some(group.text.clone());
                }
            }
            self.label_groups = groups
                .into_iter()
                .filter_map(|g| {
                    let meshes: Vec<_> = g
                        .meshes
                        .iter()
                        .filter_map(|&i| match self.entities[i].source {
                            crate::component::ComponentSource::Mesh(m) => Some(m),
                            _ => None,
                        })
                        .collect();
                    (meshes.len() > 1).then_some(MeshLabelGroup {
                        text: g.text,
                        meshes,
                    })
                })
                .collect();
        } else {
            for group in &groups {
                group.validate(self.meshes.len())?;
            }
            self.label_groups = groups;
        }
        Ok(())
    }

    #[cfg(test)]
    pub async fn create(paths: &[PathBuf], title: Option<String>) -> Result<Self> {
        if paths.is_empty() {
            bail!("at least one Mesh path is required");
        }
        let mut meshes = Vec::with_capacity(paths.len());
        for (index, path) in paths.iter().enumerate() {
            let canonical = tokio::fs::canonicalize(path)
                .await
                .with_context(|| format!("could not resolve {}", path.display()))?;
            let metadata = tokio::fs::metadata(&canonical).await?;
            if !metadata.is_file() {
                bail!("{} is not a file", path.display());
            }
            let format = MeshFormat::from_path(&canonical)?;
            let revision = hash_file(&canonical).await?;
            let after = tokio::fs::metadata(&canonical).await?;
            if metadata.len() != after.len()
                || modified_nanos(&metadata) != modified_nanos(&after)
                || change_nanos(&metadata) != change_nanos(&after)
            {
                bail!("{} changed while hashing; retry", path.display());
            }
            let name = canonical
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("mesh")
                .to_string();
            meshes.push(MeshRef {
                path: canonical.to_string_lossy().into_owned(),
                name,
                format,
                revision,
                byte_size: after.len(),
                modified_ns: modified_nanos(&after),
                change_ns: change_nanos(&after),
                color: default_color(format, index).to_string(),
                opacity: 1.0,
                visible: true,
                quality: MeshQuality::Lod,
                label: None,
                translation: [0.0; 3],
            });
        }
        let title = title.unwrap_or_else(|| {
            if meshes.len() == 1 {
                meshes[0].name.clone()
            } else {
                format!("{} Meshes", meshes.len())
            }
        });
        Ok(Self {
            source: None,
            schema: 3,
            title,
            ttl_days: None,
            created_at: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs(),
            meshes,
            entities: Vec::new(),
            attachments: Vec::new(),
            warnings: Vec::new(),
            label_groups: Vec::new(),
            state: ViewState::default(),
            collection: None,
        })
    }

    /// Cheap staleness gate: every source file must still exist with the recorded size.
    #[cfg(test)]
    pub async fn verify_source_lengths(&self) -> Result<(), SceneGone> {
        for mesh in &self.meshes {
            let path = Path::new(&mesh.path);
            let metadata = tokio::fs::metadata(path).await.map_err(|_| SceneGone)?;
            if !metadata.is_file() || metadata.len() != mesh.byte_size {
                return Err(SceneGone);
            }
        }
        Ok(())
    }

    #[cfg(test)]
    pub async fn validate(&self) -> Result<(), SceneGone> {
        self.verify_source_lengths().await?;
        for mesh in &self.meshes {
            let revision = hash_file(Path::new(&mesh.path))
                .await
                .map_err(|_| SceneGone)?;
            if revision != mesh.revision {
                return Err(SceneGone);
            }
        }
        Ok(())
    }

    pub fn apply_update(&mut self, update: SceneUpdate) -> Result<()> {
        if update.meshes.len() != self.meshes.len() {
            bail!("Mesh style count does not match the scene");
        }
        if update.entities.is_some() && self.entities.is_empty() {
            self.entities = self.entity_descriptors();
        }
        if let Some(components) = &update.entities {
            if components.len() != self.entities.len() {
                bail!("Component count does not match the scene");
            }
            let mut ids = std::collections::HashSet::new();
            for c in components {
                c.validate()?;
                if !ids.insert(&c.id) || !self.entities.iter().any(|old| old.id == c.id) {
                    bail!("Unknown or duplicate component ID");
                }
            }
        }
        update.state.light.validate()?;
        validate_annotations(&update.state.annotations, &self.meshes)?;
        if let Some(section) = &update.state.section {
            section.validate(&self.meshes, &self.entity_descriptors())?;
        }
        for style in &update.meshes {
            if let Some(Some(label)) = &style.label {
                label.validate()?;
            }
        }
        for (mesh, style) in self.meshes.iter_mut().zip(update.meshes) {
            if !is_hex_color(&style.color) {
                bail!("invalid Mesh color");
            }
            mesh.color = style.color;
            mesh.opacity = style.opacity.clamp(0.05, 1.0);
            mesh.visible = style.visible;
            mesh.quality = style.quality;
            if let Some(label) = style.label {
                mesh.label = label;
            }
        }
        let mut state = update.state;
        state.selected = state.selected.min(self.meshes.len().saturating_sub(1));
        if state.focused_component_id.as_ref().is_some_and(|id| {
            !self
                .entity_descriptors()
                .iter()
                .any(|component| &component.id == id)
        }) {
            bail!("focused component is not in the scene");
        }
        state.frame.width = state.frame.width.clamp(240, 4096);
        state.frame.height = state.frame.height.clamp(240, 4096);
        if let Some(camera) = &mut state.camera {
            camera.fov = camera.fov.clamp(10.0, 100.0);
            camera.zoom = camera.zoom.clamp(0.01, 100.0);
            camera.orthographic_height = camera.orthographic_height.clamp(0.0001, 1_000_000.0);
        }
        validate_screen_strokes(&state.strokes)?;
        for group in &self.label_groups {
            group.validate(self.meshes.len())?;
        }
        if let Some(components) = update.entities {
            for c in components {
                let old = self.entities.iter_mut().find(|old| old.id == c.id).unwrap();
                old.state = c.state;
                if let Some(label) = c.label {
                    old.label = label.clone();
                    if let crate::component::ComponentSource::Mesh(index) = old.source {
                        let mesh = &mut self.meshes[index];
                        mesh.label = if label == mesh.name {
                            None
                        } else {
                            Some(MeshLabel {
                                text: label,
                                anchor: mesh.label.as_ref().and_then(|old| old.anchor),
                            })
                        };
                    }
                }
                old.position = c.position;
                old.size = c.size;
                old.visible = c.visible;
                old.opacity = c.opacity;
                if let crate::component::ComponentSource::Mesh(index) = old.source {
                    let mesh = &mut self.meshes[index];
                    mesh.translation = c.position.unwrap_or(mesh.translation);
                    mesh.visible = c.visible;
                    mesh.opacity = c.opacity;
                }
            }
        } else {
            for c in &mut self.entities {
                if let crate::component::ComponentSource::Mesh(index) = c.source {
                    c.visible = self.meshes[index].visible;
                    c.opacity = self.meshes[index].opacity;
                }
            }
        }
        for c in &mut self.entities {
            if let crate::component::ComponentSource::Mesh(index) = c.source {
                let mesh = &self.meshes[index];
                c.label = mesh
                    .label
                    .as_ref()
                    .map(|label| label.text.clone())
                    .unwrap_or_else(|| mesh.name.clone());
            }
        }
        self.schema = self.schema.max(if state.section.is_some() {
            7
        } else if self.entities.is_empty() {
            3
        } else {
            5
        });
        self.state = state;
        for mark in &self.state.annotations {
            self.meshes[mark.mesh].quality = MeshQuality::Raw;
        }
        Ok(())
    }

    pub fn full_text(&self, viewer_url: &str, image_url: &str) -> String {
        if let Some(collection) = &self.collection {
            let mut lines = vec![format!("Blind collection: {}", collection.title)];
            for (id, scene) in self.scene_entries() {
                let id = id.expect("collection scenes have IDs");
                lines.push(format!("\n{} ({id}):", scene.title));
                lines.extend(scene.meshes.iter().map(|mesh| format!("- {}", mesh.path)));
                lines.extend(
                    scene
                        .attachments
                        .iter()
                        .map(|attachment| format!("- {}", attachment.path)),
                );
            }
            lines.push(format!(
                "\nView (all scenes):\n{viewer_url}\n\nImage (all scenes):\n{image_url}"
            ));
            return lines.join("\n");
        }
        let paths = self
            .meshes
            .iter()
            .map(|mesh| format!("- {}", mesh.path))
            .collect::<Vec<_>>()
            .join("\n");
        let source = self
            .source
            .as_ref()
            .map(|s| format!("\nSource: {}@{} ({})\n", s.user, s.host, s.name))
            .unwrap_or_default();
        format!(
            "Blind scene\n{source}\nMeshes:\n{paths}\n\nView:\n{viewer_url}\n\nImage:\n{image_url}"
        )
    }
}

#[cfg(test)]
fn modified_nanos(metadata: &std::fs::Metadata) -> Option<u64> {
    let duration = metadata.modified().ok()?.duration_since(UNIX_EPOCH).ok()?;
    u64::try_from(duration.as_nanos()).ok()
}

#[cfg(all(test, unix))]
fn change_nanos(metadata: &std::fs::Metadata) -> Option<u64> {
    use std::os::unix::fs::MetadataExt;
    let seconds = u64::try_from(metadata.ctime()).ok()?;
    let nanos = u64::try_from(metadata.ctime_nsec()).ok()?;
    seconds.checked_mul(1_000_000_000)?.checked_add(nanos)
}

#[cfg(all(test, not(unix)))]
fn change_nanos(_metadata: &std::fs::Metadata) -> Option<u64> {
    None
}

pub(crate) fn validate_screen_strokes(strokes: &[ScreenStroke]) -> Result<()> {
    if strokes.len() > MAX_SCREEN_STROKES {
        bail!("a scene can contain at most {MAX_SCREEN_STROKES} screen strokes");
    }
    let mut total_points = 0_usize;
    for stroke in strokes {
        if stroke
            .label
            .as_ref()
            .is_some_and(|label| label.chars().count() > 120)
        {
            bail!("screen stroke label must contain at most 120 characters");
        }
        if !is_hex_color(&stroke.color) {
            bail!("invalid screen stroke color");
        }
        if !stroke.aspect.is_finite() || !(0.1..=10.0).contains(&stroke.aspect) {
            bail!("invalid screen stroke aspect ratio");
        }
        if !(2..=MAX_SCREEN_STROKE_POINTS).contains(&stroke.points.len()) {
            bail!("a screen stroke must contain between 2 and {MAX_SCREEN_STROKE_POINTS} points");
        }
        total_points = total_points
            .checked_add(stroke.points.len())
            .context("screen stroke point count overflow")?;
        if total_points > MAX_SCREEN_POINTS {
            bail!("a scene can contain at most {MAX_SCREEN_POINTS} screen stroke points");
        }
        if stroke
            .points
            .iter()
            .flatten()
            .any(|value| !value.is_finite() || !(0.0..=1.0).contains(value))
        {
            bail!("screen stroke points must be finite normalized coordinates");
        }
    }
    Ok(())
}

impl MeshFormat {
    pub fn from_path(path: &Path) -> Result<Self> {
        match path
            .extension()
            .and_then(|value| value.to_str())
            .map(str::to_ascii_lowercase)
            .as_deref()
        {
            Some("ply") => Ok(Self::Ply),
            Some("stl") => Ok(Self::Stl),
            Some("obj") => Ok(Self::Obj),
            Some("pts") => Ok(Self::Pts),
            _ => bail!(
                "{} is not a supported PLY, STL, OBJ, or PTS file",
                path.display()
            ),
        }
    }

    pub fn mime(self) -> &'static str {
        match self {
            Self::Ply => "application/vnd.ply",
            Self::Stl => "model/stl",
            Self::Obj => "model/obj",
            Self::Pts => "text/plain; charset=utf-8",
        }
    }
}

#[cfg(test)]
#[derive(Debug, Clone, Copy, thiserror::Error)]
#[error("scene source is gone")]
pub struct SceneGone;

#[cfg(test)]
pub async fn hash_file(path: &Path) -> Result<String> {
    let mut file = tokio::fs::File::open(path).await?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; 1024 * 1024];
    loop {
        let read = file.read(&mut buffer).await?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("sha256:{}", hex::encode(hasher.finalize())))
}

pub fn hash_bytes(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("sha256:{}", hex::encode(hasher.finalize()))
}

/// Parse a `#rrggbb` color into normalized sRGB channels.
pub(crate) fn parse_hex_color(value: &str) -> Option<[f32; 3]> {
    if !(value.len() == 7 && value.starts_with('#')) {
        return None;
    }
    let number = u32::from_str_radix(&value[1..], 16).ok()?;
    Some([
        ((number >> 16) & 255) as f32 / 255.0,
        ((number >> 8) & 255) as f32 / 255.0,
        (number & 255) as f32 / 255.0,
    ])
}

fn is_hex_color(value: &str) -> bool {
    parse_hex_color(value).is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn legacy_scene_accepts_component_adapter_updates() {
        let mut scene = SceneDescriptor::create(&[PathBuf::from("tests/fixtures/tetra.ply")], None)
            .await
            .unwrap();
        assert!(scene.entities.is_empty());
        let mut descriptors = serde_json::to_value(scene.entity_descriptors()).unwrap();
        let component = descriptors[0].as_object_mut().unwrap();
        component.retain(|key, _| {
            ["id", "position", "size", "visible", "opacity", "state"].contains(&key.as_str())
        });
        component.insert("position".into(), serde_json::json!([4., 5., 6.]));
        let update: SceneUpdate = serde_json::from_value(serde_json::json!({
            "meshes":[{"color":"#abcdef","opacity":1.,"visible":true,"quality":"raw"}],
            "state":scene.state,"components":descriptors
        }))
        .unwrap();
        scene.apply_update(update).unwrap();
        assert_eq!(scene.schema, 5);
        assert_eq!(scene.entities[0].id, "mesh-0");
        assert_eq!(scene.meshes[0].translation, [4., 5., 6.]);
    }

    #[tokio::test]
    async fn entity_renames_round_trip_without_changing_sources() {
        let mut scene = SceneDescriptor::create(&[PathBuf::from("tests/fixtures/tetra.ply")], None)
            .await
            .unwrap();
        scene.entities = scene.entity_descriptors();
        scene.attachments.push(SceneAttachment {
            member: None,
            id: "report".into(),
            path: "report.txt".into(),
            label: "Report".into(),
            byte_size: None,
            revision: None,
            unavailable: Some("fixture".into()),
        });
        scene.entities.push(crate::component::SceneEntity {
            id: "report".into(),
            component: crate::component::ComponentKind::Text,
            source: crate::component::ComponentSource::Attachment(0),
            renderer: None,
            label: "Report".into(),
            group: None,
            position: Some([4.0, 0.0, 0.0]),
            size: Some([40.0, 30.0]),
            visible: true,
            opacity: 1.0,
            state: None,
        });
        let update = |scene: &SceneDescriptor, mesh_label: &str, report_label: &str| {
            serde_json::from_value::<SceneUpdate>(serde_json::json!({
                "meshes": [{"color":scene.meshes[0].color,"opacity":1.0,"visible":true,"quality":"raw"}],
                "entities": [
                    {"id":"mesh-0","label":mesh_label,"position":[0,0,0],"size":null,"visible":true,"opacity":1.0},
                    {"id":"report","label":report_label,"position":[4,0,0],"size":[40,30],"visible":true,"opacity":1.0}
                ],
                "state":scene.state
            }))
            .unwrap()
        };
        let original_name = scene.meshes[0].name.clone();
        scene
            .apply_update(update(&scene, "边缘复核", "检验报告"))
            .unwrap();
        assert_eq!(scene.meshes[0].label.as_ref().unwrap().text, "边缘复核");
        assert_eq!(scene.entities[0].label, "边缘复核");
        assert_eq!(scene.entities[1].label, "检验报告");
        assert_eq!(
            scene.attachments[0].label, "Report",
            "source label stays immutable"
        );
        let mut reopened: SceneDescriptor =
            serde_json::from_slice(&serde_json::to_vec(&scene).unwrap()).unwrap();
        assert_eq!(reopened.entities[1].label, "检验报告");
        reopened
            .apply_update(update(&reopened, &original_name, "Report"))
            .unwrap();
        assert!(reopened.meshes[0].label.is_none());
        assert_eq!(reopened.entities[0].label, original_name);
        assert!(
            reopened
                .apply_update(update(&reopened, " ", "Report"))
                .is_err()
        );
    }

    #[tokio::test]
    async fn section_share_binds_a_plane_to_its_source_entity_and_revision() {
        let mut scene = SceneDescriptor::create(&[PathBuf::from("tests/fixtures/tetra.ply")], None)
            .await
            .unwrap();
        let section = SectionState {
            entity_id: scene.entity_descriptors()[0].id.clone(),
            mesh: 0,
            revision: scene.meshes[0].revision.clone(),
            origin: [0.0, 0.0, 0.0],
            normal: [0.0, 0.0, 1.0],
            axis: [1.0, 0.0, 0.0],
            radius: 1.0,
            offset: 0.0,
            fit: false,
            pan: [0.0, 0.0],
            targets: Vec::new(),
            panel_size: None,
            measurements: Vec::new(),
        };
        let mut state = scene.state.clone();
        state.section = Some(section.clone());
        scene
            .apply_update(SceneUpdate {
                entities: None,
                meshes: vec![MeshStyleUpdate {
                    color: scene.meshes[0].color.clone(),
                    opacity: 1.0,
                    visible: true,
                    quality: MeshQuality::Raw,
                    label: None,
                }],
                state,
            })
            .unwrap();
        let reopened: SceneDescriptor =
            serde_json::from_slice(&serde_json::to_vec(&scene).unwrap()).unwrap();
        assert_eq!(reopened.state.section, Some(section.clone()));
        assert_eq!(reopened.schema, 7);
        let mut measured = section.clone();
        measured.panel_size = Some([560.0, 430.0]);
        measured.measurements = vec![SectionMeasurement {
            a: [0.0, 0.0],
            b: [1.5, 2.0],
            opposite: Some([1.5, 2.4]),
        }];
        assert!(
            measured
                .validate(&scene.meshes, &scene.entity_descriptors())
                .is_ok()
        );
        assert_eq!(
            serde_json::from_slice::<SectionState>(&serde_json::to_vec(&measured).unwrap())
                .unwrap(),
            measured
        );
        measured.measurements[0].b[0] = f64::INFINITY;
        assert!(
            measured
                .validate(&scene.meshes, &scene.entity_descriptors())
                .is_err()
        );
        let mut wrong = section.clone();
        wrong.entity_id = "another-mesh".into();
        assert!(
            wrong
                .validate(&scene.meshes, &scene.entity_descriptors())
                .is_err()
        );
        let pair = SceneDescriptor::create(
            &[
                PathBuf::from("tests/fixtures/tetra.ply"),
                PathBuf::from("tests/fixtures/tetra.ply"),
            ],
            None,
        )
        .await
        .unwrap();
        let mut combined = section.clone();
        combined.targets = pair
            .meshes
            .iter()
            .enumerate()
            .map(|(mesh, source)| SectionTarget {
                entity_id: pair.entity_descriptors()[mesh].id.clone(),
                mesh,
                revision: source.revision.clone(),
            })
            .collect();
        assert!(
            combined
                .validate(&pair.meshes, &pair.entity_descriptors())
                .is_ok()
        );
        combined.targets.remove(0);
        assert!(
            combined
                .validate(&pair.meshes, &pair.entity_descriptors())
                .is_ok()
        );
        combined.targets[0].revision = "stale".into();
        assert!(
            combined
                .validate(&pair.meshes, &pair.entity_descriptors())
                .is_err()
        );
        wrong = section;
        wrong.revision = "another-revision".into();
        assert!(
            wrong
                .validate(&scene.meshes, &scene.entity_descriptors())
                .is_err()
        );
    }

    #[tokio::test]
    async fn source_change_invalidates_the_whole_scene() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("mesh.ply");
        std::fs::write(&path, include_bytes!("../tests/fixtures/tetra.ply")).unwrap();
        let scene = SceneDescriptor::create(std::slice::from_ref(&path), None)
            .await
            .unwrap();
        scene.validate().await.unwrap();
        std::fs::write(&path, b"changed").unwrap();
        assert!(scene.validate().await.is_err());
    }

    #[tokio::test]
    async fn unsupported_formats_are_rejected() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("mesh.glb");
        std::fs::write(&path, b"glTF").unwrap();
        let error = SceneDescriptor::create(&[path], None).await.unwrap_err();
        assert!(
            error
                .to_string()
                .contains("supported PLY, STL, OBJ, or PTS")
        );
    }

    #[tokio::test]
    async fn surface_annotations_share_frozen_coordinates_and_validate_ownership() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("mesh.ply");
        std::fs::write(&path, include_bytes!("../tests/fixtures/tetra.ply")).unwrap();
        let mut scene = SceneDescriptor::create(&[path], None).await.unwrap();
        let mark = SurfaceAnnotation {
            id: "surface-1".into(),
            mesh: 0,
            revision: scene.meshes[0].revision.clone(),
            kind: SurfaceAnnotationKind::Line,
            label: "Contour".into(),
            color: "#ff6b5e".into(),
            visible: true,
            closed: false,
            points: vec![[0.123456789012345, 0.2, 0.3], [0.8, 0.2, 0.3]],
            normals: vec![[0.0, 0.0, 1.0]; 2],
            controls: vec![0, 1],
        };
        let mut state = scene.state.clone();
        state.annotations.push(mark.clone());
        scene
            .apply_update(SceneUpdate {
                entities: None,
                meshes: scene
                    .meshes
                    .iter()
                    .map(|m| MeshStyleUpdate {
                        color: m.color.clone(),
                        opacity: m.opacity,
                        visible: m.visible,
                        quality: MeshQuality::Lod,
                        label: None,
                    })
                    .collect(),
                state,
            })
            .unwrap();
        assert_eq!(scene.meshes[0].quality, MeshQuality::Raw);
        let reopened: SceneDescriptor =
            serde_json::from_slice(&serde_json::to_vec(&scene).unwrap()).unwrap();
        assert_eq!(reopened.state.annotations, vec![mark.clone()]);
        let mut bad = mark.clone();
        bad.mesh = 99;
        assert!(validate_annotations(&[bad], &scene.meshes).is_err());
        let mut bad = mark.clone();
        bad.revision = "other-source".into();
        assert!(validate_annotations(&[bad], &scene.meshes).is_err());
        let mut bad = mark.clone();
        bad.points[0][0] = f64::NAN;
        assert!(validate_annotations(&[bad], &scene.meshes).is_err());
        let mut bad = mark.clone();
        bad.controls = vec![0, 2];
        assert!(validate_annotations(&[bad], &scene.meshes).is_err());
        assert!(validate_annotations(&[mark.clone(), mark], &scene.meshes).is_err());
    }

    #[test]
    fn legacy_view_state_defaults_to_no_screen_strokes() {
        let value = serde_json::json!({
            "selected": 0,
            "shading": "smooth",
            "projection": "perspective",
            "background": "dark",
            "axes": true,
            "frame": { "width": 1200, "height": 900 },
            "camera": null
        });
        let state: ViewState = serde_json::from_value(value).unwrap();
        assert!(state.strokes.is_empty());
        assert!(state.annotations.is_empty());
    }

    #[tokio::test]
    async fn screen_stroke_payloads_are_bounded_and_validated() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("mesh.ply");
        std::fs::write(&path, include_bytes!("../tests/fixtures/tetra.ply")).unwrap();
        let mut scene = SceneDescriptor::create(&[path], None).await.unwrap();
        let mut state = scene.state.clone();
        state.strokes.push(ScreenStroke {
            label: Some("需要检查".into()),
            color: "#ff6b5e".into(),
            aspect: 1.0,
            points: vec![[0.1, 0.2], [0.4, 0.6]],
        });
        scene
            .apply_update(SceneUpdate {
                entities: None,
                meshes: scene
                    .meshes
                    .iter()
                    .map(|mesh| MeshStyleUpdate {
                        color: mesh.color.clone(),
                        opacity: mesh.opacity,
                        visible: mesh.visible,
                        quality: MeshQuality::Raw,
                        label: None,
                    })
                    .collect(),
                state,
            })
            .unwrap();
        assert_eq!(scene.schema, 3);
        assert_eq!(scene.state.strokes.len(), 1);
        let saved: ViewState =
            serde_json::from_value(serde_json::to_value(&scene.state).unwrap()).unwrap();
        assert_eq!(saved.strokes[0].label.as_deref(), Some("需要检查"));
        let mut oversized = saved.strokes.clone();
        oversized[0].label = Some("字".repeat(121));
        assert!(validate_screen_strokes(&oversized).is_err());
        assert_eq!(scene.meshes[0].quality, MeshQuality::Raw);

        let mut invalid = scene.state.clone();
        invalid.strokes[0].points[0][0] = f32::NAN;
        assert!(
            scene
                .apply_update(SceneUpdate {
                    entities: None,
                    meshes: scene
                        .meshes
                        .iter()
                        .map(|mesh| MeshStyleUpdate {
                            color: mesh.color.clone(),
                            opacity: mesh.opacity,
                            visible: mesh.visible,
                            quality: mesh.quality,
                            label: None,
                        })
                        .collect(),
                    state: invalid,
                })
                .is_err()
        );
    }

    #[test]
    fn legacy_mesh_quality_defaults_to_lod() {
        let mesh: MeshRef = serde_json::from_value(serde_json::json!({
            "path": "/tmp/legacy.ply",
            "name": "legacy.ply",
            "format": "ply",
            "revision": "sha256:legacy",
            "byte_size": 42,
            "color": "#8fa9c9",
            "opacity": 1.0,
            "visible": true
        }))
        .unwrap();
        assert_eq!(mesh.quality, MeshQuality::Lod);
        assert_eq!(mesh.modified_ns, None);
        assert_eq!(mesh.change_ns, None);
    }

    #[tokio::test]
    async fn scenes_accept_more_than_sixty_four_meshes() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("mesh.ply");
        std::fs::write(&path, include_bytes!("../tests/fixtures/tetra.ply")).unwrap();
        let paths = vec![path; 65];
        let scene = SceneDescriptor::create(&paths, None).await.unwrap();
        assert_eq!(scene.meshes.len(), 65);
        assert!(scene.meshes.iter().all(|mesh| mesh.modified_ns.is_some()));
        #[cfg(unix)]
        assert!(scene.meshes.iter().all(|mesh| mesh.change_ns.is_some()));
    }

    #[tokio::test]
    async fn mesh_labels_survive_sharing_and_legacy_updates_and_can_be_removed() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("mesh.ply");
        std::fs::write(&path, include_bytes!("../tests/fixtures/tetra.ply")).unwrap();
        let mut scene = SceneDescriptor::create(&[path], None).await.unwrap();
        let label = MeshLabel {
            text: "供体 A · 真实牙冠".into(),
            anchor: Some([0.1, 0.2, 0.3]),
        };
        scene.set_labels(vec![Some(label.clone())]).unwrap();
        let codec = crate::token::TokenCodec::new([17; 32]);
        let token = codec.seal(&scene).unwrap();
        let mut reopened = codec.open(&token).unwrap().scene;
        assert_eq!(reopened.meshes[0].label, Some(label.clone()));

        let mut payload = serde_json::json!({
            "meshes": [{ "color": "#8fa9c9", "opacity": 1.0, "visible": true }],
            "state": reopened.state
        });
        reopened
            .apply_update(serde_json::from_value(payload.clone()).unwrap())
            .unwrap();
        assert_eq!(reopened.meshes[0].label, Some(label));
        payload["meshes"][0]["label"] = serde_json::Value::Null;
        reopened
            .apply_update(serde_json::from_value(payload.clone()).unwrap())
            .unwrap();
        assert_eq!(reopened.meshes[0].label, None);
        payload["meshes"][0]["label"] = serde_json::json!({"text": "生成结果"});
        reopened
            .apply_update(serde_json::from_value(payload).unwrap())
            .unwrap();
        assert_eq!(reopened.meshes[0].label.as_ref().unwrap().text, "生成结果");
        assert_eq!(reopened.meshes[0].label.as_ref().unwrap().anchor, None);
    }

    #[tokio::test]
    async fn grouped_labels_survive_sharing_and_validate_members() {
        let directory = tempfile::tempdir().unwrap();
        let first = directory.path().join("first.ply");
        let second = directory.path().join("second.ply");
        std::fs::write(&first, include_bytes!("../tests/fixtures/tetra.ply")).unwrap();
        std::fs::write(&second, include_bytes!("../tests/fixtures/tetra.ply")).unwrap();
        let mut scene = SceneDescriptor::create(&[first, second], None)
            .await
            .unwrap();
        let group = MeshLabelGroup {
            text: "参考牙".into(),
            meshes: vec![0, 1],
        };
        scene.set_label_groups(vec![group.clone()]).unwrap();

        let codec = crate::token::TokenCodec::new([19; 32]);
        let reopened = codec.open(&codec.seal(&scene).unwrap()).unwrap().scene;
        assert_eq!(reopened.label_groups, [group]);
        for invalid in [vec![0], vec![0, 0], vec![0, 2]] {
            assert!(
                MeshLabelGroup {
                    text: "无效".into(),
                    meshes: invalid,
                }
                .validate(2)
                .is_err()
            );
        }
    }

    #[test]
    fn legacy_scenes_default_to_no_grouped_labels() {
        let value = serde_json::json!({
            "schema": 2,
            "title": "legacy",
            "created_at": 1,
            "meshes": [],
            "state": ViewState::default()
        });
        let scene: SceneDescriptor = serde_json::from_value(value).unwrap();
        assert!(scene.label_groups.is_empty());
    }

    #[tokio::test]
    async fn persisted_collection_keeps_first_scene_and_component_alias() {
        let path = PathBuf::from("tests/fixtures/tetra.ply");
        let mut first = SceneDescriptor::create(std::slice::from_ref(&path), Some("First".into()))
            .await
            .unwrap();
        first.entities = first.entity_descriptors();
        let second = SceneDescriptor::create(&[path], Some("Second".into()))
            .await
            .unwrap();
        let mut saved = serde_json::to_value(&first).unwrap();
        let entities = saved.as_object_mut().unwrap().remove("entities").unwrap();
        saved["components"] = entities;
        saved["collection"] = serde_json::json!({
            "title": "Review",
            "first_id": "first",
            "active_scene_id": "second",
            "scenes": [{"id": "second", "scene": second}]
        });

        let opened: SceneDescriptor = serde_json::from_value(saved).unwrap();
        let entries = opened.scene_entries().collect::<Vec<_>>();
        assert_eq!(
            entries.iter().map(|(id, _)| *id).collect::<Vec<_>>(),
            [Some("first"), Some("second")]
        );
        assert_eq!(opened.scene_by_id("first").unwrap().title, "First");
        assert_eq!(opened.scene_by_id("second").unwrap().title, "Second");
        assert_eq!(
            opened
                .scene_by_id("first")
                .unwrap()
                .entity_descriptors()
                .len(),
            1
        );
        assert_eq!(
            opened
                .scene_by_id("second")
                .unwrap()
                .entity_descriptors()
                .len(),
            1
        );
    }

    #[test]
    fn mesh_labels_reject_blank_oversized_and_nonfinite_annotations() {
        for text in ["  \n".to_owned(), "牙".repeat(MAX_MESH_LABEL_CHARS + 1)] {
            assert!(MeshLabel { text, anchor: None }.validate().is_err());
        }
        assert!(
            MeshLabel {
                text: "牙".repeat(MAX_MESH_LABEL_CHARS),
                anchor: None
            }
            .validate()
            .is_ok()
        );
        assert!(
            MeshLabel {
                text: "A".into(),
                anchor: Some([f32::NAN, 0.0, 0.0])
            }
            .validate()
            .is_err()
        );
    }
}
