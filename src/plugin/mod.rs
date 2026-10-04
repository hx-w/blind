//! Unified installed plugins, browser snapshots and one-shot share resolvers.
mod bundle;
mod components;
mod config;
mod package;
mod resolver;
pub(crate) mod update;
pub(crate) use bundle::validate_binding_metadata;
pub use bundle::{
    RendererBundle, bind_renderer, infer_component_from, renderer_bindings, renderer_bundle,
    validate_bundle_set,
};
pub use components::{ComponentResource, RendererDefinition, infer_component_definitions};
pub(crate) use config::{environment, validate_binding};
pub use package::{PreparedPackage, prepare_directory};
pub(crate) use package::{install_package, lock_admin, read_manifest, validate_manifest};
pub use resolver::{resolve, resolve_local, resolve_prepared};

use crate::runtime::config::config_path;
use crate::scene::Warning;
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashSet},
    fs,
    io::Read,
    path::{Path, PathBuf},
};

const LIMIT: usize = 4 * 1024 * 1024;
fn hash_field(hash: &mut Sha256, bytes: &[u8]) {
    hash.update((bytes.len() as u64).to_be_bytes());
    hash.update(bytes);
}
pub const FEATURES: &[&str] = &[
    "layout.panels",
    "layout.panel-groups",
    "attachments",
    "components.v1",
    "archive.members",
];

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Manifest {
    pub id: String,
    pub name: String,
    pub version: String,
    pub authors: Vec<Author>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub license: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repository: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub homepage: Option<String>,
    #[serde(default)]
    pub keywords: Vec<String>,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub components: Vec<RendererDefinition>,
    #[serde(default)]
    pub schemes: Vec<String>,
    #[serde(default = "default_protocol_versions")]
    pub protocol_versions: Vec<u32>,
    #[serde(default)]
    pub entrypoint: Vec<String>,
    pub files: Vec<String>,
    #[serde(default)]
    pub env: BTreeMap<String, EnvVariable>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub update: Option<UpdateSource>,
}
fn default_protocol_versions() -> Vec<u32> {
    vec![2]
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Author {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}
#[derive(Clone, Copy, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EnvType {
    #[default]
    String,
    Integer,
    Number,
    Boolean,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EnvVariable {
    #[serde(default, rename = "type")]
    pub kind: EnvType,
    #[serde(default)]
    pub required: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default: Option<Value>,
    #[serde(default)]
    pub secret: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, rename = "enum", skip_serializing_if = "Option::is_none")]
    pub choices: Option<Vec<Value>>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UpdateSource {
    pub repository: String,
}
#[derive(Serialize, Deserialize)]
pub(crate) struct Installed {
    pub(crate) directory: PathBuf,
    pub(crate) executable: PathBuf,
    pub(crate) manifest: Manifest,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Resource {
    pub id: String,
    pub uri: String,
    pub label: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Panel {
    /// Flat display group containing this geometry assembly.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
    pub id: String,
    pub label: String,
    pub members: Vec<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ShareManifest {
    pub schema_version: u32,
    #[serde(default)]
    pub requires: Vec<String>,
    pub title: Option<String>,
    pub resources: Vec<Resource>,
    #[serde(default)]
    pub components: Vec<ComponentResource>,
    #[serde(default)]
    pub panels: Vec<Panel>,
    #[serde(default)]
    pub attachments: Vec<Resource>,
    #[serde(default)]
    pub warnings: Vec<Warning>,
}

pub fn scheme(input: &str) -> Option<&str> {
    let (scheme, _) = input.split_once("://")?;
    (!scheme.is_empty()
        && scheme.bytes().enumerate().all(|(i, c)| {
            c.is_ascii_lowercase()
                || (i > 0 && (c.is_ascii_digit() || matches!(c, b'+' | b'-' | b'.')))
        }))
    .then_some(scheme)
}
pub fn is_plugin(input: &str) -> bool {
    scheme(input).is_some_and(|s| s != "oss")
}
fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-' || c == b'_')
}
pub(crate) fn root() -> Result<PathBuf> {
    Ok(config_path()?
        .parent()
        .context("missing config directory")?
        .to_owned())
}
pub(crate) fn installed_path(dir: &Path, id: &str) -> Result<PathBuf> {
    ensure!(valid_id(id), "invalid plugin ID");
    Ok(dir.join("plugins").join(id).join("current.json"))
}
pub(crate) fn environment_path(dir: &Path, id: &str) -> Result<PathBuf> {
    ensure!(valid_id(id), "invalid plugin ID");
    Ok(dir.join("plugins").join(id).join(".env"))
}
pub(crate) fn read_json(path: &Path) -> Result<Value> {
    let mut bytes = Vec::new();
    fs::File::open(path)?
        .take((LIMIT + 1) as u64)
        .read_to_end(&mut bytes)?;
    ensure!(bytes.len() <= LIMIT, "configuration exceeds 4 MiB");
    Ok(serde_json::from_slice(&bytes)?)
}
pub(crate) fn installed(dir: &Path, id: &str) -> Result<Installed> {
    serde_json::from_value(read_json(&installed_path(dir, id)?)?)
        .context("invalid plugin installation")
}

pub fn list(dir: &Path) -> Result<Value> {
    let mut result = Vec::new();
    let path = dir.join("plugins");
    if !path.exists() {
        return Ok(json!({"plugins":result}));
    }
    for entry in fs::read_dir(path)? {
        let entry = entry?;
        let id = entry.file_name().to_string_lossy().into_owned();
        if !entry.path().join("current.json").exists() {
            continue;
        }
        match installed(dir, &id) {
            Ok(i) => {
                let ready = validate_manifest(&i.manifest)
                    .and_then(|_| environment(dir, &i.manifest))
                    .is_ok();
                let m = &i.manifest;
                let revision = if m.components.is_empty() {
                    None
                } else {
                    renderer_bundle(dir, &id)
                        .and_then(|bundle| bundle.revision())
                        .ok()
                };
                result.push(json!({"id":id,"name":m.name,"version":m.version,"description":m.description,"authors":m.authors,"license":m.license,"repository":m.repository,"homepage":m.homepage,"keywords":m.keywords,"schemes":m.schemes,"components":m.components,"revision":revision,"state":if ready{"configured"}else{"unconfigured"}}));
            }
            Err(_) => result.push(json!({"id":id,"state":"invalid"})),
        }
    }
    result.sort_by_key(|v| v["id"].as_str().unwrap_or("").to_owned());
    Ok(json!({"plugins":result}))
}
impl ShareManifest {
    pub fn validate(&self) -> Result<()> {
        ensure!(
            self.schema_version == 1,
            "unsupported share manifest version"
        );
        ensure!(
            self.requires.iter().all(|r| FEATURES.contains(&r.as_str())),
            "unsupported required share capability"
        );
        ensure!(
            self.panels.is_empty() || self.requires.iter().any(|s| s == "layout.panels"),
            "panels require layout.panels capability"
        );
        ensure!(
            self.attachments.is_empty() || self.requires.iter().any(|s| s == "attachments"),
            "attachments require attachments capability"
        );
        ensure!(
            (!self.resources.is_empty() || !self.components.is_empty())
                && self.components.len() <= 256
                && self.resources.len() <= 4096
                && self.attachments.len() <= 4096
                && self.panels.len() <= 64,
            "share manifest exceeds resource/panel limits"
        );
        ensure!(
            self.panels.iter().map(|p| p.members.len()).sum::<usize>() <= 4096,
            "share manifest exceeds expanded mesh instance limit"
        );
        let mut ids = HashSet::new();
        for r in self.resources.iter().chain(&self.attachments) {
            ensure!(
                !r.id.is_empty() && r.id.len() <= 128 && ids.insert(&r.id),
                "empty or duplicate resource ID"
            );
            ensure!(!r.uri.is_empty(), "empty resource URI");
            if let Some(label) = &r.label {
                crate::scene::MeshLabel {
                    text: label.clone(),
                    anchor: None,
                }
                .validate()?;
            }
        }
        ensure!(
            self.components.is_empty() || self.requires.iter().any(|s| s == "components.v1"),
            "components require components.v1"
        );
        for c in &self.components {
            ensure!(
                valid_id(&c.id) && ids.insert(&c.id),
                "invalid or repeated component ID"
            );
            ensure!(!c.uri.is_empty(), "empty component URI");
            c.display.validate()?;
            ensure!(
                c.display.member.is_none() || self.requires.iter().any(|s| s == "archive.members"),
                "archive members require archive.members"
            );
            crate::scene::MeshLabel {
                text: c.label.clone(),
                anchor: None,
            }
            .validate()?;
        }
        let resources: HashSet<_> = self.resources.iter().map(|r| &r.id).collect();
        let mut panels = HashSet::new();
        let mut used = HashSet::new();
        for p in &self.panels {
            if let Some(group) = &p.group {
                ensure!(
                    self.requires.iter().any(|s| s == "layout.panel-groups"),
                    "panel groups require layout.panel-groups"
                );
                crate::scene::MeshLabel {
                    text: group.clone(),
                    anchor: None,
                }
                .validate()?;
            }
            ensure!(
                !p.id.is_empty() && panels.insert(&p.id) && !p.members.is_empty(),
                "invalid or duplicate panel"
            );
            crate::scene::MeshLabel {
                text: p.label.clone(),
                anchor: None,
            }
            .validate()?;
            let mut members = HashSet::new();
            for r in &p.members {
                ensure!(
                    resources.contains(r) && members.insert(r),
                    "invalid or repeated panel member"
                );
                used.insert(r);
            }
        }
        ensure!(
            self.panels.is_empty() || used == resources,
            "panels must cover every geometry resource"
        );
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn panel_expansion_has_a_scene_wide_limit() {
        let resources: Vec<_> = (0..100)
            .map(|i| Resource {
                id: format!("r{i}"),
                uri: "oss://x/b/a.ply".into(),
                label: None,
            })
            .collect();
        let panels: Vec<_> = (0..42)
            .map(|i| Panel {
                group: None,
                id: format!("p{i}"),
                label: "Panel".into(),
                members: resources.iter().map(|r| r.id.clone()).collect(),
            })
            .collect();
        let mut plan = ShareManifest {
            components: vec![],
            schema_version: 1,
            requires: vec!["layout.panels".into()],
            title: None,
            resources,
            panels,
            attachments: vec![],
            warnings: vec![],
        };
        assert!(plan.validate().is_err());
        plan.panels.truncate(40);
        plan.validate().unwrap();
    }
    #[test]
    fn nested_url_and_capability_compatibility() {
        assert_eq!(
            scheme("example://https://example.test/a?b=c"),
            Some("example")
        );
        assert!(!is_plugin("oss://team/bucket/a.ply"));
        let value = json!({"schema_version":1,"resources":[{"id":"a","uri":"oss://team/bucket/a.ply"}],"future_optional":{"a":1}});
        let mut plan: ShareManifest = serde_json::from_value(value).unwrap();
        plan.validate().unwrap();
        plan.requires.push("future.layout".into());
        assert!(plan.validate().is_err());
        plan.requires = vec!["layout.panels".into()];
        plan.panels.push(Panel {
            group: None,
            id: "p".into(),
            label: "Pair".into(),
            members: vec!["a".into(), "missing".into()],
        });
        assert!(plan.validate().is_err());
    }
    #[test]
    fn layout_cannot_silently_omit_or_duplicate_members() {
        let mut plan:ShareManifest=serde_json::from_value(json!({"schema_version":1,"requires":["layout.panels"],"resources":[{"id":"a","uri":"oss://x/b/a.ply"},{"id":"b","uri":"oss://x/b/b.ply"}],"panels":[{"id":"p","label":"Panel","members":["a"]}]})).unwrap();
        assert!(plan.validate().is_err());
        plan.panels[0].members.push("b".into());
        plan.validate().unwrap();
        plan.panels[0].members.push("b".into());
        assert!(plan.validate().is_err());
    }
}
