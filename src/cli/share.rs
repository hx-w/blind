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
    pub(super) host: Option<String>,
    pub(super) ttl_days: u32,
    pub(super) format: OutputFormat,
}
const MAX_SHARE_CONFIG_BYTES: u64 = 4 * 1024 * 1024;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ShareConfig {
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
    member: Option<String>,
    path: PathBuf,
    label: Option<String>,
    component: Option<crate::scene::component::ComponentKind>,
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
            let input = match (part.resources, part.uri) {
                (Some(resources), None) => parse_share_config(
                    ShareConfig {
                        title: Some(part.title),
                        resources,
                        groups: part.groups,
                    },
                    &base,
                ),
                (None, Some(uri)) if part.groups.is_empty() && crate::plugin::is_plugin(&uri) => {
                    Ok(ShareInput {
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
        manifest.validate()?;
        for resource in &mut manifest.resources {
            anyhow::ensure!(
                !crate::plugin::is_plugin(&resource.uri),
                "versioned manifests cannot contain plugin URIs"
            );
            if !crate::storage::oss::is_oss(&resource.uri) {
                let path = Path::new(&resource.uri);
                resource.uri = fs::canonicalize(if path.is_absolute() {
                    path.to_owned()
                } else {
                    base.join(path)
                })?
                .to_string_lossy()
                .into_owned();
            }
        }
        for attachment in &manifest.attachments {
            crate::storage::oss::Location::parse(&attachment.uri)?;
        }
        return Ok(SharePlan::Scene(Box::new(ShareInput {
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
    if config.resources.is_empty() {
        bail!("share config resources must contain at least one item");
    }
    let mut meshes = Vec::with_capacity(config.resources.len());
    let mut display = Vec::with_capacity(config.resources.len());
    let mut mesh_labels = Vec::with_capacity(config.resources.len());
    for (index, resource) in config.resources.into_iter().enumerate() {
        let options = crate::scene::component::DisplayOptions {
            component: resource.component,
            member: resource.member,
            group: resource.group,
            position: resource.position,
            size: resource.size,
        };
        options.validate()?;
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
        host,
        ttl_days,
        format,
    } = options;
    let config_mode = config.is_some();
    let plan = match config {
        Some(path) => read_share_config(&path)?,
        None => {
            let meshes = super::discovery::expand_inputs(meshes, recursive).await?;
            let labels = parse_labels(&labels, meshes.len())?;
            let display = parse_components(&components, meshes.len())?;
            SharePlan::Scene(Box::new(ShareInput {
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
                let paths = part
                    .input
                    .meshes
                    .iter()
                    .map(share_path)
                    .collect::<Result<Vec<_>>>()?;
                scenes.push(json!({"id":part.id,"title":part.input.title,"paths":paths,"display":part.input.display,"labels":part.input.labels.meshes,"label_groups":part.input.labels.groups}));
            }
            let payload = api(&c.server, "/api/v1/client/scenes", &c.credential, Some(json!({
                "collection":{"title":collection.title,"active_scene_id":collection.active_scene_id,"scenes":scenes},
                "origin":host,"ttl_days":ttl_days
            }))).await?;
            return print_share_payload(payload, format, ttl_days);
        }
    };
    if input
        .meshes
        .iter()
        .any(|p| crate::plugin::is_plugin(&p.to_string_lossy()))
    {
        anyhow::ensure!(
            input.meshes.len() == 1
                && input.labels.meshes.iter().all(Option::is_none)
                && input.labels.groups.is_empty()
                && input.display.iter().all(|o| o.component.is_none()
                    && o.group.is_none()
                    && o.position.is_none()
                    && o.size.is_none()),
            "a plugin share accepts one URI and no --label overrides"
        );
    }
    if load()?.is_none() {
        join(false, true, false, None, None, None).await?;
    }
    let c = load()?.context("not registered")?;
    let paths = input
        .meshes
        .iter()
        .map(share_path)
        .collect::<Result<Vec<_>>>()?;
    if config_mode {
        eprintln!(
            "Blind: registering {} resources from the config; the first share hashes every source once and a multi-gigabyte scene may take several minutes.",
            paths.len()
        );
    }
    let payload=api(&c.server,"/api/v1/client/scenes",&c.credential,Some(json!({"display":input.display,"paths":if input.manifest.is_some(){Vec::<String>::new()}else{paths},"manifest":input.manifest,"title":input.title,"labels":input.labels.meshes,"label_groups":input.labels.groups,"origin":host,"ttl_days":ttl_days}))).await?;
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
                "component must be mesh, points, text, markdown, json, html, image or plugin:name",
            )?,
        );
    }
    Ok(display)
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
