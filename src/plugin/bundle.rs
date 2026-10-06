//! Browser-only snapshots and explicit renderer selection, independent of installation receipts.
use super::components::{
    MAX_DOCUMENT, MAX_DOCUMENTS, renderer_metadata_bytes, validate_definitions, validate_document,
};
use super::package::{read_manifest, read_package_file};
use super::{RendererDefinition, hash_field, infer_component_definitions, installed, valid_id};
use crate::scene::component::{ComponentKind, RendererBinding};
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::Path,
};

/// Only self-contained browser HTML and renderer declarations cross host boundaries.
/// Resolver entrypoints, package files and private configuration are deliberately absent.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RendererBundle {
    pub id: String,
    pub version: String,
    pub components: Vec<RendererDefinition>,
    pub documents: BTreeMap<String, String>,
}

fn metadata_bytes(bundle: &RendererBundle) -> usize {
    renderer_metadata_bytes(&bundle.id, &bundle.version, &bundle.components)
}

fn normalized_definition(definition: &RendererDefinition) -> RendererDefinition {
    let mut definition = definition.clone();
    definition.extensions.sort();
    definition.frame_origins.sort();
    definition.capabilities.operations.sort();
    // Spatial remains the protocol's primary presentation; the rest is a set.
    definition.capabilities.presentations[1..].sort();
    definition
}

impl RendererBundle {
    pub fn validate(&self) -> Result<()> {
        ensure!(valid_id(&self.id), "invalid plugin ID");
        ensure!(
            !self.version.is_empty() && self.version.len() <= 128,
            "invalid plugin version"
        );
        ensure!(
            metadata_bytes(self) <= 1024 * 1024,
            "renderer metadata exceeds 1 MiB"
        );
        let files: Vec<_> = self.documents.keys().cloned().collect();
        validate_definitions(&self.components, &files)?;
        super::update::version(&self.version)?;
        let expected: BTreeSet<_> = self
            .components
            .iter()
            .map(|c| c.entrypoint.as_str())
            .collect();
        ensure!(
            expected.len() == self.documents.len()
                && self
                    .documents
                    .keys()
                    .all(|path| expected.contains(path.as_str())),
            "renderer documents must exactly match component entrypoints"
        );
        let mut total = 0usize;
        for (path, html) in &self.documents {
            validate_document(path, html)?;
            total += html.len();
            ensure!(total <= MAX_DOCUMENTS, "renderer bundle exceeds 8 MiB");
        }
        Ok(())
    }

    /// Length-framed, versioned digest; independent of declaration and document key order.
    pub fn revision(&self) -> Result<String> {
        self.validate()?;
        let mut hash = Sha256::new();
        hash_field(&mut hash, b"blind.renderer-bundle.v1");
        hash_field(&mut hash, self.id.as_bytes());
        hash_field(&mut hash, self.version.as_bytes());
        let mut components: Vec<_> = self.components.iter().map(normalized_definition).collect();
        components.sort_by(|a, b| a.name.cmp(&b.name));
        hash.update((components.len() as u64).to_be_bytes());
        for component in components {
            hash_field(&mut hash, &serde_json::to_vec(&component)?);
        }
        hash.update((self.documents.len() as u64).to_be_bytes());
        for (path, html) in &self.documents {
            hash_field(&mut hash, path.as_bytes());
            hash_field(&mut hash, html.as_bytes());
        }
        Ok(format!("sha256:{}", hex::encode(hash.finalize())))
    }

    /// Validate every immutable field, not just a matching plugin/component name.
    pub fn validate_binding(&self, binding: &RendererBinding) -> Result<()> {
        ensure!(
            binding.revision == self.revision()?,
            "renderer revision does not match bundle"
        );
        validate_binding_metadata(self, binding)
    }
}

