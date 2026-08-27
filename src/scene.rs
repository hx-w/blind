use std::{
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::io::AsyncReadExt;

pub const PALETTE: [&str; 6] = [
    "#8fa9c9", "#8ca49c", "#b2a4ad", "#bf8078", "#8f8bb2", "#b7b3aa",
];
pub const MAX_SCREEN_STROKES: usize = 64;
pub const MAX_SCREEN_STROKE_POINTS: usize = 512;
pub const MAX_SCREEN_POINTS: usize = 4_096;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SceneDescriptor {
    pub schema: u8,
    pub title: String,
    pub created_at: u64,
    pub meshes: Vec<MeshRef>,
    pub state: ViewState,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MeshRef {
    pub path: String,
    pub name: String,
    pub format: MeshFormat,
    pub revision: String,
    pub byte_size: u64,
    pub color: String,
    pub opacity: f32,
    pub visible: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum MeshFormat {
    Ply,
    Stl,
    Obj,
    Pts,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ViewState {
    pub selected: usize,
    pub shading: Shading,
    pub projection: Projection,
    pub background: Background,
    pub axes: bool,
    pub frame: Frame,
    pub camera: Option<CameraState>,
    #[serde(default)]
    pub strokes: Vec<ScreenStroke>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScreenStroke {
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
    pub meshes: Vec<MeshStyleUpdate>,
    pub state: ViewState,
}

#[derive(Debug, Clone, Deserialize)]
pub struct MeshStyleUpdate {
    pub color: String,
    pub opacity: f32,
    pub visible: bool,
}

impl Default for ViewState {
    fn default() -> Self {
        Self {
            selected: 0,
            shading: Shading::Smooth,
            projection: Projection::Perspective,
            background: Background::Dark,
            axes: true,
            frame: Frame {
                width: 1200,
                height: 900,
            },
            camera: None,
            strokes: Vec::new(),
        }
    }
}

impl SceneDescriptor {
    pub async fn create(paths: &[PathBuf], title: Option<String>) -> Result<Self> {
        if paths.is_empty() {
            bail!("at least one Mesh path is required");
        }
        if paths.len() > 64 {
            bail!("a scene can contain at most 64 Meshes");
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
                byte_size: metadata.len(),
                color: PALETTE[index % PALETTE.len()].to_string(),
                opacity: 1.0,
                visible: true,
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
            schema: 2,
            title,
            created_at: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs(),
            meshes,
            state: ViewState::default(),
        })
    }

    /// Cheap staleness gate: every source file must still exist with the recorded size.
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
        for (mesh, style) in self.meshes.iter_mut().zip(update.meshes) {
            if !is_hex_color(&style.color) {
                bail!("invalid Mesh color");
            }
            mesh.color = style.color;
            mesh.opacity = style.opacity.clamp(0.05, 1.0);
            mesh.visible = style.visible;
        }
        let mut state = update.state;
        state.selected = state.selected.min(self.meshes.len().saturating_sub(1));
        state.frame.width = state.frame.width.clamp(240, 4096);
        state.frame.height = state.frame.height.clamp(240, 4096);
        if let Some(camera) = &mut state.camera {
            camera.fov = camera.fov.clamp(10.0, 100.0);
            camera.zoom = camera.zoom.clamp(0.01, 100.0);
            camera.orthographic_height = camera.orthographic_height.clamp(0.0001, 1_000_000.0);
        }
        validate_screen_strokes(&state.strokes)?;
        self.schema = self.schema.max(2);
        self.state = state;
        Ok(())
    }

    pub fn full_text(&self, viewer_url: &str, image_url: &str) -> String {
        let paths = self
            .meshes
            .iter()
            .map(|mesh| format!("- {}", mesh.path))
            .collect::<Vec<_>>()
            .join("\n");
        format!("Blind scene\n\nMeshes:\n{paths}\n\nView:\n{viewer_url}\n\nImage:\n{image_url}")
    }
}

fn validate_screen_strokes(strokes: &[ScreenStroke]) -> Result<()> {
    if strokes.len() > MAX_SCREEN_STROKES {
        bail!("a scene can contain at most {MAX_SCREEN_STROKES} screen strokes");
    }
    let mut total_points = 0_usize;
    for stroke in strokes {
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

#[derive(Debug, Clone, Copy, thiserror::Error)]
#[error("scene source is gone")]
pub struct SceneGone;

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
    }

    #[tokio::test]
    async fn screen_stroke_payloads_are_bounded_and_validated() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("mesh.ply");
        std::fs::write(&path, include_bytes!("../tests/fixtures/tetra.ply")).unwrap();
        let mut scene = SceneDescriptor::create(&[path], None).await.unwrap();
        let mut state = scene.state.clone();
        state.strokes.push(ScreenStroke {
            color: "#ff6b5e".into(),
            aspect: 1.0,
            points: vec![[0.1, 0.2], [0.4, 0.6]],
        });
        scene
            .apply_update(SceneUpdate {
                meshes: scene
                    .meshes
                    .iter()
                    .map(|mesh| MeshStyleUpdate {
                        color: mesh.color.clone(),
                        opacity: mesh.opacity,
                        visible: mesh.visible,
                    })
                    .collect(),
                state,
            })
            .unwrap();
        assert_eq!(scene.schema, 2);
        assert_eq!(scene.state.strokes.len(), 1);

        let mut invalid = scene.state.clone();
        invalid.strokes[0].points[0][0] = f32::NAN;
        assert!(
            scene
                .apply_update(SceneUpdate {
                    meshes: scene
                        .meshes
                        .iter()
                        .map(|mesh| MeshStyleUpdate {
                            color: mesh.color.clone(),
                            opacity: mesh.opacity,
                            visible: mesh.visible,
                        })
                        .collect(),
                    state: invalid,
                })
                .is_err()
        );
    }
}
