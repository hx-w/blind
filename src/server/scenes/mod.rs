use super::{error::AppError, state::AppState};
use crate::{
    scene::{MeshFormat, MeshQuality, SceneDescriptor},
    storage::sources::SourceError,
};
use anyhow::Context;
use std::path::PathBuf;
mod manifest;
pub(super) use manifest::scene_from_manifest;

pub(in crate::server) async fn scene_from_sources(
    state: &AppState,
    paths: &[String],
    display: &[crate::scene::component::DisplayOptions],
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
        let options = display.get(i).cloned().unwrap_or_default();
        options
            .validate()
            .map_err(|e| AppError::bad_request(&e.to_string()))?;
        let kind = options
            .component
            .map(Ok)
            .unwrap_or_else(|| {
                crate::plugin::infer_component(options.member.as_deref().unwrap_or(path))
            })
            .map_err(|e| AppError::bad_request(&e.to_string()))?;
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
            state: None,
            component: kind.clone(),
            renderer: crate::plugin::bind_component(&kind)
                .map_err(|e| AppError::bad_request(&e.to_string()))?,
            source: source_ref,
            label: name.clone(),
            group: options.group,
            position: options.position,
            size: options.size,
            visible: true,
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
            visible: true,
            quality: MeshQuality::Lod,
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
    Ok(SceneDescriptor {
        source,
        schema: 5,
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
    })
}