/// Compare declarations against a prevalidated bundle; the caller must check its cached revision.
pub(crate) fn validate_binding_metadata(
    bundle: &RendererBundle,
    binding: &RendererBinding,
) -> Result<()> {
    ensure!(
        binding.plugin == bundle.id,
        "renderer plugin does not match bundle"
    );
    let definition = bundle
        .components
        .iter()
        .find(|c| c.name == binding.name)
        .context("renderer missing from pinned package")?;
    let mut origins = binding.frame_origins.clone();
    origins.sort();
    let mut presentations = binding.capabilities.presentations.clone();
    presentations.sort();
    let mut expected_presentations = definition.capabilities.presentations.clone();
    expected_presentations.sort();
    let mut expected_origins = definition.frame_origins.clone();
    expected_origins.sort();
    let mut operations = binding.capabilities.operations.clone();
    operations.sort();
    let mut expected_operations = definition.capabilities.operations.clone();
    expected_operations.sort();
    ensure!(
        origins == expected_origins
            && presentations == expected_presentations
            && operations == expected_operations
            && binding.capabilities.host_space == definition.capabilities.host_space
            && binding.capabilities.movable == definition.capabilities.movable
            && binding.capabilities.resizable == definition.capabilities.resizable,
        "renderer binding metadata does not match pinned package"
    );
    Ok(())
}

fn package_bundle(directory: &Path, id: &str) -> Result<RendererBundle> {
    let manifest = read_manifest(directory)?;
    ensure!(manifest.id == id, "pinned package plugin ID mismatch");
    let mut documents = BTreeMap::new();
    for component in &manifest.components {
        if let std::collections::btree_map::Entry::Vacant(entry) =
            documents.entry(component.entrypoint.clone())
        {
            let bytes = read_package_file(directory, &component.entrypoint, MAX_DOCUMENT)?;
            let html = String::from_utf8(bytes).context("renderer document must be UTF-8 HTML")?;
            entry.insert(html);
        }
    }
    let bundle = RendererBundle {
        id: manifest.id,
        version: manifest.version,
        components: manifest.components,
        documents,
    };
    bundle.validate()?;
    Ok(bundle)
}

pub fn renderer_bundle(dir: &Path, id: &str) -> Result<RendererBundle> {
    let package = installed(dir, id)?;
    let versions = fs::canonicalize(dir.join("plugins").join(id).join("versions"))?;
    let directory = fs::canonicalize(package.directory)?;
    ensure!(
        directory.starts_with(versions),
        "installed package escapes plugin versions"
    );
    package_bundle(&directory, id)
}

fn checked_revisions(bundles: &[RendererBundle]) -> Result<BTreeMap<&str, String>> {
    ensure!(bundles.len() <= 64, "too many renderer bundles");
    let total: usize = bundles
        .iter()
        .flat_map(|bundle| bundle.documents.values())
        .map(String::len)
        .sum();
    ensure!(total <= MAX_DOCUMENTS, "renderer bundle set exceeds 8 MiB");
    ensure!(
        bundles.iter().map(metadata_bytes).sum::<usize>() <= 1024 * 1024,
        "renderer bundle set metadata exceeds 1 MiB"
    );
    let mut revisions = BTreeMap::new();
    for bundle in bundles {
        let revision = bundle.revision()?;
        if let Some(previous) = revisions.insert(bundle.id.as_str(), revision.clone()) {
            ensure!(
                previous == revision,
                "conflicting renderer bundles for plugin {}",
                bundle.id
            );
        }
    }
    Ok(revisions)
}

pub fn validate_bundle_set(bundles: &[RendererBundle]) -> Result<()> {
    checked_revisions(bundles).map(|_| ())
}

fn definition_binding(
    bundle: &RendererBundle,
    definition: &RendererDefinition,
    revision: String,
) -> RendererBinding {
    let definition = normalized_definition(definition);
    RendererBinding {
        plugin: bundle.id.clone(),
        name: definition.name,
        revision,
        frame_origins: definition.frame_origins,
        capabilities: definition.capabilities,
    }
}

/// Precompute once per scene/request, never re-hash HTML while expanding resources.
pub fn renderer_bindings(bundles: &[RendererBundle]) -> Result<BTreeMap<String, RendererBinding>> {
    let revisions = checked_revisions(bundles)?;
    let mut bindings = BTreeMap::new();
    for bundle in bundles {
        for definition in &bundle.components {
            let name = format!("{}:{}", bundle.id, definition.name);
            bindings.entry(name).or_insert_with(|| {
                definition_binding(bundle, definition, revisions[bundle.id.as_str()].clone())
            });
        }
    }
    Ok(bindings)
}

