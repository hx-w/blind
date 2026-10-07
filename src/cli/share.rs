//! Parse share inputs, submit them through the client, and format CLI output.
use super::{OutputFormat, registration::join};
use crate::{
    client::{api, load},
    scene::{MeshLabel, MeshLabelGroup},
};
use anyhow::{Context, Result, bail};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
};

pub(super) struct ShareOptions {
    pub(super) recursive: bool,
    pub(super) plugins: Vec<String>,
    pub(super) qualities: Vec<String>,
    pub(super) host: Option<String>,
    pub(super) ttl_days: u32,
    pub(super) format: OutputFormat,
}
const MAX_SHARE_CONFIG_BYTES: u64 = 4 * 1024 * 1024;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ShareConfig {
    #[serde(default)]
    viewport: Option<crate::scene::ViewportState>,
    title: Option<String>,
    resources: Vec<ShareResource>,
    #[serde(default)]
    groups: Vec<ShareGroup>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct CollectionConfig {
    kind: String,
    schema_version: u32,
    title: String,
    active_scene_id: Option<String>,
    scenes: Vec<CollectionSceneConfig>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct CollectionSceneConfig {
    #[serde(default)]
    viewport: Option<crate::scene::ViewportState>,
    id: String,
    title: String,
    resources: Option<Vec<ShareResource>>,
    #[serde(default)]
    groups: Vec<ShareGroup>,
    uri: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ShareResource {
    #[serde(default)]
    placement: crate::scene::component::Placement,
    #[serde(default)]
    member: Option<String>,
    path: PathBuf,
    label: Option<String>,
    component: Option<crate::scene::component::ComponentKind>,
    quality: Option<crate::scene::MeshQuality>,
    visible: Option<bool>,
    group: Option<String>,
    position: Option<[f32; 3]>,
    size: Option<[f32; 2]>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ShareGroup {
    label: String,
    members: Vec<usize>,
}

#[derive(Debug, PartialEq)]
pub struct ParsedLabels {
    pub meshes: Vec<Option<MeshLabel>>,
    pub groups: Vec<MeshLabelGroup>,
}

struct ShareInput {
    viewport: Option<crate::scene::ViewportState>,
    display: Vec<crate::scene::component::DisplayOptions>,
    manifest: Option<crate::plugin::ShareManifest>,
    meshes: Vec<PathBuf>,
    title: Option<String>,
    labels: ParsedLabels,
}

enum SharePlan {
    Scene(Box<ShareInput>),
    Collection(CollectionInput),
}

struct CollectionInput {
    title: String,
    active_scene_id: String,
    scenes: Vec<CollectionSceneInput>,
}

struct CollectionSceneInput {
    id: String,
    input: ShareInput,
}

/// Suffix inference uses only explicitly enabled definitions. Explicit component
/// choices collect local browser bundles without activating their other suffixes.
struct ShareRenderers {
    dir: PathBuf,
    local_catalog: Value,
    bundles: Vec<crate::plugin::RendererBundle>,
    definitions: Vec<(String, crate::plugin::RendererDefinition)>,
    directories: Vec<crate::plugin::PreparedPackage>,
    revisions: std::collections::BTreeMap<String, String>,
}

impl ShareRenderers {
    async fn new(selections: &[String]) -> Result<Self> {
        let dir = crate::plugin::root()?;
        let local_catalog = crate::plugin::list(&dir)?;
        let mut selection = Self {
            dir,
            local_catalog,
            bundles: Vec::new(),
            definitions: Vec::new(),
            directories: Vec::new(),
            revisions: std::collections::BTreeMap::new(),
        };
        let mut remote_catalog = None;
        let mut seen = std::collections::HashSet::new();
        for requested in selections {
            if !seen.insert(requested) {
                continue;
            }
            let path = Path::new(requested);
            if path.is_absolute() || requested.starts_with("./") || requested.starts_with("../") {
                let package = crate::plugin::prepare_directory(path)?;
                let id = package.manifest().id.clone();
                selection.add_bundle(package.renderer_bundle().clone())?;
                selection.add_definitions(&id, &package.manifest().components);
                if let Some(previous) = selection.directories.iter().find(|p| p.manifest().id == id)
                {
                    anyhow::ensure!(
                        previous.same_resolution(&package),
                        "conflicting plugin resolution for {id}"
                    );
                } else {
                    selection.directories.push(package);
                }
            } else if crate::plugin::installed_path(&selection.dir, requested)?.exists() {
                let bundle = crate::plugin::renderer_bundle(&selection.dir, requested)?;
                selection.add_definitions(requested, &bundle.components);
                selection.add_bundle(bundle)?;
            } else {
                if remote_catalog.is_none() {
                    remote_catalog = crate::client::remote_plugins().await?;
                }
                let plugin = remote_catalog.as_ref()
                    .and_then(|v| v["plugins"].as_array())
                    .and_then(|plugins| plugins.iter().find(|p| p["id"].as_str() == Some(requested.as_str())))
                    .with_context(|| format!("plugin {requested} is not installed locally or available on the connected Server"))?;
                let components: Vec<crate::plugin::RendererDefinition> =
                    serde_json::from_value(plugin["components"].clone())?;
                if !components.is_empty() {
                    let revision = plugin["revision"]
                        .as_str()
                        .context("Server plugin has no browser revision")?;
                    selection.record_revision(requested, revision)?;
                }
                selection.add_definitions(requested, &components);
            }
        }
        Ok(selection)
    }

    fn add_definitions(&mut self, id: &str, definitions: &[crate::plugin::RendererDefinition]) {
        if !self.definitions.iter().any(|(existing, _)| existing == id) {
            self.definitions
                .extend(definitions.iter().cloned().map(|c| (id.to_owned(), c)));
        }
    }

    fn record_revision(&mut self, id: &str, revision: &str) -> Result<()> {
        if let Some(previous) = self.revisions.get(id) {
            anyhow::ensure!(previous == revision, "conflicting plugin content for {id}");
        } else {
            self.revisions.insert(id.to_owned(), revision.to_owned());
        }
        Ok(())
    }

    fn add_bundle(&mut self, bundle: crate::plugin::RendererBundle) -> Result<()> {
        self.record_revision(&bundle.id, &bundle.revision()?)?;
        if !bundle.components.is_empty() && !self.bundles.iter().any(|b| b.id == bundle.id) {
            self.bundles.push(bundle);
        }
        Ok(())
    }

    fn collect_component(&mut self, kind: &crate::scene::component::ComponentKind) -> Result<()> {
        if let crate::scene::component::ComponentKind::Plugin(component) = kind {
            let (id, name) = component
                .split_once(':')
                .context("invalid plugin component")?;
            if let Some(bundle) = self.bundles.iter().find(|bundle| bundle.id == id) {
                anyhow::ensure!(
                    bundle.components.iter().any(|c| c.name == name),
                    "component {component} is not installed locally"
                );
                return Ok(());
            }
            if crate::plugin::installed_path(&self.dir, id)?.exists() {
                let bundle = crate::plugin::renderer_bundle(&self.dir, id)?;
                anyhow::ensure!(
                    bundle.components.iter().any(|c| c.name == name),
                    "component {component} is not installed locally"
                );
                self.add_bundle(bundle)?;
            }
        }
        Ok(())
    }

    fn infer(&self, path: &str) -> Result<crate::scene::component::ComponentKind> {
        crate::plugin::infer_component_definitions(
            path,
            self.definitions
                .iter()
                .map(|(id, definition)| (id.as_str(), definition)),
        )
    }

    fn extensions(&self) -> Vec<String> {
        self.definitions
            .iter()
            .flat_map(|(_, c)| c.extensions.iter().cloned())
            .collect()
    }

    async fn prepare(&mut self, mut input: ShareInput) -> Result<ShareInput> {
        let plugin_input = input
            .meshes
            .iter()
            .any(|p| crate::plugin::is_plugin(&p.to_string_lossy()));
        if plugin_input {
            anyhow::ensure!(
                input.meshes.len() == 1
                    && input.labels.meshes.iter().all(Option::is_none)
                    && input.labels.groups.is_empty()
                    && input.display.iter().all(|o| o.component.is_none()
                        && o.member.is_none()
                        && o.quality.is_none()
                        && o.visible.is_none()
                        && o.group.is_none()
                        && o.position.is_none()
                        && o.size.is_none()),
                "a plugin share accepts one URI and no display or label overrides"
            );
            input.display.clear();
            input.labels.meshes.clear();
            let uri = input.meshes[0].to_string_lossy();
            let scheme = crate::plugin::scheme(&uri).context("invalid plugin URI")?;
            let installed = self.local_catalog["plugins"]
                .as_array()
                .is_some_and(|plugins| {
                    plugins.iter().any(|p| {
                        p["schemes"].as_array().is_some_and(|schemes| {
                            schemes.iter().any(|s| s.as_str() == Some(scheme))
                        })
                    })
                });
            let mut directories = self
                .directories
                .iter()
                .filter(|package| package.manifest().schemes.iter().any(|s| s == scheme));
            if let Some(package) = directories.next() {
                anyhow::ensure!(
                    directories.next().is_none(),
                    "multiple selected plugin directories handle {scheme}://"
                );
                input.manifest =
                    Some(crate::plugin::resolve_prepared(&self.dir, package, &uri, true).await?);
            } else if installed {
                let (manifest, bundle) = crate::plugin::resolve_local(&self.dir, &uri).await?;
                if let Some(bundle) = bundle {
                    self.add_bundle(bundle)?;
                }
                input.manifest = Some(manifest);
            }
        }
        if let Some(manifest) = &mut input.manifest {
            normalize_manifest(manifest, &std::env::current_dir()?)?;
            for component in &mut manifest.components {
                if component.display.component.is_none() && !self.definitions.is_empty() {
                    component.display.component = Some(
                        self.infer(
                            component
                                .display
                                .member
                                .as_deref()
                                .unwrap_or(&component.uri),
                        )?,
                    );
                }
                if let Some(kind) = &component.display.component {
                    self.collect_component(kind)?;
                }
            }
            input.meshes = manifest
                .resources
                .iter()
                .map(|r| PathBuf::from(&r.uri))
                .chain(manifest.components.iter().map(|r| PathBuf::from(&r.uri)))
                .chain(manifest.attachments.iter().map(|r| PathBuf::from(&r.uri)))
                .collect();
        } else if !plugin_input {
            input
                .display
                .resize_with(input.meshes.len(), Default::default);
            for (path, options) in input.meshes.iter().zip(&mut input.display) {
                let uri = path.to_string_lossy();
                if crate::plugin::is_plugin(&uri) {
                    continue;
                }
                if options.component.is_none() && !self.definitions.is_empty() {
                    options.component =
                        Some(self.infer(options.member.as_deref().unwrap_or(&uri))?);
                }
                if let Some(kind) = &options.component {
                    self.collect_component(kind)?;
                }
            }
        }
        Ok(input)
    }
}

fn normalize_manifest(manifest: &mut crate::plugin::ShareManifest, base: &Path) -> Result<()> {
    for uri in manifest
        .resources
        .iter_mut()
        .chain(&mut manifest.attachments)
        .map(|r| &mut r.uri)
        .chain(manifest.components.iter_mut().map(|c| &mut c.uri))
    {
        anyhow::ensure!(
            !crate::plugin::is_plugin(uri),
            "manifests cannot contain nested plugin or HTTP URIs"
        );
        if crate::storage::oss::is_oss(uri) {
            crate::storage::oss::Location::parse(uri)?;
        } else {
            let path = Path::new(uri);
            let absolute = if path.is_absolute() {
                path.to_owned()
            } else {
                base.join(path)
            };
            *uri = absolute.to_string_lossy().into_owned();
        }
    }
    manifest.validate()
}

fn read_share_config(path: &Path) -> Result<SharePlan> {
    let (bytes, base) = if path == Path::new("-") {
        let mut bytes = Vec::new();
        std::io::stdin()
            .take(MAX_SHARE_CONFIG_BYTES + 1)
            .read_to_end(&mut bytes)?;
        (bytes, std::env::current_dir()?)
    } else {
        let config_path = fs::canonicalize(path)
            .with_context(|| format!("cannot resolve share config {}", path.display()))?;
        let metadata = fs::metadata(&config_path)?;
        if !metadata.is_file() {
            bail!("share config {} is not a file", path.display());
        }
        if metadata.len() > MAX_SHARE_CONFIG_BYTES {
            bail!("share config exceeds 4 MiB");
        }
        let mut bytes = Vec::new();
        fs::File::open(&config_path)?
            .take(MAX_SHARE_CONFIG_BYTES + 1)
            .read_to_end(&mut bytes)?;
        (
            bytes,
            config_path
                .parent()
                .context("share config has no parent")?
                .to_owned(),
        )
    };
    if bytes.len() as u64 > MAX_SHARE_CONFIG_BYTES {
        bail!("share config exceeds 4 MiB");
    }
    let value: Value = serde_json::from_slice(&bytes)?;
    if value.get("kind").and_then(Value::as_str) == Some("collection") {
        let config: CollectionConfig = serde_json::from_value(value)?;
        anyhow::ensure!(
            config.kind == "collection" && config.schema_version == 1,
            "unsupported collection schema"
        );
        anyhow::ensure!(
            (2..=16).contains(&config.scenes.len()),
            "collection requires 2 to 16 scenes"
        );
        validate_collection_name(&config.title)?;
        let mut ids = std::collections::HashSet::new();
        let mut scenes = Vec::new();
        let mut total = 0;
        for (index, part) in config.scenes.into_iter().enumerate() {
            anyhow::ensure!(
                valid_scene_id(&part.id) && ids.insert(part.id.clone()),
                "scenes[{}].id is invalid or duplicated",
                index + 1
            );
            validate_collection_name(&part.title)
                .with_context(|| format!("scenes[{}].title", index + 1))?;
            if let Some(viewport) = &part.viewport {
                viewport
                    .validate(&[])
                    .with_context(|| format!("scenes[{}].viewport", index + 1))?;
            }
            let input = match (part.resources, part.uri) {
                (Some(resources), None) => parse_share_config(
                    ShareConfig {
                        viewport: part.viewport,
                        title: Some(part.title),
                        resources,
                        groups: part.groups,
                    },
                    &base,
                ),
                (None, Some(uri)) if part.groups.is_empty() && crate::plugin::is_plugin(&uri) => {
                    Ok(ShareInput {
                        viewport: part.viewport,
                        display: Vec::new(),
                        manifest: None,
                        meshes: vec![PathBuf::from(uri)],
                        title: Some(part.title),
                        labels: ParsedLabels {
                            meshes: Vec::new(),
                            groups: Vec::new(),
                        },
                    })
                }
                _ => bail!(
                    "scenes[{}] requires either resources or one plugin uri",
                    index + 1
                ),
            }
            .with_context(|| format!("invalid scenes[{}]", index + 1))?;
            total += input.meshes.len();
            scenes.push(CollectionSceneInput { id: part.id, input });
        }
        anyhow::ensure!(total <= 256, "collection exceeds 256 resources");
        let active_scene_id = config
            .active_scene_id
            .unwrap_or_else(|| scenes[0].id.clone());
        anyhow::ensure!(
            ids.contains(&active_scene_id),
            "active_scene_id does not name a scene"
        );
        return Ok(SharePlan::Collection(CollectionInput {
            title: config.title,
            active_scene_id,
            scenes,
        }));
    }
    if value.get("schema_version").is_some() {
        let mut manifest: crate::plugin::ShareManifest = serde_json::from_value(value)?;
        normalize_manifest(&mut manifest, &base)?;
        return Ok(SharePlan::Scene(Box::new(ShareInput {
            viewport: None,
            display: Vec::new(),
            meshes: manifest
                .resources
                .iter()
                .map(|r| PathBuf::from(&r.uri))
                .collect(),
            title: None,
            labels: ParsedLabels {
                meshes: Vec::new(),
                groups: Vec::new(),
            },
            manifest: Some(manifest),
        })));
    }
    let config: ShareConfig = serde_json::from_slice(&bytes)
        .with_context(|| format!("invalid share config {}", path.display()))?;
    parse_share_config(config, &base).map(|input| SharePlan::Scene(Box::new(input)))
}

fn valid_scene_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-' || c == b'_')
}

fn validate_collection_name(name: &str) -> Result<()> {
    anyhow::ensure!(
        !name.trim().is_empty() && name.chars().count() <= 120,
        "title must contain 1 to 120 characters"
    );
    Ok(())
}

fn parse_share_config(config: ShareConfig, base: &Path) -> Result<ShareInput> {
    if let Some(viewport) = &config.viewport {
        viewport.validate(&[]).context("invalid viewport")?;
    }
    if config.resources.is_empty() {
        bail!("share config resources must contain at least one item");
    }
    let mut meshes = Vec::with_capacity(config.resources.len());
    let mut display = Vec::with_capacity(config.resources.len());
    let mut mesh_labels = Vec::with_capacity(config.resources.len());
    for (index, resource) in config.resources.into_iter().enumerate() {
        let options = crate::scene::component::DisplayOptions {
            placement: resource.placement,
            component: resource.component,
            quality: resource.quality,
            visible: resource.visible,
            member: resource.member,
            group: resource.group,
            position: resource.position,
            size: resource.size,
        };
        options
            .validate()
            .with_context(|| format!("invalid resources[{}]", index + 1))?;
        display.push(options);
        if resource.path.as_os_str().is_empty() {
            bail!("resources[{}].path must not be empty", index + 1);
        }
        meshes.push(
            if crate::plugin::scheme(&resource.path.to_string_lossy()).is_some()
                || resource.path.is_absolute()
            {
                resource.path
            } else {
                base.join(resource.path)
            },
        );
        let label = resource
            .label
            .map(|text| {
                let label = MeshLabel {
                    text: text.trim().into(),
                    anchor: None,
                };
                label.validate()?;
                Ok::<MeshLabel, anyhow::Error>(label)
            })
            .transpose()
            .with_context(|| format!("invalid resources[{}].label", index + 1))?;
        mesh_labels.push(label);
    }
    let mesh_count = meshes.len();
    let groups = config
        .groups
        .into_iter()
        .enumerate()
        .map(|(group_index, group)| {
            let meshes = group
                .members
                .into_iter()
                .enumerate()
                .map(|(member_index, member)| {
                    member
                        .checked_sub(1)
                        .filter(|index| *index < mesh_count)
                        .with_context(|| {
                            format!(
                                "groups[{}].members[{}] must be between 1 and {mesh_count}",
                                group_index + 1,
                                member_index + 1
                            )
                        })
                })
                .collect::<Result<Vec<_>>>()?;
            let group = MeshLabelGroup {
                text: group.label.trim().into(),
                meshes,
            };
            group
                .validate(mesh_count)
                .with_context(|| format!("invalid groups[{}]", group_index + 1))?;
            Ok(group)
        })
        .collect::<Result<Vec<_>>>()?;
    if groups.len() > crate::scene::MAX_LABEL_GROUPS {
        bail!(
            "share config has too many groups; maximum is {}",
            crate::scene::MAX_LABEL_GROUPS
        );
    }
    Ok(ShareInput {
        viewport: config.viewport,
        display,
        manifest: None,
        meshes,
        title: config.title,
        labels: ParsedLabels {
            meshes: mesh_labels,
            groups,
        },
    })
}

pub(super) async fn share(
    meshes: Vec<PathBuf>,
    config: Option<PathBuf>,
    title: Option<String>,
    labels: Vec<String>,
    components: Vec<String>,
    options: ShareOptions,
) -> Result<()> {
    let ShareOptions {
        recursive,
        plugins,
        qualities,
        host,
        ttl_days,
        format,
    } = options;
    let config_mode = config.is_some();
    let mut renderers = ShareRenderers::new(&plugins).await?;
    let plan = match config {
        Some(path) => read_share_config(&path).context(
            "cannot build share config; see blind share --help for input formats and constraints",
        )?,
        None => {
            let meshes =
                super::discovery::expand_inputs(meshes, recursive, &renderers.extensions())?;
            let labels = parse_labels(&labels, meshes.len())?;
            let mut display = parse_components(&components, meshes.len())?;
            parse_qualities(&qualities, &mut display)?;
            SharePlan::Scene(Box::new(ShareInput {
                viewport: None,
                display,
                manifest: None,
                meshes,
                title,
                labels,
            }))
        }
    };
    let input = match plan {
        SharePlan::Scene(input) => input,
        SharePlan::Collection(collection) => {
            if load()?.is_none() {
                join(false, true, false, None, None, None).await?;
            }
            let c = load()?.context("not registered")?;
            let mut scenes = Vec::new();
            for part in collection.scenes {
                let input = renderers.prepare(part.input).await?;
                let paths = if input.manifest.is_some() {
                    Vec::new()
                } else {
                    input
                        .meshes
                        .iter()
                        .map(share_path)
                        .collect::<Result<Vec<_>>>()?
                };
                scenes.push(json!({"id":part.id,"title":input.title,"viewport":input.viewport,"paths":paths,"manifest":input.manifest,"display":input.display,"labels":input.labels.meshes,"label_groups":input.labels.groups}));
            }
            crate::plugin::validate_bundle_set(&renderers.bundles)?;
            let payload = api(&c.server, "/api/v1/client/scenes", &c.credential, Some(json!({
                "collection":{"title":collection.title,"active_scene_id":collection.active_scene_id,"scenes":scenes},
                "renderers":&renderers.bundles,
                "origin":host,"ttl_days":ttl_days
            }))).await?;
            return print_share_payload(payload, format, ttl_days);
        }
    };
    let input = renderers.prepare(*input).await?;
    crate::plugin::validate_bundle_set(&renderers.bundles)?;
    if load()?.is_none() {
        join(false, true, false, None, None, None).await?;
    }
    let c = load()?.context("not registered")?;
    let paths = if input.manifest.is_some() {
        Vec::new()
    } else {
        input
            .meshes
            .iter()
            .map(share_path)
            .collect::<Result<Vec<_>>>()?
    };
    if config_mode {
        eprintln!(
            "Blind: registering {} resources from the config; the first share hashes every source once and a multi-gigabyte scene may take several minutes.",
            paths.len()
        );
    }
    let payload=api(&c.server,"/api/v1/client/scenes",&c.credential,Some(json!({"viewport":input.viewport,"display":input.display,"renderers":&renderers.bundles,"paths":if input.manifest.is_some(){Vec::<String>::new()}else{paths},"manifest":input.manifest,"title":input.title,"labels":input.labels.meshes,"label_groups":input.labels.groups,"origin":host,"ttl_days":ttl_days}))).await?;
    print_share_payload(payload, format, ttl_days)
}

fn share_path(p: &PathBuf) -> Result<String> {
    if crate::plugin::is_plugin(&p.to_string_lossy()) {
        return Ok(p.to_string_lossy().into_owned());
    }
    if crate::storage::oss::is_oss(&p.to_string_lossy()) {
        let address = p.to_string_lossy().into_owned();
        crate::storage::oss::Location::parse(&address)?;
        return Ok(address);
    }
    fs::canonicalize(p)
        .with_context(|| format!("cannot resolve {}", p.display()))
        .map(|p| p.to_string_lossy().into_owned())
}

fn print_share_payload(payload: Value, format: OutputFormat, ttl_days: u32) -> Result<()> {
    let confirmed_ttl = payload["ttl_days"].as_u64();
    if confirmed_ttl.is_some_and(|days| days != u64::from(ttl_days))
        || (confirmed_ttl.is_none() && ttl_days != crate::scene::DEFAULT_TTL_DAYS)
    {
        bail!(
            "Server did not confirm the requested link lifetime; update the Blind server and retry"
        );
    }
    for warning in payload["warnings"].as_array().into_iter().flatten() {
        if let Some(message) = warning["message"].as_str() {
            eprintln!("Blind: {message}");
        }
    }
    for part in payload["scenes"].as_array().into_iter().flatten() {
        for warning in part["warnings"].as_array().into_iter().flatten() {
            if let Some(message) = warning["message"].as_str() {
                eprintln!(
                    "Blind [{}]: {message}",
                    part["id"].as_str().unwrap_or("scene")
                );
            }
        }
    }
    match format {
        OutputFormat::Json => println!("{}", serde_json::to_string_pretty(&payload)?),
        OutputFormat::View => println!(
            "{}",
            payload["viewer_url"]
                .as_str()
                .context("missing viewer URL")?
        ),
        OutputFormat::Image => println!(
            "{}",
            payload["image_url"].as_str().context("missing image URL")?
        ),
        OutputFormat::Full => println!(
            "{}",
            payload["full_text"]
                .as_str()
                .context("missing full information")?
        ),
    }
    Ok(())
}

fn parse_components(
    values: &[String],
    count: usize,
) -> Result<Vec<crate::scene::component::DisplayOptions>> {
    let mut display = vec![crate::scene::component::DisplayOptions::default(); count];
    let mut seen = std::collections::HashSet::new();
    for value in values {
        let (index, kind) = if let Some((index, kind)) = value.split_once('=') {
            (index.parse::<usize>()?, kind)
        } else if count == 1 {
            (1, value.as_str())
        } else {
            bail!("use --component INDEX=TYPE for multiple files");
        };
        anyhow::ensure!(index > 0 && index <= count, "component index out of range");
        anyhow::ensure!(
            seen.insert(index),
            "component specified twice for resource {index}"
        );
        display[index - 1].component = Some(
            serde_json::from_value(serde_json::Value::String(kind.into())).context(
                "component must be mesh, points, text, markdown, json, html, image, mermaid, dot or plugin:name",
            )?,
        );
    }
    Ok(display)
}

fn parse_qualities(
    values: &[String],
    display: &mut [crate::scene::component::DisplayOptions],
) -> Result<()> {
    let mut seen = std::collections::HashSet::new();
    for value in values {
        let (index, quality) = if let Some((index, quality)) = value.split_once('=') {
            (index.parse::<usize>()?, quality)
        } else if display.len() == 1 {
            (1, value.as_str())
        } else {
            bail!("use --quality INDEX=raw|lod for multiple resources");
        };
        anyhow::ensure!(
            index > 0 && index <= display.len(),
            "quality index out of range"
        );
        anyhow::ensure!(
            seen.insert(index),
            "quality specified twice for resource {index}"
        );
        display[index - 1].quality = Some(
            serde_json::from_value(Value::String(quality.into()))
                .context("quality must be raw or lod")?,
        );
        display[index - 1].validate()?;
    }
    Ok(())
}

pub fn parse_labels(labels: &[String], count: usize) -> Result<ParsedLabels> {
    let mut meshes = vec![None; count];
    let mut groups = Vec::new();
    for label in labels {
        let (selectors, text) = label
            .split_once('=')
            .context("use --label INDEX[,INDEX...]=TEXT")?;
        let indices = selectors
            .split(',')
            .map(|value| {
                value
                    .trim()
                    .parse::<usize>()?
                    .checked_sub(1)
                    .filter(|index| *index < count)
                    .context("label index out of range")
            })
            .collect::<Result<Vec<_>>>()?;
        if indices.is_empty() {
            bail!("a label needs at least one Mesh index");
        }
        let mesh_label = MeshLabel {
            text: text.trim().into(),
            anchor: None,
        };
        mesh_label.validate()?;
        if indices.len() == 1 {
            let index = indices[0];
            if meshes[index].is_some() {
                bail!("duplicate label index");
            }
            meshes[index] = Some(mesh_label);
        } else {
            let group = MeshLabelGroup {
                text: mesh_label.text,
                meshes: indices,
            };
            group.validate(count)?;
            groups.push(group);
        }
    }
    Ok(ParsedLabels { meshes, groups })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scene_collection_and_manifest_configs_carry_board_viewport_and_panel_placement() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("config.json");
        let viewport = json!({"mode":"board","board":{"center":[12.5,-7.25],"scale":2.75}});
        let resource =
            json!({"path":"report.md","placement":"panel","size":[120,90],"visible":false});
        fs::write(
            &path,
            serde_json::to_vec(&json!({
                "viewport":viewport,"resources":[resource]
            }))
            .unwrap(),
        )
        .unwrap();
        let SharePlan::Scene(input) = read_share_config(&path).unwrap() else {
            panic!("expected scene");
        };
        assert_eq!(
            input.viewport.as_ref().unwrap().mode,
            crate::scene::ViewportMode::Board
        );
        assert_eq!(
            input
                .viewport
                .as_ref()
                .unwrap()
                .board
                .as_ref()
                .unwrap()
                .center,
            [12.5, -7.25]
        );
        assert_eq!(
            input.display[0].placement,
            crate::scene::component::Placement::Panel
        );
        assert_eq!(input.display[0].visible, Some(false));
        fs::write(
            &path,
            serde_json::to_vec(&json!({
                "kind":"collection","schema_version":1,"title":"Review","scenes":[
                    {"id":"board","title":"Board","viewport":viewport,"resources":[resource]},
                    {"id":"plugin","title":"Plugin","viewport":viewport,"uri":"example://report"}
                ]
            }))
            .unwrap(),
        )
        .unwrap();
        let SharePlan::Collection(input) = read_share_config(&path).unwrap() else {
            panic!("expected collection");
        };
        for part in &input.scenes {
            assert_eq!(
                part.input
                    .viewport
                    .as_ref()
                    .unwrap()
                    .board
                    .as_ref()
                    .unwrap()
                    .scale,
                2.75
            );
        }
        assert_eq!(
            input.scenes[0].input.display[0].placement,
            crate::scene::component::Placement::Panel
        );
        assert_eq!(input.scenes[0].input.display[0].visible, Some(false));
        fs::write(&path, serde_json::to_vec(&json!({
            "schema_version":1,"requires":["components.v1"],"viewport":viewport,
            "resources":[],"components":[{"id":"report","label":"Report","uri":"report.md","placement":"panel","visible":false}]
        })).unwrap()).unwrap();
        let SharePlan::Scene(input) = read_share_config(&path).unwrap() else {
            panic!("expected manifest");
        };
        let manifest = input.manifest.unwrap();
        assert_eq!(manifest.viewport.mode, crate::scene::ViewportMode::Board);
        assert_eq!(
            manifest.components[0].display.placement,
            crate::scene::component::Placement::Panel
        );
        assert_eq!(manifest.components[0].display.visible, Some(false));
        for scale in [0., -1.] {
            fs::write(
                &path,
                serde_json::to_vec(&json!({
                    "viewport":{"mode":"board","board":{"center":[0,0],"scale":scale}},
                    "resources":[{"path":"report.md"}]
                }))
                .unwrap(),
            )
            .unwrap();
            assert!(read_share_config(&path).is_err());
        }
        fs::write(
            &path,
            br#"{"resources":[{"path":"mesh.ply","component":"mesh","placement":"panel"}]}"#,
        )
        .unwrap();
        assert!(read_share_config(&path).is_err());
    }
    #[test]
    fn versioned_manifest_normalizes_every_local_source_and_rejects_nested_uris() {
        let directory = tempfile::tempdir().unwrap();
        for name in ["mesh.ply", "capture.json", "notes.txt"] {
            fs::write(directory.path().join(name), "data").unwrap();
        }
        let mut manifest: crate::plugin::ShareManifest = serde_json::from_value(json!({
            "schema_version": 1,
            "requires": ["components.v1", "attachments"],
            "resources": [{"id":"mesh","uri":"mesh.ply"}],
            "components": [{"id":"capture","uri":"capture.json","label":"Capture","component":"example:trace"}],
            "attachments": [{"id":"notes","uri":"notes.txt"}]
        })).unwrap();
        normalize_manifest(&mut manifest, directory.path()).unwrap();
        for uri in [
            &manifest.resources[0].uri,
            &manifest.components[0].uri,
            &manifest.attachments[0].uri,
        ] {
            assert!(Path::new(uri).is_absolute());
            assert!(Path::new(uri).exists());
        }
        manifest.components[0].uri = "https://example.com/private".into();
        assert!(normalize_manifest(&mut manifest, directory.path()).is_err());
        manifest.components[0].uri = "example://nested".into();
        assert!(normalize_manifest(&mut manifest, directory.path()).is_err());
    }

    #[test]
    fn labels_preserve_one_based_indices_and_reject_duplicates() {
        let labels = parse_labels(&["2= Preparation ".into()], 2).unwrap();
        assert!(labels.meshes[0].is_none());
        assert_eq!(labels.meshes[1].as_ref().unwrap().text, "Preparation");
        assert!(parse_labels(&["1=A".into(), "1=B".into()], 2).is_err());
    }

    #[test]
    fn one_label_can_target_a_group_and_coexist_with_mesh_labels() {
        let labels = parse_labels(&["1= Crown ".into(), "1, 2=Reference".into()], 2).unwrap();
        assert_eq!(labels.meshes[0].as_ref().unwrap().text, "Crown");
        assert_eq!(labels.groups.len(), 1);
        assert_eq!(labels.groups[0].text, "Reference");
        assert_eq!(labels.groups[0].meshes, [0, 1]);
        assert!(parse_labels(&["1,1=Duplicate".into()], 2).is_err());
        assert!(parse_labels(&["1,3=Range".into()], 2).is_err());
    }

    #[test]
    fn share_config_resolves_relative_resources_and_group_members() {
        let directory = tempfile::tempdir().unwrap();
        let config_path = directory.path().join("scene.json");
        fs::write(
            &config_path,
            r#"{
              "title": "Large review",
              "resources": [
                {"path": "meshes/crown.ply", "label": " Crown "},
                {"path": "/data/donor-a.ply"},
                {"path": "meshes/donor-b.ply"}
              ],
              "groups": [{"label": " References ", "members": [2, 3]}]
            }"#,
        )
        .unwrap();
        let SharePlan::Scene(input) = read_share_config(&config_path).unwrap() else {
            panic!("expected a single scene");
        };
        assert_eq!(input.title.as_deref(), Some("Large review"));
        assert_eq!(
            input.meshes[0],
            fs::canonicalize(directory.path())
                .unwrap()
                .join("meshes/crown.ply")
        );
        assert_eq!(input.meshes[1], PathBuf::from("/data/donor-a.ply"));
        assert_eq!(input.labels.meshes[0].as_ref().unwrap().text, "Crown");
        assert_eq!(input.labels.groups[0].text, "References");
        assert_eq!(input.labels.groups[0].meshes, [1, 2]);
    }

    #[test]
    fn share_config_rejects_unknown_fields_and_invalid_groups() {
        let directory = tempfile::tempdir().unwrap();
        let config_path = directory.path().join("scene.json");
        fs::write(
            &config_path,
            r#"{"resources":[{"path":"a.ply","typo":"ignored"}]}"#,
        )
        .unwrap();
        assert!(read_share_config(&config_path).is_err());
        fs::write(
            &config_path,
            r#"{"resources":[{"path":"a.ply"},{"path":"b.ply"}],"groups":[{"label":"bad","members":[1,1]}]}"#,
        )
        .unwrap();
        assert!(read_share_config(&config_path).is_err());
    }
}
