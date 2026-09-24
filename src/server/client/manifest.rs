use super::*;

pub(super) async fn scene_from_manifest(
    state: &AppState,
    plan: crate::plugin::ShareManifest,
    source: Option<crate::source::SceneSource>,
    title: Option<String>,
) -> Result<SceneDescriptor, AppError> {
    plan.validate()
        .map_err(|e| AppError::bad_request(&e.to_string()))?;
    let mut warnings = plan.warnings;
    let mut ready = HashMap::new();
    let mut cached = HashMap::new();
    for r in &plan.resources {
        if !cached.contains_key(&r.uri) {
            let result = async {
                // Reserve the existing shared geometry memory budget before
                // reading an un-sized source. Keep it inside the blocking task
                // so request cancellation cannot release it before parsing ends.
                let memory = state
                    .lod_memory
                    .clone()
                    .acquire_many_owned(LOD_MEMORY_MIB)
                    .await?;
                let observed = state
                    .registry
                    .sources
                    .observe(source.as_ref(), &r.uri, true)
                    .await
                    .map_err(|_| anyhow::anyhow!("resource unavailable"))?;
                let filename = if crate::oss::is_oss(&r.uri) {
                    crate::oss::Location::parse(&r.uri)?.key.to_string()
                } else {
                    r.uri.clone()
                };
                let format = MeshFormat::from_path(std::path::Path::new(&filename))?;
                let bytes = observed.bytes;
                let bounds = tokio::task::spawn_blocking(move || {
                    let _memory = memory;
                    crate::mesh::Geometry::from_bytes(&bytes, format).map(|g| g.bounds())
                })
                .await??;
                Ok::<_, anyhow::Error>((
                    crate::scene::MeshRef {
                        path: observed.path,
                        name: std::path::Path::new(&filename)
                            .file_name()
                            .context("no filename")?
                            .to_string_lossy()
                            .into_owned(),
                        format,
                        revision: observed.revision,
                        byte_size: observed.size,
                        modified_ns: observed.modified_ns,
                        change_ns: observed.change_ns,
                        color: crate::scene::default_color(format, ready.len()).into(),
                        opacity: 1.0,
                        visible: true,
                        quality: MeshQuality::Lod,
                        label: None,
                        translation: [0.0; 3],
                    },
                    bounds,
                ))
            }
            .await;
            cached.insert(r.uri.clone(), result.ok());
        }
        if let Some(Some((mesh, bounds))) = cached.get(&r.uri) {
            let mut mesh = mesh.clone();
            mesh.label = r.label.as_ref().map(|text| crate::scene::MeshLabel {
                text: text.clone(),
                anchor: None,
            });
            ready.insert(r.id.clone(), (mesh, *bounds));
        } else {
            warnings.push(crate::plugin::Warning {
                code: "RESOURCE_UNAVAILABLE".into(),
                message: format!(
                    "{}: resource unavailable or unsupported geometry",
                    r.label.as_deref().unwrap_or(&r.id)
                ),
                resource_id: Some(r.id.clone()),
            });
        }
    }
    if ready.is_empty() && plan.components.is_empty() {
        return Err(AppError::unprocessable(
            "NO_READABLE_GEOMETRY: no geometry could be loaded; check Server OSS access and artifact availability, then retry",
        ));
    }
    let has_panel_groups = plan.panels.iter().any(|p| p.group.is_some());
    let mut mesh_groups = Vec::new();
    let mut group_order = Vec::<String>::new();
    let mut group_counts = HashMap::<String, usize>::new();
    for panel in &plan.panels {
        let group = panel.group.as_ref().unwrap_or(&panel.label).clone();
        if !group_counts.contains_key(&group) {
            group_order.push(group.clone());
        }
        *group_counts.entry(group).or_default() += 1;
    }
    let mut meshes = Vec::new();
    let mut groups = Vec::new();
    if plan.panels.is_empty() {
        for r in &plan.resources {
            if let Some((m, _)) = ready.get(&r.id) {
                meshes.push(m.clone());
            }
        }
    } else {
        let mut panels = Vec::new();
        for panel in plan.panels {
            let members: Vec<_> = panel
                .members
                .iter()
                .filter_map(|id| ready.get(id))
                .collect();
            let missing = panel.members.len() - members.len();
            if missing > 0 {
                warnings.push(crate::plugin::Warning {
                    code: "PANEL_INCOMPLETE".into(),
                    message: format!(
                        "{}：缺少 {missing} 个产物{}",
                        panel.label,
                        if members.is_empty() {
                            "，该组暂无可显示的模型。"
                        } else {
                            "，仅显示可用部分。"
                        }
                    ),
                    resource_id: None,
                });
            }
            if members.is_empty() {
                continue;
            }
            let group = panel.group.clone().unwrap_or_else(|| panel.label.clone());
            let caption = if missing > 0 {
                format!("{} · 部分可用", panel.label)
                    .chars()
                    .take(120)
                    .collect()
            } else {
                panel.label
            };
            let mut min = glam::Vec3::splat(f32::INFINITY);
            let mut max = glam::Vec3::splat(f32::NEG_INFINITY);
            for (_, bounds) in &members {
                min = min.min(glam::Vec3::from_array(bounds.0));
                max = max.max(glam::Vec3::from_array(bounds.1));
            }
            panels.push((caption, group, members, min, max));
        }
        let cell = panels
            .iter()
            .map(|(_, _, _, min, max)| (*max - *min).max_element())
            .fold(1.0_f32, f32::max)
            * 1.1;
        if !cell.is_finite() {
            return Err(AppError::unprocessable(
                "Geometry bounds exceed layout limits",
            ));
        }
        let cols = (panels.len() as f32).sqrt().ceil().min(4.0) as usize;
        let group_cols = (group_order.len() as f32).sqrt().ceil().max(1.) as usize;
        let block = group_counts
            .values()
            .map(|n| (*n as f32).sqrt().ceil())
            .fold(1., f32::max)
            * cell
            + cell * 0.4;
        let mut placed = HashMap::<String, usize>::new();
        for (i, (label, group, members, min, max)) in panels.into_iter().enumerate() {
            let center = min * 0.5 + max * 0.5;
            let target = if has_panel_groups {
                let group_index = group_order.iter().position(|g| g == &group).unwrap();
                let columns = (group_counts[&group] as f32).sqrt().ceil().max(1.) as usize;
                let index = placed.entry(group.clone()).or_default();
                let target = glam::Vec3::new(
                    (group_index % group_cols) as f32 * block + (*index % columns) as f32 * cell,
                    -((group_index / group_cols) as f32 * block + (*index / columns) as f32 * cell),
                    0.,
                );
                *index += 1;
                target
            } else {
                glam::Vec3::new((i % cols) as f32 * cell, -((i / cols) as f32) * cell, 0.0)
            };
            let offset = target - center;
            if !target.is_finite() || !offset.is_finite() {
                return Err(AppError::unprocessable(
                    "Geometry bounds exceed layout limits",
                ));
            }
            let shift = offset.to_array();
            let mut indices = Vec::new();
            let single = members.len() == 1;
            for (mesh, _) in members {
                let mut mesh = mesh.clone();
                mesh.translation = shift;
                if single {
                    let text = match &mesh.label {
                        Some(own) if own.text != label => format!("{label} · {}", own.text),
                        _ => label.clone(),
                    };
                    mesh.label = Some(crate::scene::MeshLabel {
                        text: text.chars().take(120).collect(),
                        anchor: None,
                    });
                }
                mesh_groups.push(group.clone());
                indices.push(meshes.len());
                meshes.push(mesh);
            }
            if indices.len() > 1 {
                groups.push(crate::scene::MeshLabelGroup {
                    text: label,
                    meshes: indices,
                });
            }
        }
    }
    let mut attachments = Vec::new();
    for a in plan.attachments {
        let observed = state
            .registry
            .sources
            .observe(source.as_ref(), &a.uri, false)
            .await
            .ok();
        let unavailable = observed
            .is_none()
            .then(|| "Resource unavailable".to_owned());
        if unavailable.is_some() {
            warnings.push(crate::plugin::Warning {
                code: "ATTACHMENT_UNAVAILABLE".into(),
                message: format!(
                    "{}: attachment unavailable",
                    a.label.as_deref().unwrap_or(&a.id)
                ),
                resource_id: Some(a.id.clone()),
            });
        }
        attachments.push(crate::scene::SceneAttachment {
            member: None,
            id: a.id,
            path: a.uri,
            label: a.label.unwrap_or_else(|| "Attachment".into()),
            byte_size: observed.as_ref().map(|o| o.size),
            revision: observed.map(|o| o.revision),
            unavailable,
        });
    }
    // Recheck ownership after potentially slow upstream reads, before publishing.
    if let Some(s) = &source {
        state
            .registry
            .sources
            .get(&s.id)
            .map_err(|_| AppError::unauthorized("Client was revoked"))?;
    }
    let mut scene = SceneDescriptor {
        source: source.clone(),
        schema: 4,
        title: title
            .or(plan.title)
            .unwrap_or_else(|| "Plugin scene".into()),
        created_at: crate::source::now() as u64,
        ttl_days: None,
        meshes,
        entities: Vec::new(),
        label_groups: groups,
        state: Default::default(),
        attachments,
        warnings,
        collection: None,
    };
    if !plan.components.is_empty() || has_panel_groups {
        scene.entities = scene.entity_descriptors();
        // Existing geometry groups and new surface groups share the same flat layout contract.
        for (index, c) in scene.entities.iter_mut().enumerate() {
            if has_panel_groups {
                c.group = mesh_groups.get(index).cloned();
            }
            c.position = None;
        }
        for resource in plan.components {
            let child = scene_from_sources(
                state,
                &[resource.uri],
                &[resource.display],
                source.clone(),
                None,
            )
            .await;
            match child {
                Ok(mut child) => {
                    let mesh_offset = scene.meshes.len();
                    let attachment_offset = scene.attachments.len();
                    for c in &mut child.entities {
                        c.id = format!("plugin-{}", resource.id);
                        c.label = resource.label.clone();
                        match &mut c.source {
                            crate::component::ComponentSource::Mesh(i) => {
                                child.meshes[*i].label = Some(crate::scene::MeshLabel {
                                    text: resource.label.clone(),
                                    anchor: None,
                                });
                                *i += mesh_offset;
                            }
                            crate::component::ComponentSource::Attachment(i) => {
                                *i += attachment_offset
                            }
                        }
                    }
                    scene.meshes.extend(child.meshes);
                    scene.attachments.extend(child.attachments);
                    scene.entities.extend(child.entities);
                }
                Err(_) => scene.warnings.push(crate::plugin::Warning {
                    code: "COMPONENT_UNAVAILABLE".into(),
                    message: format!(
                        "{}: component source or renderer unavailable",
                        resource.label
                    ),
                    resource_id: Some(resource.id),
                }),
            }
        }
        if scene.entities.is_empty() {
            return Err(AppError::unprocessable("No readable scene components"));
        }
        scene.schema = 5;
    }
    Ok(scene)
}
