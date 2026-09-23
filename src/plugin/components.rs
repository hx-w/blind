//! Renderer registration and immutable scene bindings, independent of resolver execution.
use super::{Manifest, installed, list, read_json, root, valid_id, validate_manifest};
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use std::{collections::HashSet, fs};

/// Versioned, sandboxed surface renderer. Business behavior lives in the package.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RendererDefinition {
    pub name: String,
    pub entrypoint: String,
    pub api_version: u32,
    #[serde(default)]
    pub capabilities: RendererCapabilities,
    #[serde(default)]
    pub extensions: Vec<String>,
    #[serde(default)]
    pub frame_origins: Vec<String>,
}
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
#[serde(deny_unknown_fields)]
pub struct ComponentResource {
    pub id: String,
    pub uri: String,
    pub label: String,
    #[serde(flatten)]
    pub display: crate::component::DisplayOptions,
}
pub(super) fn validate_renderers(m: &Manifest) -> Result<()> {
    let mut names = HashSet::new();
    ensure!(m.components.len() <= 64, "too many component definitions");
    for c in &m.components {
        ensure!(
            valid_id(&c.name) && names.insert(&c.name),
            "invalid or repeated component name"
        );
        ensure!(
            c.capabilities
                .presentations
                .first()
                .is_some_and(|p| p == "spatial")
                && c.capabilities
                    .presentations
                    .iter()
                    .all(|p| ["spatial", "focus", "fullscreen"].contains(&p.as_str())),
            "invalid component presentations"
        );
        ensure!(c.api_version == 1, "unsupported renderer protocol");
        ensure!(
            m.files.contains(&c.entrypoint) && c.entrypoint.ends_with(".html"),
            "renderer must be a packaged HTML file"
        );
        for ext in &c.extensions {
            ensure!(
                !ext.is_empty()
                    && ext.len() <= 64
                    && ext.bytes().all(|b| b.is_ascii_lowercase()
                        || b.is_ascii_digit()
                        || matches!(b, b'.' | b'-')),
                "invalid component extension"
            );
            ensure!(
                !["ply", "stl", "obj", "pts"].contains(&ext.as_str()),
                "geometry extensions are reserved"
            );
        }
        for origin in &c.frame_origins {
            let url = url::Url::parse(origin)?;
            ensure!(
                url.scheme() == "https" && url.origin().ascii_serialization() == *origin,
                "frame origins must be HTTPS origins"
            );
        }
    }
    Ok(())
}
/// Resolve once at scene creation; current receipts never influence existing scenes.
pub fn bind_component(kind: &crate::component::ComponentKind) -> Result<Option<RendererBinding>> {
    let crate::component::ComponentKind::Plugin(kind) = kind else {
        return Ok(None);
    };
    let (id, name) = kind.split_once(':').context("invalid component name")?;
    let p = installed(&root()?, id)?;
    let definition = p
        .manifest
        .components
        .iter()
        .find(|c| c.name == name)
        .with_context(|| format!("component {kind} is not installed"))?;
    Ok(Some(RendererBinding {
        frame_origins: definition.frame_origins.clone(),
        capabilities: definition.capabilities.clone(),
        plugin: id.into(),
        name: name.into(),
        revision: p
            .directory
            .file_name()
            .context("missing revision")?
            .to_string_lossy()
            .into_owned(),
    }))
}
pub fn infer_component(path: &str) -> Result<crate::component::ComponentKind> {
    let filename = path.rsplit('/').next().unwrap_or(path).to_ascii_lowercase();
    let dir = root()?;
    let mut candidates = Vec::new();
    for entry in list(&dir)?["plugins"].as_array().into_iter().flatten() {
        let Some(id) = entry["id"].as_str() else {
            continue;
        };
        let p = installed(&dir, id)?;
        for c in p.manifest.components {
            for ext in c.extensions {
                if filename.ends_with(&format!(".{ext}")) || filename == ext {
                    candidates.push((ext.len(), format!("{id}:{}", c.name)));
                }
            }
        }
    }
    candidates.sort();
    candidates.dedup();
    if let Some((length, kind)) = candidates.last() {
        ensure!(
            candidates.iter().filter(|(n, _)| n == length).count() == 1,
            "ambiguous component; select with --component"
        );
        return crate::component::ComponentKind::try_from(kind.clone());
    }
    crate::component::ComponentKind::infer(path)
}
pub fn renderer_document(binding: &RendererBinding) -> Result<(Vec<u8>, Vec<String>)> {
    ensure!(
        valid_id(&binding.plugin) && valid_id(&binding.name),
        "invalid renderer binding"
    );
    ensure!(
        binding
            .revision
            .strip_prefix("sha256:")
            .is_some_and(|hash| hash.len() == 64 && hash.bytes().all(|b| b.is_ascii_hexdigit())),
        "invalid renderer revision"
    );
    let directory = root()?
        .join("plugins")
        .join(&binding.plugin)
        .join("versions")
        .join(&binding.revision);
    let manifest: Manifest =
        serde_json::from_value(read_json(&directory.join("blind-plugin.json"))?)?;
    validate_manifest(&manifest)?;
    let definition = manifest
        .components
        .iter()
        .find(|c| c.name == binding.name)
        .context("renderer missing from pinned package")?;
    let path = fs::canonicalize(directory.join(&definition.entrypoint))?;
    ensure!(
        path.starts_with(fs::canonicalize(&directory)?),
        "renderer escapes package"
    );
    Ok((fs::read(path)?, definition.frame_origins.clone()))
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct RendererCapabilities {
    pub presentations: Vec<String>,
    pub movable: bool,
    pub resizable: bool,
}
impl Default for RendererCapabilities {
    fn default() -> Self {
        Self {
            presentations: vec!["spatial".into(), "focus".into()],
            movable: true,
            resizable: false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn component_manifest_contract_and_state_are_bounded() {
        let c: ComponentResource = serde_json::from_value(json!({"id":"a","uri":"oss://team/bucket/run.zip","label":"Log","component":"example:table","member":"run.json","group":"Task"})).unwrap();
        c.display.validate().unwrap();
        assert!(
            serde_json::from_value::<ComponentResource>(
                json!({"id":"a","uri":"x","label":"X","component":"example:table","typo":true})
            )
            .is_err()
        );
        for bad in ["trace", "../foo:bar", "a:b:c", "a:", ":b"] {
            assert!(crate::component::ComponentKind::try_from(bad.to_owned()).is_err());
        }
        let mut update: crate::component::ComponentUpdate = serde_json::from_value(
            json!({"id":"a","visible":true,"opacity":1,"state":{"selection":3}}),
        )
        .unwrap();
        update.validate().unwrap();
        update.state = Some(json!("x".repeat(65537)));
        assert!(update.validate().is_err());
    }
}
