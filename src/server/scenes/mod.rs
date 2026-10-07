use super::{error::AppError, state::AppState};
use crate::{
    scene::{MeshFormat, MeshQuality, SceneDescriptor},
    storage::sources::SourceError,
};
use anyhow::Context;
use std::{collections::BTreeMap, path::PathBuf};
mod manifest;
pub(super) use manifest::scene_from_manifest;

pub(in crate::server) async fn scene_from_sources(
    state: &AppState,
    paths: &[String],
    display: &[crate::scene::component::DisplayOptions],
    renderers: &RendererSelection,
    source: Option<crate::scene::SceneSource>,
    title: Option<String>,
) -> Result<SceneDescriptor, AppError> {
    if paths.is_empty() {
        return Err(AppError::bad_request("a scene needs at least one file"));
    }
    use crate::scene::component::{ComponentKind, ComponentSource, SceneEntity};
    if !display.is_empty() && display.len() != paths.len() {
        return Err(AppError::bad_request(
            "Display option count must match resources",
        ));
    }
    if paths.len() > 256 {
        return Err(AppError::bad_request(
            "A scene supports at most 256 resources",
        ));
    }
    let mut meshes = Vec::new();
    let mut attachments = Vec::new();
    let mut entities = Vec::new();
    for (i, path) in paths.iter().enumerate() {
        let mut options = display.get(i).cloned().unwrap_or_default();
        options
            .validate()
            .map_err(|e| AppError::bad_request(&e.to_string()))?;
        let kind = options
            .component
            .take()
            .map(Ok)
            .unwrap_or_else(|| ComponentKind::infer(options.member.as_deref().unwrap_or(path)))
            .map_err(|e| AppError::bad_request(&e.to_string()))?;
        options
            .validate_quality(&kind)
            .map_err(|e| AppError::bad_request(&e.to_string()))?;
        let renderer = if let ComponentKind::Plugin(name) = &kind {
            Some(
                renderers
                    .bindings
                    .get(name)
                    .ok_or_else(|| {
                        AppError::bad_request("required plugin renderer is unavailable")
                    })?
                    .clone(),
            )
        } else {
            None
        };
        if kind.geometry() && options.placement == crate::scene::component::Placement::Panel {
            return Err(AppError::bad_request("geometry cannot use panel placement"));
        }
        if kind.geometry() && options.size.is_some() {
            return Err(AppError::bad_request(
                "size applies to surface components; geometry retains source dimensions",
            ));
        }
        let observed = state
            .registry
            .sources
            .observe(source.as_ref(), path, options.member.is_some())
            .await
            .map_err(|e| match e {
                SourceError::Gone => AppError::bad_request("Source file or OSS alias not found"),
                SourceError::TooLarge => AppError::unprocessable("Source exceeds 512 MiB"),
                SourceError::Unavailable(_) => AppError::unavailable(
                    "Could not read source; check source configuration, credentials and permissions",
                ),
            })?;
        let path = if crate::storage::oss::is_oss(&observed.path) {
            PathBuf::from(
                crate::storage::oss::Location::parse(&observed.path)?
                    .key
                    .as_ref(),
            )
        } else {
            PathBuf::from(&observed.path)
        };
        let name = path
            .file_name()
            .context("missing filename")?
            .to_string_lossy()
            .into_owned();
        if let Some(member) = &options.member {
            if kind.geometry() {
                return Err(AppError::bad_request("archive geometry is not supported"));
            }
            crate::storage::archive::read_member(&observed.bytes, member)
                .map_err(|e| AppError::bad_request(&e.to_string()))?;
        }
        let source_ref = if kind.geometry() {
            ComponentSource::Mesh(meshes.len())
        } else {
            ComponentSource::Attachment(attachments.len())
        };
        entities.push(SceneEntity {
            id: format!("resource-{}", i + 1),
            placement: options.placement,
            state: None,
            component: kind.clone(),
            renderer,
            source: source_ref,
            label: name.clone(),
            group: options.group,
            position: options.position,
            size: options.size,
            visible: options.visible.unwrap_or(true),
            opacity: 1.0,
        });
        if !kind.geometry() {
            if observed.size > 64 * 1024 * 1024 {
                return Err(AppError::unprocessable("Surface component exceeds 64 MiB"));
            }
            attachments.push(crate::scene::SceneAttachment {
                member: options.member,
                id: format!("resource-{}", i + 1),
                path: observed.path,
                label: name,
                byte_size: Some(observed.size),
                revision: Some(observed.revision),
                unavailable: None,
            });
            continue;
        }
        let format = MeshFormat::from_path(&path)?;
        if (kind == ComponentKind::Points) != (format == MeshFormat::Pts) {
            return Err(AppError::bad_request(
                "points requires PTS; mesh requires PLY, STL or OBJ",
            ));
        }
        meshes.push(crate::scene::MeshRef {
            path: observed.path.clone(),
            name: path
                .file_name()
                .context("missing filename")?
                .to_string_lossy()
                .into_owned(),
            format,
            revision: observed.revision,
            byte_size: observed.size,
            modified_ns: observed.modified_ns,
            change_ns: observed.change_ns,
            color: crate::scene::default_color(format, i).into(),
            opacity: 1.0,
            visible: options.visible.unwrap_or(true),
            quality: options.quality.unwrap_or_default(),
            label: None,
            translation: options.position.unwrap_or([0.0; 3]),
        });
    }
    let title = title.unwrap_or_else(|| {
        if entities.len() == 1 {
            entities[0].label.clone()
        } else {
            format!("{} elements", entities.len())
        }
    });
    let mut scene = SceneDescriptor {
        source,
        schema: 8,
        title,
        created_at: crate::storage::sources::now() as u64,
        ttl_days: None,
        meshes,
        entities,
        attachments,
        warnings: Vec::new(),
        collection: None,
        label_groups: Vec::new(),
        state: Default::default(),
    };
    warn_lod_selection(&mut scene);
    Ok(scene)
}