pub fn bind_renderer(
    kind: &ComponentKind,
    bundles: &[RendererBundle],
) -> Result<Option<RendererBinding>> {
    let revisions = checked_revisions(bundles)?;
    let ComponentKind::Plugin(kind) = kind else {
        return Ok(None);
    };
    let (id, name) = kind.split_once(':').context("invalid component name")?;
    ensure!(valid_id(id) && valid_id(name), "invalid component name");
    let bundle = bundles
        .iter()
        .find(|bundle| bundle.id == id)
        .with_context(|| format!("plugin {id} is not enabled"))?;
    let definition = bundle
        .components
        .iter()
        .find(|c| c.name == name)
        .with_context(|| format!("component {kind} is not installed"))?;
    Ok(Some(definition_binding(
        bundle,
        definition,
        revisions[id].clone(),
    )))
}

pub fn infer_component_from(path: &str, bundles: &[RendererBundle]) -> Result<ComponentKind> {
    validate_bundle_set(bundles)?;
    infer_component_definitions(
        path,
        bundles.iter().flat_map(|bundle| {
            bundle
                .components
                .iter()
                .map(move |definition| (bundle.id.as_str(), definition))
        }),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn definition(name: &str, extensions: &[&str]) -> RendererDefinition {
        serde_json::from_value(json!({
            "name":name,"entrypoint":format!("{name}.html"),"api_version":1,
            "extensions":extensions,
            "capabilities":{"presentations":["spatial","focus","fullscreen"],"movable":true,"resizable":false},
            "frame_origins":["https://a.example","https://b.example"]
        })).unwrap()
    }
    fn bundle() -> RendererBundle {
        RendererBundle {
            id: "example".into(),
            version: "1.0.0".into(),
            components: vec![
                definition("table", &["trace", "trace.json"]),
                definition("chart", &["plot"]),
            ],
            documents: BTreeMap::from([
                (
                    "table.html".into(),
                    "<!doctype html><script>/* inline */</script>".into(),
                ),
                ("chart.html".into(), "<!doctype html><p>Chart</p>".into()),
            ]),
        }
    }
    #[test]
    fn revisions_normalize_sets_and_cover_every_browser_field() {
        let original = bundle();
        let revision = original.revision().unwrap();
        let mut reordered = original.clone();
        reordered.components.reverse();
        for definition in &mut reordered.components {
            definition.extensions.reverse();
            definition.frame_origins.reverse();
            definition.capabilities.presentations[1..].reverse();
            definition.capabilities.operations.reverse();
        }
        assert_eq!(revision, reordered.revision().unwrap());
        validate_bundle_set(&[original.clone(), reordered]).unwrap();
        // These pairs collide under naive key+content concatenation, but not length framing.
        let mut first = original.clone();
        first.documents = BTreeMap::from([
            ("chart.html".into(), "atable.htmlb".into()),
            ("table.html".into(), "c".into()),
        ]);
        let mut second = original.clone();
        second.documents = BTreeMap::from([
            ("chart.html".into(), "a".into()),
            ("table.html".into(), "btable.htmlc".into()),
        ]);
        assert_ne!(first.revision().unwrap(), second.revision().unwrap());
        for change in 0..7 {
            let mut changed = original.clone();
            match change {
                0 => changed.version = "1.0.1".into(),
                1 => changed
                    .documents
                    .get_mut("table.html")
                    .unwrap()
                    .push_str("<p>changed</p>"),
                2 => changed.components[0].extensions.push("other".into()),
                3 => changed.components[0].capabilities.movable = false,
                4 => {
                    changed.components[0].capabilities.host_space =
                        crate::scene::component::HostSpace::Spatial
                }
                5 => changed.components[0]
                    .capabilities
                    .operations
                    .push("share.create".into()),
                _ => changed.components[0]
                    .frame_origins
                    .push("https://c.example".into()),
            }
            assert_ne!(revision, changed.revision().unwrap());
            assert!(validate_bundle_set(&[original.clone(), changed]).is_err());
        }
    }
    #[test]
    fn renderer_grants_are_explicit_bounded_and_bound_to_the_pinned_package() {
        let original = bundle();
        let kind = ComponentKind::Plugin("example:table".into());
        let mut binding = bind_renderer(&kind, std::slice::from_ref(&original))
            .unwrap()
            .unwrap();
        assert_eq!(
            binding.capabilities.host_space,
            crate::scene::component::HostSpace::Planar
        );
        assert!(!binding.capabilities.operations.iter().any(|grant| {
            [
                "share.create",
                "resource.open",
                "collection.write",
                "content.read-scene",
            ]
            .contains(&grant.as_str())
        }));
        validate_binding_metadata(&original, &binding).unwrap();
        binding.capabilities.operations.push("share.create".into());
        assert!(validate_binding_metadata(&original, &binding).is_err());
        binding.capabilities.operations.pop();
        binding.capabilities.host_space = crate::scene::component::HostSpace::Spatial;
        assert!(validate_binding_metadata(&original, &binding).is_err());
        let mut declared = original.clone();
        declared.components[0]
            .capabilities
            .operations
            .push("share.create".into());
        declared.components[0]
            .capabilities
            .operations
            .push("content.read-scene".into());
        declared.validate().unwrap();
        for grant in ["host", "scene.*", "unknown.read", "scene.read"] {
            let mut invalid = original.clone();
            invalid.components[0]
                .capabilities
                .operations
                .push(grant.into());
            assert!(invalid.validate().is_err());
        }
        let mut invalid = serde_json::to_value(original).unwrap();
        invalid["components"][0]["capabilities"]["host_space"] = json!("arbitrary");
        assert!(serde_json::from_value::<RendererBundle>(invalid).is_err());
    }
    #[test]
    fn bundle_boundary_rejects_protocol_paths_files_and_sizes() {
        let original = bundle();
        for change in 0..8 {
            let mut changed = original.clone();
            match change {
                0 => changed.components[0].api_version = 2,
                1 => {
                    changed
                        .documents
                        .insert("native.sh".into(), "secret".into());
                }
                2 => {
                    changed.documents.remove("table.html");
                }
                3 => {
                    changed
                        .documents
                        .insert("table.html".into(), "x".repeat(MAX_DOCUMENT + 1));
                }
                4 => changed.components[0].extensions = vec!["ply".into()],
                5 => changed.components.push(changed.components[0].clone()),
                6 => {
                    changed.components[0].entrypoint = "../table.html".into();
                    let html = changed.documents.remove("table.html").unwrap();
                    changed.documents.insert("../table.html".into(), html);
                }
                _ => changed.components[0].frame_origins = vec!["http://a.example".into()],
            }
            assert!(
                changed.validate().is_err(),
                "accepted invalid change {change}"
            );
        }
        let mut maximum = original.clone();
        maximum
            .documents
            .values_mut()
            .for_each(|html| *html = "x".repeat(MAX_DOCUMENT));
        maximum.validate().unwrap();
        let mut other = original.clone();
        other.id = "other".into();
        assert!(validate_bundle_set(&[maximum, other]).is_err());
        let mut value = serde_json::to_value(original).unwrap();
        value["config"] = json!({"secret":"private"});
        assert!(serde_json::from_value::<RendererBundle>(value).is_err());
    }
    #[test]
    fn explicit_selection_longest_suffix_geometry_and_conflicts() {
        let original = bundle();
        assert_eq!(
            infer_component_from("run.trace.json", std::slice::from_ref(&original)).unwrap(),
            ComponentKind::Plugin("example:table".into())
        );
        assert_eq!(
            infer_component_from("run.json", &[]).unwrap(),
            ComponentKind::Json
        );
        assert_eq!(
            infer_component_from("run.ply", std::slice::from_ref(&original)).unwrap(),
            ComponentKind::Mesh
        );
        let mut conflicting = original.clone();
        conflicting.id = "other".into();
        assert!(infer_component_from("run.trace", &[original.clone(), conflicting]).is_err());
        assert!(bind_renderer(&ComponentKind::Plugin("example:table".into()), &[]).is_err());
        let mut binding = bind_renderer(
            &ComponentKind::Plugin("example:table".into()),
            std::slice::from_ref(&original),
        )
        .unwrap()
        .unwrap();
        original.validate_binding(&binding).unwrap();
        binding.capabilities.movable = false;
        assert!(original.validate_binding(&binding).is_err());
    }
    fn package(path: &Path, version: &str, native: bool) {
        fs::create_dir_all(path).unwrap();
        let mut manifest = json!({
            "id":"example","name":"Example","version":version,"authors":[{"name":"Example Team"}],
            "components":[{"name":"table","entrypoint":"table.html","api_version":1,"extensions":["trace"]}],
            "files":["table.html"]
        });
        fs::write(
            path.join("table.html"),
            format!("<!doctype html><p>{version}</p>"),
        )
        .unwrap();
        if native {
            manifest["schemes"] = json!(["example"]);
            manifest["entrypoint"] = json!(["/bin/sh", "native.sh"]);
            manifest["files"] = json!(["table.html", "native.sh"]);
            manifest["env"] = json!({"SECRET":{"secret":true}});
            fs::write(path.join(".env"), "SECRET=private-token\n").unwrap();
            fs::write(
                path.join("native.sh"),
                "# native resolver, not browser code",
            )
            .unwrap();
        }
        fs::write(
            path.join("blind-plugin.toml"),
            toml::to_string(&manifest).unwrap(),
        )
        .unwrap();
    }
    #[test]
    fn browser_snapshot_excludes_native_and_private_bytes_and_metadata_only_changes() {
        let host = tempfile::tempdir().unwrap();
        let source = tempfile::tempdir().unwrap();
        package(source.path(), "1.0.0", true);
        super::super::install_package(host.path(), source.path()).unwrap();
        let original = renderer_bundle(host.path(), "example").unwrap();
        assert_eq!(original.documents.len(), 1);
        let serialized = serde_json::to_string(&original).unwrap();
        assert!(
            !serialized.contains("native.sh")
                && !serialized.contains("SECRET")
                && !serialized.contains("private-token")
                && !serialized.contains("authors")
        );
        let mut manifest = read_manifest(source.path()).unwrap();
        manifest.description = "Revised description".into();
        manifest.authors[0].name = "Another author".into();
        fs::write(
            source.path().join("blind-plugin.toml"),
            toml::to_string(&manifest).unwrap(),
        )
        .unwrap();
        fs::write(source.path().join(".env"), "SECRET=changed-private-token\n").unwrap();
        fs::write(source.path().join("native.sh"), "# changed native bytes").unwrap();
        super::super::install_package(host.path(), source.path()).unwrap();
        assert_eq!(
            renderer_bundle(host.path(), "example")
                .unwrap()
                .revision()
                .unwrap(),
            original.revision().unwrap()
        );
        package(source.path(), "2.0.0", false);
        super::super::install_package(host.path(), source.path()).unwrap_err();
        // Removing an env declaration cannot silently discard a retained private variable.
        assert_eq!(
            renderer_bundle(host.path(), "example").unwrap().version,
            "1.0.0"
        );
    }

    #[test]
    fn oversized_renderer_metadata_upgrade_preserves_working_installation() {
        let host = tempfile::tempdir().unwrap();
        let source = tempfile::tempdir().unwrap();
        package(source.path(), "1.0.0", false);
        super::super::install_package(host.path(), source.path()).unwrap();
        let receipt_path = super::super::installed_path(host.path(), "example").unwrap();
        let previous_receipt = fs::read(&receipt_path).unwrap();
        package(source.path(), "1.0.1", false);
        let manifest_path = source.path().join("blind-plugin.toml");
        let mut manifest = serde_json::to_value(read_manifest(source.path()).unwrap()).unwrap();
        let origins: Vec<_> = (0..64)
            .map(|index| {
                format!(
                    "https://{}.{}.{}.{}.test:{}",
                    "a".repeat(63),
                    "b".repeat(63),
                    "c".repeat(63),
                    "d".repeat(30),
                    10000 + index
                )
            })
            .collect();
        let extensions: Vec<_> = (0..64)
            .map(|index| format!("{}{:02}", "x".repeat(62), index))
            .collect();
        let components: Vec<_> = (0..64)
            .map(|index| {
                json!({
                    "name":format!("table{index}"), "entrypoint":"table.html", "api_version":1,
                    "extensions":extensions, "frame_origins":origins
                })
            })
            .collect();
        manifest["components"] = json!(components);
        fs::write(&manifest_path, toml::to_string(&manifest).unwrap()).unwrap();
        assert!(super::super::install_package(host.path(), source.path()).is_err());
        assert_eq!(fs::read(receipt_path).unwrap(), previous_receipt);
        assert_eq!(
            renderer_bundle(host.path(), "example").unwrap().version,
            "1.0.0"
        );
    }
}
