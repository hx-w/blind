//! Renderer registration and immutable scene bindings, independent of resolver execution.
use super::package::validate_relative_path;
use super::{Manifest, valid_id};
use crate::scene::component::{ComponentKind, RendererCapabilities};
use anyhow::{Result, ensure};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
pub(super) const MAX_DOCUMENT: usize = 4 * 1024 * 1024;
pub(super) const MAX_DOCUMENTS: usize = 8 * 1024 * 1024;
pub(super) fn validate_document(path: &str, html: &str) -> Result<()> {
    validate_relative_path(path)?;
    ensure!(path.ends_with(".html"), "renderer document must be HTML");
    ensure!(
        !html.is_empty() && html.len() <= MAX_DOCUMENT && !html.contains('\0'),
        "invalid renderer document size or encoding"
    );
    Ok(())
}

pub(super) fn renderer_metadata_bytes(
    id: &str,
    version: &str,
    components: &[RendererDefinition],
) -> usize {
    let entrypoints: HashSet<_> = components
        .iter()
        .map(|definition| definition.entrypoint.as_str())
        .collect();
    id.len()
        + version.len()
        + entrypoints.iter().map(|path| path.len()).sum::<usize>()
        + components
            .iter()
            .map(|definition| {
                definition.name.len()
                    + definition.entrypoint.len()
                    + definition
                        .extensions
                        .iter()
                        .chain(&definition.frame_origins)
                        .chain(&definition.capabilities.presentations)
                        .map(String::len)
                        .sum::<usize>()
            })
            .sum::<usize>()
}

pub(super) fn validate_renderer_metadata(
    id: &str,
    version: &str,
    components: &[RendererDefinition],
) -> Result<()> {
    ensure!(
        renderer_metadata_bytes(id, version, components) <= 1024 * 1024,
        "renderer metadata exceeds 1 MiB"
    );
    Ok(())
}

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
pub struct ComponentResource {
    pub id: String,
    pub uri: String,
    pub label: String,
    #[serde(flatten)]
    pub display: crate::scene::component::DisplayOptions,
}
pub(super) fn validate_renderers(m: &Manifest) -> Result<()> {
    validate_renderer_metadata(&m.id, &m.version, &m.components)?;
    validate_definitions(&m.components, &m.files)
}
pub(super) fn validate_definitions(
    components: &[RendererDefinition],
    files: &[String],
) -> Result<()> {
    let mut names = HashSet::new();
    ensure!(components.len() <= 64, "too many component definitions");
    for c in components {
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
            files.contains(&c.entrypoint) && c.entrypoint.ends_with(".html"),
            "renderer must be a packaged HTML file"
        );
        ensure!(
            c.extensions.len() <= 64 && c.frame_origins.len() <= 64,
            "too many component extensions or frame origins"
        );
        ensure!(
            c.extensions.iter().collect::<HashSet<_>>().len() == c.extensions.len()
                && c.frame_origins.iter().collect::<HashSet<_>>().len() == c.frame_origins.len()
                && c.capabilities
                    .presentations
                    .iter()
                    .collect::<HashSet<_>>()
                    .len()
                    == c.capabilities.presentations.len(),
            "repeated component declaration"
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
            ensure!(origin.len() <= 512, "frame origin is too long");
            let url = url::Url::parse(origin)?;
            ensure!(
                url.scheme() == "https" && url.origin().ascii_serialization() == *origin,
                "frame origins must be HTTPS origins"
            );
        }
    }
    Ok(())
}
/// Infer only from explicitly selected declarations; installation is not activation.
pub fn infer_component_definitions<'a>(
    path: &str,
    definitions: impl IntoIterator<Item = (&'a str, &'a RendererDefinition)>,
) -> Result<ComponentKind> {
    if let Ok(kind) = ComponentKind::infer(path)
        && kind.geometry()
    {
        return Ok(kind);
    }
    let filename = path.rsplit('/').next().unwrap_or(path).to_ascii_lowercase();
    let mut best = None;
    let mut ambiguous = false;
    for (id, c) in definitions {
        ensure!(valid_id(id) && valid_id(&c.name), "invalid component name");
        for ext in &c.extensions {
            if filename
                .strip_suffix(ext)
                .is_some_and(|prefix| prefix.is_empty() || prefix.ends_with('.'))
            {
                let candidate = (ext.len(), id, c.name.as_str());
                match best {
                    None => {
                        best = Some(candidate);
                        ambiguous = false;
                    }
                    Some((length, _, _)) if ext.len() > length => {
                        best = Some(candidate);
                        ambiguous = false;
                    }
                    Some((length, plugin, name))
                        if ext.len() == length && (plugin != id || name != c.name) =>
                    {
                        ambiguous = true
                    }
                    _ => {}
                }
            }
        }
    }
    ensure!(!ambiguous, "ambiguous component; select with --component");
    match best {
        Some((_, id, name)) => Ok(ComponentKind::Plugin(format!("{id}:{name}"))),
        None => ComponentKind::infer(path),
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
            assert!(crate::scene::component::ComponentKind::try_from(bad.to_owned()).is_err());
        }
        let mut update: crate::scene::component::EntityUpdate = serde_json::from_value(
            json!({"id":"a","visible":true,"opacity":1,"state":{"selection":3}}),
        )
        .unwrap();
        update.validate().unwrap();
        update.state = Some(json!("x".repeat(65537)));
        assert!(update.validate().is_err());
    }
}
