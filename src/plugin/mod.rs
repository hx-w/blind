//! Server-only, one-shot share resolvers. Public scenes contain ordinary sources.
mod resolver;
pub(crate) mod update;
pub use resolver::resolve;
mod components;
use components::validate_renderers;
pub use components::{
    ComponentResource, RendererDefinition, bind_component, infer_component, renderer_document,
};

use crate::scene::Warning;
use crate::{
    runtime::config::config_path,
    runtime::files::{private_dir, write_private},
};
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
};

const LIMIT: usize = 4 * 1024 * 1024;
pub const FEATURES: &[&str] = &[
    "layout.panels",
    "layout.panel-groups",
    "attachments",
    "components.v1",
    "archive.members",
];

#[derive(Clone, Serialize, Deserialize)]
pub struct Manifest {
    pub id: String,
    pub name: String,
    pub version: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub components: Vec<RendererDefinition>,
    pub schemes: Vec<String>,
    pub protocol_versions: Vec<u32>,
    pub entrypoint: Vec<String>,
    pub files: Vec<String>,
    pub config_schema: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub update: Option<UpdateSource>,
}
#[derive(Clone, Serialize, Deserialize)]
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
pub(crate) fn settings_path(dir: &Path, id: &str) -> Result<PathBuf> {
    ensure!(valid_id(id), "invalid plugin ID");
    Ok(dir.join("plugin-config").join(format!("{id}.json")))
}
pub(crate) fn read_json(path: &Path) -> Result<Value> {
    let bytes = fs::read(path)?;
    ensure!(bytes.len() <= LIMIT, "configuration exceeds 4 MiB");
    Ok(serde_json::from_slice(&bytes)?)
}
pub(crate) fn installed(dir: &Path, id: &str) -> Result<Installed> {
    serde_json::from_value(read_json(&installed_path(dir, id)?)?)
        .context("invalid plugin installation")
}
pub(crate) fn settings(dir: &Path, m: &Manifest) -> Result<Value> {
    let path = settings_path(dir, &m.id)?;
    let mut v = if path.exists() {
        read_json(&path)?
    } else {
        json!({})
    };
    ensure!(v.is_object(), "plugin config must be an object");
    for (k, p) in properties(m)? {
        if v.get(k).is_none()
            && let Some(default) = p.get("default")
        {
            v[k] = default.clone();
        }
    }
    Ok(v)
}
pub(crate) fn properties(m: &Manifest) -> Result<&serde_json::Map<String, Value>> {
    m.config_schema["properties"]
        .as_object()
        .context("config_schema.properties must be an object")
}
pub(crate) fn validate_config(m: &Manifest, v: &Value) -> Result<()> {
    let props = properties(m)?;
    for (key, value) in v.as_object().context("config must be an object")? {
        let p = props
            .get(key)
            .with_context(|| format!("unknown config field: {key}"))?;
        let valid = match p["type"].as_str() {
            Some("string") => value.is_string(),
            Some("integer") => value.is_i64() || value.is_u64(),
            Some("number") => value.is_number(),
            Some("boolean") => value.is_boolean(),
            _ => false,
        };
        ensure!(valid, "invalid type for config field: {key}");
        if let Some(options) = p.get("enum").and_then(Value::as_array) {
            ensure!(
                options.contains(value),
                "invalid choice for config field: {key}"
            );
        }
    }
    for required in m.config_schema["required"].as_array().into_iter().flatten() {
        let key = required
            .as_str()
            .context("required fields must be strings")?;
        ensure!(
            v.get(key)
                .is_some_and(|x| !x.is_null() && x.as_str() != Some("")),
            "missing config field: {key}"
        );
    }
    Ok(())
}
pub(crate) fn validate_binding(dir: &Path, v: &Value) -> Result<()> {
    if let Some(alias) = v.get("oss_alias") {
        let alias = alias.as_str().context("oss_alias must be a string")?;
        let bucket = v["bucket"]
            .as_str()
            .context("bucket is required with oss_alias")?;
        crate::storage::oss::Location::parse(&format!("oss://{alias}/{bucket}/check"))?;
        let store = crate::storage::oss::list(dir)?
            .into_iter()
            .find(|s| s.alias == alias)
            .context("configured OSS alias does not exist on this Server")?;
        ensure!(
            store.bucket.as_deref().is_none_or(|b| b == bucket),
            "bucket differs from OSS alias binding"
        );
    }
    Ok(())
}
fn validate_manifest(m: &Manifest) -> Result<()> {
    ensure!(valid_id(&m.id), "invalid plugin ID");
    if let Some(update) = &m.update {
        crate::plugin::update::validate_repository(&update.repository)?;
    }
    ensure!(
        !m.name.is_empty() && !m.version.is_empty(),
        "name and version are required"
    );
    ensure!(
        m.protocol_versions.contains(&1),
        "plugin has no compatible protocol (Host supports 1)"
    );
    ensure!(
        ((!m.schemes.is_empty() && !m.entrypoint.is_empty())
            || (m.schemes.is_empty() && m.entrypoint.is_empty() && !m.components.is_empty())),
        "plugin needs a resolver or components"
    );
    validate_renderers(m)?;
    let mut seen = HashSet::new();
    for s in &m.schemes {
        ensure!(
            scheme(&format!("{s}://x")) == Some(s.as_str())
                && !["oss", "http", "https", "file"].contains(&s.as_str())
                && seen.insert(s),
            "invalid, reserved or repeated plugin scheme"
        );
    }
    ensure!(
        m.config_schema["type"] == "object" && m.config_schema["additionalProperties"] == false,
        "config schema must be a closed object"
    );
    for key in m
        .config_schema
        .as_object()
        .context("invalid schema")?
        .keys()
    {
        ensure!(
            [
                "type",
                "additionalProperties",
                "properties",
                "required",
                "description",
                "title",
                "$schema"
            ]
            .contains(&key.as_str()),
            "unsupported config schema keyword: {key}"
        );
    }
    let props = properties(m)?;
    for p in props.values() {
        ensure!(
            ["string", "integer", "number", "boolean"].contains(&p["type"].as_str().unwrap_or("")),
            "config supports scalar properties only"
        );
        for key in p.as_object().context("invalid property schema")?.keys() {
            ensure!(
                [
                    "type",
                    "default",
                    "description",
                    "title",
                    "writeOnly",
                    "enum"
                ]
                .contains(&key.as_str()),
                "unsupported config property keyword: {key}"
            );
        }
        if p["writeOnly"] == true {
            ensure!(
                p["type"] == "string" && p.get("default").is_none(),
                "secrets must be strings without defaults"
            );
        }
    }
    for k in m.config_schema["required"]
        .as_array()
        .context("required must be an array")?
    {
        ensure!(
            k.as_str().is_some_and(|k| props.contains_key(k)),
            "unknown required property"
        );
    }
    Ok(())
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
                let ready = settings(dir, &i.manifest)
                    .and_then(|v| {
                        validate_config(&i.manifest, &v)?;
                        validate_binding(dir, &v)
                    })
                    .is_ok();
                result.push(json!({"id":id,"name":i.manifest.name,"version":i.manifest.version,"description":i.manifest.description,"schemes":i.manifest.schemes,"components":i.manifest.components,"state":if ready{"configured"}else{"unconfigured"}}));
            }
            Err(_) => result.push(json!({"id":id,"state":"invalid"})),
        }
    }
    result.sort_by_key(|v| v["id"].as_str().unwrap_or("").to_owned());
    Ok(json!({"plugins":result}))
}
fn executable(command: &str, package: &Path) -> Result<PathBuf> {
    let path = Path::new(command);
    let resolved = if path.is_absolute() {
        path.to_owned()
    } else if command.contains('/') {
        package.join(path)
    } else {
        std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())
            .map(|p| p.join(command))
            .find(|p| p.is_file())
            .with_context(|| {
                format!("runtime {command} not found; install it on the Server first")
            })?
    };
    let resolved = fs::canonicalize(resolved)?;
    ensure!(
        resolved.is_file(),
        "plugin entrypoint must be a regular file"
    );
    #[cfg(unix)]
    if !resolved.starts_with(package) {
        use std::os::unix::fs::PermissionsExt;
        ensure!(
            fs::metadata(&resolved)?.permissions().mode() & 0o111 != 0,
            "plugin runtime is not executable"
        );
    }
    Ok(resolved)
}
pub(crate) fn install_package(dir: &Path, directory: &Path) -> Result<String> {
    let package = fs::canonicalize(directory)?;
    let m: Manifest = serde_json::from_value(read_json(&package.join("blind-plugin.json"))?)?;
    validate_manifest(&m)?;
    for p in list(dir)?["plugins"]
        .as_array()
        .context("invalid plugin list")?
    {
        if p["id"] != m.id {
            for s in &m.schemes {
                ensure!(
                    !p["schemes"]
                        .as_array()
                        .is_some_and(|v| v.contains(&json!(s))),
                    "scheme {s} is already registered"
                );
            }
        }
    }
    let mut files = Vec::new();
    let mut hash_input = serde_json::to_vec(&m)?;
    for file in &m.files {
        let relative = Path::new(file);
        ensure!(
            !relative.is_absolute()
                && relative
                    .components()
                    .all(|p| matches!(p, std::path::Component::Normal(_))),
            "package paths must be relative without traversal"
        );
        let canonical = fs::canonicalize(package.join(relative))?;
        ensure!(
            canonical.starts_with(&package) && canonical.is_file(),
            "package file escapes package"
        );
        let bytes = fs::read(canonical)?;
        ensure!(bytes.len() <= 64 * 1024 * 1024, "plugin file too large");
        hash_input.extend_from_slice(file.as_bytes());
        hash_input.extend_from_slice(&bytes);
        files.push((file, bytes));
    }
    let runtime = match m.entrypoint.first() {
        Some(entry) => executable(entry, &package)?,
        None => PathBuf::new(),
    };
    let config = settings(dir, &m)?;
    if settings_path(dir, &m.id)?.exists() {
        validate_config(&m, &config)?;
        validate_binding(dir, &config)?;
    }
    let hash = crate::scene::hash_bytes(&hash_input);
    let destination = dir.join("plugins").join(&m.id).join("versions").join(hash);
    if !destination.exists() {
        let versions = destination.parent().unwrap();
        private_dir(versions)?;
        let staging = tempfile::tempdir_in(versions)?;
        for (name, bytes) in &files {
            let target = staging.path().join(name);
            write_private(&target, bytes)?;
        }
        write_private(
            &staging.path().join("blind-plugin.json"),
            &serde_json::to_vec_pretty(&m)?,
        )?;
        fs::rename(staging.path(), &destination)?;
    }
    for (name, bytes) in &files {
        ensure!(
            fs::read(destination.join(name))? == *bytes,
            "installed package integrity check failed"
        );
    }
    let runtime = if runtime.starts_with(&package) {
        let relative = runtime.strip_prefix(&package)?;
        ensure!(
            m.files.iter().any(|f| Path::new(f) == relative),
            "packaged executable must appear in files"
        );
        let target = destination.join(relative);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&target, fs::Permissions::from_mode(0o700))?;
        }
        target
    } else {
        runtime
    };
    let id = m.id.clone();
    let receipt = Installed {
        directory: destination,
        executable: runtime,
        manifest: m,
    };
    private_dir(installed_path(dir, &id)?.parent().unwrap())?;
    write_private(
        &installed_path(dir, &id)?,
        &serde_json::to_vec_pretty(&receipt)?,
    )?;
    Ok(id)
}
pub(crate) fn lock_admin(dir: &Path) -> Result<fs::File> {
    private_dir(dir)?;
    let path = dir.join("plugins.lock");
    let mut options = fs::OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let file = options.open(path)?;
    #[cfg(unix)]
    {
        use std::os::fd::AsRawFd;
        ensure!(
            unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0,
            "another plugin administration command is running; retry after it finishes"
        );
    }
    Ok(file)
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
    fn entrypoint_and_administration_boundaries() {
        let dir = tempfile::tempdir().unwrap();
        assert!(executable(dir.path().to_str().unwrap(), dir.path()).is_err());
        let lock = lock_admin(dir.path()).unwrap();
        assert!(lock_admin(dir.path()).is_err());
        drop(lock);
        assert!(lock_admin(dir.path()).is_ok());
    }
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