pub(super) fn warn_lod_selection(scene: &mut SceneDescriptor) {
    scene
        .warnings
        .retain(|warning| warning.code != "LOD_SELECTED");
    let mut append = |id: &str, label: &str| {
        scene.warnings.push(crate::scene::Warning {
            code: "LOD_SELECTED".into(),
            message: format!(
                "{label} ({id}): LOD selected; viewing/export may generate a derived approximation, not exact source geometry. Select raw for the original geometry; source bytes and revision are unchanged."
            ),
            resource_id: Some(id.to_owned()),
        });
    };
    if scene.entities.is_empty() {
        for (index, mesh) in scene.meshes.iter().enumerate() {
            if mesh.quality == MeshQuality::Lod {
                append(
                    &format!("mesh-{index}"),
                    mesh.label
                        .as_ref()
                        .map(|l| l.text.as_str())
                        .unwrap_or(&mesh.name),
                );
            }
        }
    } else {
        for entity in &scene.entities {
            if let crate::scene::component::ComponentSource::Mesh(index) = &entity.source {
                if scene.meshes[*index].quality == MeshQuality::Lod {
                    append(&entity.id, &entity.label);
                }
            }
        }
    }
}

/// Metadata-only selections let collection children share browser documents
/// without copying or hashing their HTML for each resource.
#[derive(Clone, Default)]
pub(super) struct RendererSelection {
    pub(super) bindings: BTreeMap<String, crate::scene::component::RendererBinding>,
    revisions: BTreeMap<String, (String, usize)>,
    bytes: usize,
}

impl RendererSelection {
    fn from_bundles(bundles: &[crate::plugin::RendererBundle]) -> Result<Self, AppError> {
        let bindings = crate::plugin::renderer_bindings(bundles)
            .map_err(|e| AppError::bad_request(&e.to_string()))?;
        let mut revisions = BTreeMap::new();
        let mut bytes = 0;
        for bundle in bundles {
            if revisions.contains_key(&bundle.id) {
                continue;
            }
            let revision = match bundle.components.first() {
                Some(component) => bindings[&format!("{}:{}", bundle.id, component.name)]
                    .revision
                    .clone(),
                None => bundle
                    .revision()
                    .map_err(|e| AppError::bad_request(&e.to_string()))?,
            };
            let size = bundle.documents.values().map(String::len).sum::<usize>();
            revisions.insert(bundle.id.clone(), (revision, size));
            bytes += size;
        }
        Ok(Self {
            bindings,
            revisions,
            bytes,
        })
    }

    fn merge(&mut self, other: Self) -> Result<(), AppError> {
        for (id, (revision, bytes)) in other.revisions {
            if let Some((previous, _)) = self.revisions.get(&id) {
                if previous != &revision {
                    return Err(AppError::bad_request(
                        "conflicting renderer versions within one scene",
                    ));
                }
            } else {
                self.revisions.insert(id, (revision, bytes));
                self.bytes += bytes;
            }
        }
        if self.revisions.len() > 64 {
            return Err(AppError::bad_request("too many renderer bundles"));
        }
        if self.bytes > 8 * 1024 * 1024 {
            return Err(AppError::bad_request("renderer documents exceed 8 MiB"));
        }
        self.bindings.extend(other.bindings);
        Ok(())
    }
}

/// Uploaded packages are authoritative. Server installations are consulted only
/// for explicitly named components, never while inferring ordinary file types.
pub(super) fn prepare_renderers(
    mut bundles: Vec<crate::plugin::RendererBundle>,
    display: impl Iterator<Item = crate::scene::component::DisplayOptions>,
    shared: &RendererSelection,
) -> Result<(Vec<crate::plugin::RendererBundle>, RendererSelection), AppError> {
    if bundles.len() > 256 {
        return Err(AppError::bad_request("too many renderer bundles"));
    }
    let mut selection = shared.clone();
    selection.merge(RendererSelection::from_bundles(&bundles)?)?;
    for options in display {
        options
            .validate()
            .map_err(|e| AppError::bad_request(&e.to_string()))?;
        let Some(crate::scene::component::ComponentKind::Plugin(kind)) = options.component else {
            continue;
        };
        let (id, _) = kind.split_once(':').context("invalid plugin component")?;
        if selection.revisions.contains_key(id) {
            continue;
        }
        let path = crate::runtime::config::config_path()?;
        let dir = path.parent().context("missing config parent")?;
        let bundle = crate::plugin::renderer_bundle(dir, id)
            .map_err(|e| AppError::bad_request(&e.to_string()))?;
        selection.merge(RendererSelection::from_bundles(std::slice::from_ref(
            &bundle,
        ))?)?;
        bundles.push(bundle);
    }
    Ok((bundles, selection))
}
