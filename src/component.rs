//! Display contracts, independent of source transport and renderer implementation.
use anyhow::{Result, bail, ensure};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub enum ComponentKind {
    Mesh,
    Points,
    Text,
    Json,
    Html,
    Image,
    Plugin(String),
}
impl TryFrom<String> for ComponentKind {
    type Error = anyhow::Error;
    fn try_from(value: String) -> Result<Self> {
        Ok(match value.as_str() {
            "mesh" => Self::Mesh,
            "points" => Self::Points,
            "text" => Self::Text,
            "json" => Self::Json,
            "html" => Self::Html,
            "image" => Self::Image,
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
            ComponentKind::Json => "json".into(),
            ComponentKind::Html => "html".into(),
            ComponentKind::Image => "image".into(),
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
            "txt" | "log" | "jsonl" | "csv" | "md" => Self::Text,
            "json" => Self::Json,
            "html" | "htm" => Self::Html,
            "png" | "jpg" | "jpeg" | "webp" | "gif" => Self::Image,
            _ => bail!(
                "Cannot choose a component for {name}; use --component INDEX=mesh|points|text|json|html|image|PLUGIN:NAME"
            ),
        })
    }
    pub fn geometry(&self) -> bool {
        matches!(self, Self::Mesh | Self::Points)
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DisplayOptions {
    pub component: Option<ComponentKind>,
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
        if let Some(member) = &self.member {
            crate::archive::validate_member(member)?;
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
pub struct SceneComponent {
    pub id: String,
    pub component: ComponentKind,
    pub source: ComponentSource,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub renderer: Option<crate::plugin::RendererBinding>,
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
pub struct ComponentUpdate {
    pub id: String,
    pub position: Option<[f32; 3]>,
    pub size: Option<[f32; 2]>,
    pub visible: bool,
    pub opacity: f32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state: Option<serde_json::Value>,
}
impl ComponentUpdate {
    pub fn validate(&self) -> Result<()> {
        if let Some(state) = &self.state {
            ensure!(
                serde_json::to_vec(state)?.len() <= 65536,
                "component state exceeds 64 KiB"
            );
        }
        DisplayOptions {
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

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn inference_is_predictable() {
        for (path, kind) in [
            ("UPPER.PLY", ComponentKind::Mesh),
            ("margin.pts", ComponentKind::Points),
            ("run.log", ComponentKind::Text),
            ("execution.json", ComponentKind::Json),
            ("a.trace.json", ComponentKind::Json),
            ("tracing.json", ComponentKind::Json),
            ("report.html", ComponentKind::Html),
            ("image.png", ComponentKind::Image),
        ] {
            assert_eq!(ComponentKind::infer(path).unwrap(), kind);
        }
        assert!(ComponentKind::infer("file.bin").is_err());
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
