//! Display contracts, independent of source transport and renderer implementation.
use anyhow::{Result, bail, ensure};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RendererBinding {
    #[serde(default)]
    pub frame_origins: Vec<String>,
    pub plugin: String,
    pub revision: String,
    #[serde(default)]
    pub capabilities: RendererCapabilities,
    pub name: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct RendererCapabilities {
    pub presentations: Vec<String>,
    pub host_space: HostSpace,
    pub operations: Vec<String>,
    pub movable: bool,
    pub resizable: bool,
}
impl Default for RendererCapabilities {
    fn default() -> Self {
        Self {
            presentations: vec!["spatial".into(), "focus".into()],
            host_space: HostSpace::Planar,
            operations: [
                "scene.read",
                "scene.write",
                "ui.write",
                "content.read",
                "content.write",
                "annotation.write",
                "section.write",
            ]
            .into_iter()
            .map(String::from)
            .collect(),
            movable: true,
            resizable: false,
        }
    }
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HostSpace {
    #[default]
    Planar,
    Spatial,
}

pub const OPERATION_GRANTS: &[&str] = &[
    "scene.read",
    "scene.write",
    "ui.write",
    "content.read",
    "content.write",
    "annotation.write",
    "section.write",
    "share.create",
    "resource.open",
    "collection.write",
    "content.read-scene",
];

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Placement {
    #[default]
    World,
    Panel,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub enum ComponentKind {
    Mesh,
    Points,
    Text,
    Markdown,
    Json,
    Html,
    Image,
    Mermaid,
    Dot,
    Plugin(String),
}
impl TryFrom<String> for ComponentKind {
    type Error = anyhow::Error;
    fn try_from(value: String) -> Result<Self> {
        Ok(match value.as_str() {
            "mesh" => Self::Mesh,
            "points" => Self::Points,
            "text" => Self::Text,
            "markdown" => Self::Markdown,
            "json" => Self::Json,
            "html" => Self::Html,
            "image" => Self::Image,
            "mermaid" => Self::Mermaid,
            "dot" => Self::Dot,
            _ => {
                ensure!(
                    value
                        .split_once(':')
                        .is_some_and(|(a, b)| valid_name(a) && valid_name(b)),
                    "component must be a built-in or plugin:name"
                );
                Self::Plugin(value)
            }
        })
    }
}
impl From<ComponentKind> for String {
    fn from(kind: ComponentKind) -> Self {
        match kind {
            ComponentKind::Mesh => "mesh".into(),
            ComponentKind::Points => "points".into(),
            ComponentKind::Text => "text".into(),
            ComponentKind::Markdown => "markdown".into(),
            ComponentKind::Json => "json".into(),
            ComponentKind::Html => "html".into(),
            ComponentKind::Image => "image".into(),
            ComponentKind::Mermaid => "mermaid".into(),
            ComponentKind::Dot => "dot".into(),
            ComponentKind::Plugin(s) => s,
        }
    }
}
pub fn valid_name(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 64
        && s.bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, b'-' | b'_'))
}
impl ComponentKind {
    pub fn infer(path: &str) -> Result<Self> {
        let name = path.rsplit('/').next().unwrap_or(path).to_ascii_lowercase();
        Ok(match name.rsplit('.').next().unwrap_or("") {
            "ply" | "stl" | "obj" => Self::Mesh,
            "pts" => Self::Points,
            "txt" | "log" | "jsonl" | "csv" => Self::Text,
            "md" | "markdown" => Self::Markdown,
            "json" => Self::Json,
            "html" | "htm" => Self::Html,
            "png" | "jpg" | "jpeg" | "webp" | "gif" => Self::Image,
            "mmd" | "mermaid" => Self::Mermaid,
            "dot" | "gv" => Self::Dot,
            _ => bail!(
                "Cannot choose a component for {name}; use --component INDEX=mesh|points|text|markdown|json|html|image|mermaid|dot|PLUGIN:NAME"
            ),
        })
    }
    pub fn geometry(&self) -> bool {
        matches!(self, Self::Mesh | Self::Points)
    }
    /// Plugin state remains opaque; native consumers have a concrete reading/marks contract.
    pub fn validate_native_state(&self, state: Option<&serde_json::Value>) -> Result<()> {
        if !matches!(
            self,
            Self::Text | Self::Markdown | Self::Json | Self::Image | Self::Mermaid | Self::Dot
        ) {
            return Ok(());
        }
        let Some(state) = state else {
            return Ok(());
        };
        let state = state
            .as_object()
            .ok_or_else(|| anyhow::anyhow!("invalid native component state: expected object"))?;
        if let Some(value) = state.get("presentation") {
            ensure!(
                matches!(value.as_str(), Some("spatial" | "focus" | "fullscreen")),
                "invalid native presentation"
            );
        }
        if let Some(value) = state.get("reading") {
            validate_content_anchor(value)?;
        }
        if let Some(value) = state.get("selection") {
            ensure!(value.is_boolean(), "invalid native selection");
        }
        if let Some(value) = state.get("zoom") {
            ensure!(
                value.as_f64().is_some_and(|n| n.is_finite() && n > 0.),
                "invalid native zoom"
            );
        }
        if let Some(value) = state.get("expanded") {
            ensure!(
                value
                    .as_array()
                    .is_some_and(|ids| ids.iter().all(|id| id.is_string())),
                "invalid native expanded targets"
            );
        }
        if let Some(value) = state.get("layer") {
            ensure!(value.is_string(), "invalid native layer");
        }
        if let Some(value) = state.get("marks") {
            let marks = value
                .as_array()
                .ok_or_else(|| anyhow::anyhow!("invalid native marks: expected array"))?;
            for mark in marks {
                let mark = mark
                    .as_object()
                    .ok_or_else(|| anyhow::anyhow!("invalid native mark: expected object"))?;
                ensure!(
                    mark.get("id")
                        .and_then(|v| v.as_str())
                        .is_some_and(|id| !id.is_empty()),
                    "invalid native mark ID"
                );
                ensure!(
                    mark.get("label").is_some_and(|v| v.is_string()),
                    "invalid native mark label"
                );
                ensure!(
                    mark.get("color")
                        .and_then(|v| v.as_str())
                        .is_some_and(|color| {
                            color.len() == 7
                                && color.starts_with('#')
                                && color.as_bytes()[1..].iter().all(u8::is_ascii_hexdigit)
                        }),
                    "invalid native mark color"
                );
                let count = match mark.get("kind").and_then(|v| v.as_str()) {
                    Some("point") => 1,
                    Some("line") => 2,
                    _ => bail!("invalid native mark kind"),
                };
                let anchors = mark
                    .get("anchors")
                    .and_then(|v| v.as_array())
                    .ok_or_else(|| anyhow::anyhow!("invalid native mark anchors"))?;
                ensure!(anchors.len() == count, "invalid native mark anchor count");
                for anchor in anchors {
                    validate_content_anchor(anchor)?;
                    ensure!(
                        anchor["source"] == anchors[0]["source"],
                        "native mark anchors must share a source revision"
                    );
                }
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DisplayOptions {
    pub component: Option<ComponentKind>,
    /// Explicit geometry fidelity; omission retains the scene's LOD default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quality: Option<super::MeshQuality>,
    #[serde(default)]
    pub placement: Placement,
    /// Exact ZIP member path. Extraction belongs to the source layer, not renderers.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub member: Option<String>,
    pub group: Option<String>,
    pub position: Option<[f32; 3]>,
    /// World-space width and height for a surface component.
    pub size: Option<[f32; 2]>,
}
impl DisplayOptions {
    pub fn validate(&self) -> Result<()> {
        if let Some(kind) = &self.component {
            self.validate_quality(kind)?;
        }
        ensure!(
            self.placement != Placement::Panel
                || !self.component.as_ref().is_some_and(ComponentKind::geometry),
            "geometry cannot use panel placement"
        );
        if let Some(member) = &self.member {
            validate_member(member)?;
        }
        if let Some(group) = &self.group {
            validate_label(group)?;
        }
        if let Some(p) = self.position {
            ensure!(
                p.iter().all(|n| n.is_finite() && n.abs() <= 1_000_000.),
                "invalid component position"
            );
        }
        if let Some(s) = self.size {
            ensure!(
                s.iter().all(|n| n.is_finite() && *n >= 1. && *n <= 10_000.),
                "component size must be between 1 and 10000"
            );
        }
        Ok(())
    }
    pub fn validate_quality(&self, kind: &ComponentKind) -> Result<()> {
        ensure!(
            self.quality.is_none() || kind.geometry(),
            "quality applies only to mesh or points geometry"
        );
        Ok(())
    }
}
fn validate_label(label: &str) -> Result<()> {
    ensure!(
        !label.trim().is_empty() && label.chars().count() <= 120,
        "component label/group must contain 1–120 characters"
    );
    Ok(())
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "index", rename_all = "lowercase")]
pub enum ComponentSource {
    Mesh(usize),
    Attachment(usize),
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SceneEntity {
    pub id: String,
    pub component: ComponentKind,
    #[serde(default)]
    pub placement: Placement,
    pub source: ComponentSource,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub renderer: Option<crate::scene::component::RendererBinding>,
    pub label: String,
    pub group: Option<String>,
    pub position: Option<[f32; 3]>,
    pub size: Option<[f32; 2]>,
    pub visible: bool,
    pub opacity: f32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state: Option<serde_json::Value>,
}
/// Only mutable presentation fields are accepted. Sources/types cannot be replaced by viewers.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EntityUpdate {
    pub id: String,
    #[serde(default)]
    pub placement: Placement,
    #[serde(default)]
    pub label: Option<String>,
    pub position: Option<[f32; 3]>,
    pub size: Option<[f32; 2]>,
    pub visible: bool,
    pub opacity: f32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state: Option<serde_json::Value>,
}
impl EntityUpdate {
    pub fn validate(&self) -> Result<()> {
        if let Some(state) = &self.state {
            ensure!(
                serde_json::to_vec(state)?.len() <= 65536,
                "component state exceeds 64 KiB"
            );
        }
        if let Some(label) = &self.label {
            validate_label(label)?;
        }
        DisplayOptions {
            placement: self.placement,
            position: self.position,
            size: self.size,
            ..Default::default()
        }
        .validate()?;
        ensure!(
            self.opacity.is_finite() && (0.0..=1.0).contains(&self.opacity),
            "invalid component opacity"
        );
        Ok(())
    }
}
fn validate_content_anchor(value: &serde_json::Value) -> Result<()> {
    let anchor = value
        .as_object()
        .ok_or_else(|| anyhow::anyhow!("invalid native anchor: expected object"))?;
    for key in ["source", "target"] {
        ensure!(
            anchor
                .get(key)
                .and_then(|v| v.as_str())
                .is_some_and(|s| !s.is_empty()),
            "invalid native anchor {key}"
        );
    }
    for key in ["offset", "x", "y"] {
        ensure!(
            anchor
                .get(key)
                .and_then(|v| v.as_f64())
                .is_some_and(|n| n.is_finite() && (key != "offset" || n >= 0.)),
            "invalid native anchor {key}"
        );
    }
    if let Some(value) = anchor.get("viewport") {
        ensure!(
            value.as_array().is_some_and(
                |v| v.len() == 2 && v.iter().all(|n| n.as_f64().is_some_and(f64::is_finite))
            ),
            "invalid native anchor viewport"
        );
    }
    Ok(())
}

pub fn validate_member(name: &str) -> Result<()> {
    ensure!(
        !name.is_empty()
            && name.len() <= 1024
            && !name.contains('\\')
            && !name.chars().any(char::is_control)
            && name
                .split('/')
                .all(|part| !part.is_empty() && part != "." && part != ".."),
        "invalid ZIP member path"
    );
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn inference_is_predictable() {
        for (path, kind) in [
            ("UPPER.PLY", ComponentKind::Mesh),
            ("margin.pts", ComponentKind::Points),
            ("run.log", ComponentKind::Text),
            ("README.MD", ComponentKind::Markdown),
            ("notes.markdown", ComponentKind::Markdown),
            ("execution.json", ComponentKind::Json),
            ("a.trace.json", ComponentKind::Json),
            ("tracing.json", ComponentKind::Json),
            ("report.html", ComponentKind::Html),
            ("image.png", ComponentKind::Image),
            ("architecture.MMD", ComponentKind::Mermaid),
            ("architecture.mermaid", ComponentKind::Mermaid),
            ("architecture.dot", ComponentKind::Dot),
            ("architecture.gv", ComponentKind::Dot),
        ] {
            assert_eq!(ComponentKind::infer(path).unwrap(), kind);
        }
        assert!(ComponentKind::infer("file.bin").is_err());
        let kind = ComponentKind::try_from("markdown".to_owned()).unwrap();
        assert!(!kind.geometry());
        assert_eq!(serde_json::to_string(&kind).unwrap(), "\"markdown\"");
    }
    #[test]
    fn reject_invalid_layout() {
        assert!(
            DisplayOptions {
                position: Some([f32::NAN, 0., 0.]),
                ..Default::default()
            }
            .validate()
            .is_err()
        );
        assert!(
            DisplayOptions {
                size: Some([0., 40.]),
                ..Default::default()
            }
            .validate()
            .is_err()
        );
        assert!(serde_json::from_str::<DisplayOptions>(r#"{"componnet":"trace"}"#).is_err());
    }
}
