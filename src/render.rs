use std::{borrow::Cow, io::Cursor, mem, num::NonZeroU64, path::Path};

use anyhow::{Context, Result, bail};
use bytemuck::{Pod, Zeroable};
use glam::{Mat4, Vec3};
use image::{ImageFormat, RgbaImage};
use serde::Deserialize;
use tiny_skia::{LineCap, LineJoin, Paint, PathBuilder, PixmapMut, Stroke, Transform};
use wgpu::util::DeviceExt;

use crate::{
    mesh::Geometry,
    render_labels::{RenderLabel, overlay_labels},
    render_occlusion::Occluders,
    scene::{Background, Projection, SceneDescriptor, ScreenStroke, Shading, parse_hex_color},
};

const MAX_RENDER_SOURCE_BYTES: u64 = 512 * 1024 * 1024;
const MAX_RENDER_TRIANGLES: usize = 2_000_000;
const MAX_RENDER_POINTS: usize = 2_000_000;
const SAMPLE_COUNT: u32 = 4;
const DEPTH_FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Depth32Float;

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct Vertex {
    position: [f32; 3],
    normal: [f32; 3],
    color: [f32; 4],
    curve: f32,
}

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct Uniform {
    view_projection: [[f32; 4]; 4],
    key_direction: [f32; 4],
    fill_direction: [f32; 4],
    lighting: [f32; 4],
    camera_position: [f32; 4],
    camera_up: [f32; 4],
    finish: [f32; 4],
    tone: [f32; 4],
    surface: [f32; 4],
    curve_surface: [f32; 4],
    curve_edge: [f32; 4],
    point_scale: [f32; 4],
    point_color: [f32; 4],
}

#[derive(Clone, Deserialize)]
struct MatteShader {
    key_direction: [f32; 3],
    fill_direction: [f32; 3],
    ambient: f32,
    key: f32,
    fill: f32,
    hemisphere: f32,
    view: f32,
    wrap: f32,
    contrast: f32,
    rim: f32,
    rim_power: f32,
    specular: f32,
    shininess: f32,
    curve_surface: [f32; 4],
    curve_edge: [f32; 2],
    annotation_lift_pixels: f32,
    point_diameter_pixels: f32,
    translucent_threshold: f32,
    contrast_pivot: f32,
    light_min: f32,
    light_max: f32,
    background_dark: String,
    background_light: String,
    camera: CameraSpec,
}

#[derive(Clone, Deserialize)]
struct CameraSpec {
    fov_degrees: f32,
    fit_padding: f32,
    default_view_direction: [f32; 3],
    near_floor_factor: f32,
    clip_padding_factor: f32,
}

/// Appearance of screen strokes, shared with the browser markup layer.
#[derive(Clone, Deserialize)]
struct ScreenInk {
    ink_width: f32,
    outline_width: f32,
    outline_color: [u8; 3],
    outline_alpha: f32,
}

pub struct Renderer {
    device: wgpu::Device,
    queue: wgpu::Queue,
    camera_layout: wgpu::BindGroupLayout,
    opaque_triangle_pipeline: wgpu::RenderPipeline,
    translucent_triangle_pipeline: wgpu::RenderPipeline,
    opaque_point_pipeline: wgpu::RenderPipeline,
    translucent_point_pipeline: wgpu::RenderPipeline,
    line_pipeline: wgpu::RenderPipeline,
    material: MatteShader,
    ink: ScreenInk,
}

impl Renderer {
    pub async fn new() -> Result<Self> {
        let instance = wgpu::Instance::default();
        let adapter = instance
            .request_adapter(&wgpu::RequestAdapterOptions {
                power_preference: wgpu::PowerPreference::HighPerformance,
                compatible_surface: None,
                force_fallback_adapter: false,
            })
            .await
            .context("no compatible graphics adapter found")?;
        let (device, queue) = adapter
            .request_device(
                &wgpu::DeviceDescriptor {
                    label: Some("Blind renderer"),
                    required_features: wgpu::Features::empty(),
                    required_limits: wgpu::Limits::downlevel_defaults()
                        .using_resolution(adapter.limits()),
                },
                None,
            )
            .await?;
        let format = wgpu::TextureFormat::Rgba8UnormSrgb;
        let material: MatteShader = serde_json::from_str(include_str!("../shaders/matte.json"))
            .context("invalid shared matte shader definition")?;
        let ink: ScreenInk = serde_json::from_str(include_str!("../shaders/stroke.json"))
            .context("invalid shared screen stroke definition")?;
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Blind shader"),
            source: wgpu::ShaderSource::Wgsl(Cow::Borrowed(include_str!("render.wgsl"))),
        });
        let camera_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("Camera layout"),
            entries: &[wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::VERTEX_FRAGMENT,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Uniform,
                    // One uniform slot per batch, addressed with a dynamic
                    // offset so point batches can carry their own color.
                    has_dynamic_offset: true,
                    min_binding_size: NonZeroU64::new(mem::size_of::<Uniform>() as u64),
                },
                count: None,
            }],
        });
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("Blind pipeline layout"),
            bind_group_layouts: &[&camera_layout],
            push_constant_ranges: &[],
        });
        let opaque_triangle_pipeline = create_pipeline(
            &device,
            &pipeline_layout,
            &shader,
            format,
            PipelineKind::Mesh,
            None,
            true,
        );
        let translucent_triangle_pipeline = create_pipeline(
            &device,
            &pipeline_layout,
            &shader,
            format,
            PipelineKind::Mesh,
            Some(wgpu::BlendState::ALPHA_BLENDING),
            false,
        );
        let opaque_point_pipeline = create_pipeline(
            &device,
            &pipeline_layout,
            &shader,
            format,
            PipelineKind::Point,
            Some(wgpu::BlendState::ALPHA_BLENDING),
            true,
        );
        let translucent_point_pipeline = create_pipeline(
            &device,
            &pipeline_layout,
            &shader,
            format,
            PipelineKind::Point,
            Some(wgpu::BlendState::ALPHA_BLENDING),
            false,
        );
        let line_pipeline = create_pipeline(
            &device,
            &pipeline_layout,
            &shader,
            format,
            PipelineKind::Line,
            Some(wgpu::BlendState::ALPHA_BLENDING),
            true,
        );
        Ok(Self {
            device,
            queue,
            camera_layout,
            opaque_triangle_pipeline,
            translucent_triangle_pipeline,
            opaque_point_pipeline,
            translucent_point_pipeline,
            line_pipeline,
            material,
            ink,
        })
    }

    pub async fn render(
        &self,
        scene: &SceneDescriptor,
        sources: Vec<Option<Vec<u8>>>,
    ) -> Result<Vec<u8>> {
        let scene = scene.clone();
        let material = self.material.clone();
        let geometry = tokio::task::spawn_blocking(move || {
            load_scene_geometry_bytes(&scene, &material, Some(&sources))
        })
        .await??;
        self.render_geometry(&geometry).await
    }

    async fn render_geometry(&self, input: &RenderInput) -> Result<Vec<u8>> {
        let (width, height) = render_dimensions(input.width, input.height);
        let format = wgpu::TextureFormat::Rgba8UnormSrgb;
        let color_texture = self.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("Blind render target"),
            size: wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        });
        let msaa_texture = self.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("Blind multisample target"),
            size: wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: SAMPLE_COUNT,
            dimension: wgpu::TextureDimension::D2,
            format,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
            view_formats: &[],
        });
        let depth_texture = self.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("Blind depth"),
            size: wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: SAMPLE_COUNT,
            dimension: wgpu::TextureDimension::D2,
            format: DEPTH_FORMAT,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
            view_formats: &[],
        });
        let uniform = Uniform {
            view_projection: input.view_projection.to_cols_array_2d(),
            key_direction: [
                input.key_direction.x,
                input.key_direction.y,
                input.key_direction.z,
                0.0,
            ],
            fill_direction: [
                input.fill_direction.x,
                input.fill_direction.y,
                input.fill_direction.z,
                0.0,
            ],
            lighting: [
                self.material.ambient,
                self.material.key,
                self.material.fill,
                self.material.hemisphere,
            ],
            camera_position: [
                input.camera_position.x,
                input.camera_position.y,
                input.camera_position.z,
                0.0,
            ],
            camera_up: [input.camera_up.x, input.camera_up.y, input.camera_up.z, 0.0],
            finish: [
                self.material.view,
                self.material.wrap,
                self.material.contrast,
                0.0,
            ],
            tone: [
                self.material.contrast_pivot,
                self.material.light_min,
                self.material.light_max,
                self.material.translucent_threshold,
            ],
            surface: [
                self.material.rim,
                self.material.rim_power,
                self.material.specular,
                self.material.shininess,
            ],
            curve_surface: self.material.curve_surface,
            curve_edge: [
                self.material.curve_edge[0],
                self.material.curve_edge[1],
                0.0,
                0.0,
            ],
            point_scale: [
                self.material.point_diameter_pixels / width as f32,
                self.material.point_diameter_pixels / height as f32,
                0.0,
                0.0,
            ],
            point_color: [0.0; 4],
        };
        // Every batch gets its own uniform slot so point batches carry their
        // shared color without paying per point.
        let uniform_size = mem::size_of::<Uniform>();
        let uniform_stride = align_to(
            uniform_size as u32,
            self.device.limits().min_uniform_buffer_offset_alignment,
        );
        let mut uniform_bytes = vec![0_u8; uniform_stride as usize * input.batches.len().max(1)];
        for index in 0..input.batches.len().max(1) {
            let mut slot = uniform;
            if let Some(BatchGeometry::Points { color, .. }) =
                input.batches.get(index).map(|batch| &batch.geometry)
            {
                slot.point_color = *color;
            }
            let start = index * uniform_stride as usize;
            uniform_bytes[start..start + uniform_size].copy_from_slice(bytemuck::bytes_of(&slot));
        }
        let uniform_buffer = self
            .device
            .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("Camera uniforms"),
                contents: &uniform_bytes,
                usage: wgpu::BufferUsages::UNIFORM,
            });
        let bind_group = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("Camera bind group"),
            layout: &self.camera_layout,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: wgpu::BindingResource::Buffer(wgpu::BufferBinding {
                    buffer: &uniform_buffer,
                    offset: 0,
                    size: NonZeroU64::new(uniform_size as u64),
                }),
            }],
        });
        let batch_buffers: Vec<_> = input
            .batches
            .iter()
            .map(|batch| {
                self.device
                    .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                        label: Some(batch.geometry.buffer_label()),
                        contents: batch.geometry.bytes(),
                        usage: wgpu::BufferUsages::VERTEX,
                    })
            })
            .collect();
        let line_buffer = (!input.line_vertices.is_empty()).then(|| {
            self.device
                .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                    label: Some("Line vertices"),
                    contents: bytemuck::cast_slice(&input.line_vertices),
                    usage: wgpu::BufferUsages::VERTEX,
                })
        });

        let annotation_buffer = (!input.annotation_vertices.is_empty()).then(|| {
            self.device
                .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                    label: Some("Surface annotations"),
                    contents: bytemuck::cast_slice(&input.annotation_vertices),
                    usage: wgpu::BufferUsages::VERTEX,
                })
        });
        let bytes_per_row = width * 4;
        let padded_bytes_per_row = align_to(bytes_per_row, wgpu::COPY_BYTES_PER_ROW_ALIGNMENT);
        let output_buffer = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Render readback"),
            size: (padded_bytes_per_row * height) as u64,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        let color_view = color_texture.create_view(&Default::default());
        let msaa_view = msaa_texture.create_view(&Default::default());
        let depth_view = depth_texture.create_view(&Default::default());
        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("Blind encoder"),
            });
        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("Blind render pass"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &msaa_view,
                    resolve_target: Some(&color_view),
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(input.background),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
                    view: &depth_view,
                    depth_ops: Some(wgpu::Operations {
                        load: wgpu::LoadOp::Clear(1.0),
                        store: wgpu::StoreOp::Store,
                    }),
                    stencil_ops: None,
                }),
                timestamp_writes: None,
                occlusion_query_set: None,
            });
            for (index, (batch, buffer)) in input.batches.iter().zip(&batch_buffers).enumerate() {
                pass.set_bind_group(0, &bind_group, &[index as u32 * uniform_stride]);
                pass.set_vertex_buffer(0, buffer.slice(..));
                match &batch.geometry {
                    BatchGeometry::Mesh { vertices } => {
                        pass.set_pipeline(if batch.translucent {
                            &self.translucent_triangle_pipeline
                        } else {
                            &self.opaque_triangle_pipeline
                        });
                        pass.draw(0..vertices.len() as u32, 0..1);
                    }
                    BatchGeometry::Points { positions, .. } => {
                        pass.set_pipeline(if batch.translucent {
                            &self.translucent_point_pipeline
                        } else {
                            &self.opaque_point_pipeline
                        });
                        pass.draw(0..4, 0..positions.len() as u32);
                    }
                }
            }
            if let Some(buffer) = &line_buffer {
                pass.set_bind_group(0, &bind_group, &[0]);
                pass.set_pipeline(&self.line_pipeline);
                pass.set_vertex_buffer(0, buffer.slice(..));
                pass.draw(0..input.line_vertices.len() as u32, 0..1);
            }
            if let Some(buffer) = &annotation_buffer {
                pass.set_bind_group(0, &bind_group, &[0]);
                pass.set_pipeline(&self.translucent_triangle_pipeline);
                pass.set_vertex_buffer(0, buffer.slice(..));
                pass.draw(0..input.annotation_vertices.len() as u32, 0..1);
            }
        }
        encoder.copy_texture_to_buffer(
            wgpu::ImageCopyTexture {
                texture: &color_texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::ImageCopyBuffer {
                buffer: &output_buffer,
                layout: wgpu::ImageDataLayout {
                    offset: 0,
                    bytes_per_row: Some(padded_bytes_per_row),
                    rows_per_image: Some(height),
                },
            },
            wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
        );
        self.queue.submit(Some(encoder.finish()));
        let slice = output_buffer.slice(..);
        let (sender, receiver) = tokio::sync::oneshot::channel();
        slice.map_async(wgpu::MapMode::Read, move |result| {
            let _ = sender.send(result);
        });
        self.device.poll(wgpu::Maintain::Wait);
        receiver.await??;
        let mapped = slice.get_mapped_range();
        let mut pixels = vec![0_u8; (bytes_per_row * height) as usize];
        for row in 0..height as usize {
            let source = &mapped[row * padded_bytes_per_row as usize
                ..row * padded_bytes_per_row as usize + bytes_per_row as usize];
            pixels[row * bytes_per_row as usize..(row + 1) * bytes_per_row as usize]
                .copy_from_slice(source);
        }
        drop(mapped);
        output_buffer.unmap();
        let mut image =
            RgbaImage::from_raw(width, height, pixels).context("invalid render buffer")?;
        overlay_screen_strokes(
            &mut image,
            &input.strokes,
            &self.ink,
            input.width,
            input.height,
        )?;
        overlay_labels(&mut image, &input.labels, input.light_background)?;
        let mut encoded = Cursor::new(Vec::new());
        image.write_to(&mut encoded, ImageFormat::Png)?;
        Ok(encoded.into_inner())
    }
}

struct RenderInput {
    batches: Vec<RenderBatch>,
    line_vertices: Vec<Vertex>,
    annotation_vertices: Vec<Vertex>,
    labels: Vec<RenderLabel>,
    light_background: bool,
    width: u32,
    height: u32,
    view_projection: Mat4,
    camera_position: Vec3,
    camera_up: Vec3,
    key_direction: Vec3,
    fill_direction: Vec3,
    background: wgpu::Color,
    strokes: Vec<ScreenStroke>,
}

struct RenderBatch {
    geometry: BatchGeometry,
    translucent: bool,
    center: Vec3,
}

enum BatchGeometry {
    Mesh {
        vertices: Vec<Vertex>,
    },
    Points {
        positions: Vec<[f32; 3]>,
        color: [f32; 4],
    },
}

impl BatchGeometry {
    fn buffer_label(&self) -> &'static str {
        match self {
            Self::Mesh { .. } => "Mesh vertices",
            Self::Points { .. } => "Point positions",
        }
    }

    fn bytes(&self) -> &[u8] {
        match self {
            Self::Mesh { vertices } => bytemuck::cast_slice(vertices),
            Self::Points { positions, .. } => bytemuck::cast_slice(positions),
        }
    }
}

#[cfg(test)]
fn load_scene_geometry(scene: &SceneDescriptor, material: &MatteShader) -> Result<RenderInput> {
    load_scene_geometry_bytes(scene, material, None)
}

fn load_scene_geometry_bytes(
    scene: &SceneDescriptor,
    material: &MatteShader,
    sources: Option<&[Option<Vec<u8>>]>,
) -> Result<RenderInput> {
    let visible: Vec<_> = scene
        .meshes
        .iter()
        .enumerate()
        .filter(|(_, mesh)| mesh.visible)
        .collect();
    if visible.is_empty() {
        bail!("scene has no visible Meshes");
    }
    let mut loaded = Vec::new();
    let mut source_bytes = 0_u64;
    let mut triangles = 0_usize;
    let mut points = 0_usize;
    let mut bounds_min = Vec3::splat(f32::INFINITY);
    let mut bounds_max = Vec3::splat(f32::NEG_INFINITY);
    for (layer, mesh) in visible {
        source_bytes = source_bytes
            .checked_add(mesh.byte_size)
            .context("render source size overflow")?;
        if source_bytes > MAX_RENDER_SOURCE_BYTES {
            bail!("image rendering supports at most 512 MiB of visible source data");
        }
        let mut geometry = match sources {
            Some(data) => Geometry::from_bytes(
                data.get(layer)
                    .and_then(Option::as_deref)
                    .context("missing verified source bytes")?,
                mesh.format,
            )?,
            None => Geometry::load(Path::new(&mesh.path), mesh.format)?,
        };
        for p in &mut geometry.positions {
            for (coordinate, shift) in p.iter_mut().zip(mesh.translation) {
                *coordinate += shift;
            }
        }
        triangles = triangles
            .checked_add(geometry.indices.len() / 3)
            .context("triangle count overflow")?;
        if triangles > MAX_RENDER_TRIANGLES {
            bail!("image rendering supports at most 2,000,000 visible triangles");
        }
        if geometry.is_point_cloud() {
            points = points
                .checked_add(geometry.positions.len())
                .context("point count overflow")?;
            if points > MAX_RENDER_POINTS {
                bail!("image rendering supports at most 2,000,000 visible points");
            }
        }
        let (min, max) = geometry.bounds();
        bounds_min = bounds_min.min(Vec3::from_array(min));
        bounds_max = bounds_max.max(Vec3::from_array(max));
        loaded.push((layer, mesh, geometry, min, max));
    }
    let occluders: Vec<_> = if scene.state.annotations.iter().any(|mark| mark.visible) {
        loaded
            .iter()
            .filter(|(_, mesh, _, _, _)| mesh.opacity > 0.0)
            .flat_map(|(_, _, geometry, _, _)| {
                geometry.indices.chunks_exact(3).map(|tri| {
                    [
                        Vec3::from_array(geometry.positions[tri[0] as usize]),
                        Vec3::from_array(geometry.positions[tri[1] as usize]),
                        Vec3::from_array(geometry.positions[tri[2] as usize]),
                    ]
                })
            })
            .collect()
    } else {
        Vec::new()
    };
    let occluders = Occluders::new(occluders);
    let mesh_bounds: Vec<_> = loaded
        .iter()
        .map(|(i, _, _, min, max)| (*i, Vec3::from_array(*min), Vec3::from_array(*max)))
        .collect();
    let mut batches = Vec::new();
    let mut line_vertices = Vec::new();
    let wire = scene.state.shading == Shading::Wire;
    let flat = scene.state.shading == Shading::Flat;
    for (_layer, mesh, geometry, mesh_min, mesh_max) in loaded {
        let color = parse_color(&mesh.color, mesh.opacity)?;
        let center = (Vec3::from_array(mesh_min) + Vec3::from_array(mesh_max)) * 0.5;
        let translucent = mesh.opacity < material.translucent_threshold;
        if geometry.is_point_cloud() {
            batches.push(RenderBatch {
                // The position vec moves straight into the batch; the shared
                // color lives in the batch's uniform slot.
                geometry: BatchGeometry::Points {
                    positions: geometry.positions,
                    color,
                },
                translucent,
                center,
            });
            continue;
        }
        let flat = flat && mesh.format != crate::scene::MeshFormat::Pts;
        let wire = wire && mesh.format != crate::scene::MeshFormat::Pts;
        let normals = (!flat).then(|| geometry.smooth_normals());
        let mut vertices = Vec::with_capacity(geometry.indices.len());
        for triangle in geometry.indices.chunks_exact(3) {
            let face_normal = if flat {
                let a = Vec3::from_array(geometry.positions[triangle[0] as usize]);
                let b = Vec3::from_array(geometry.positions[triangle[1] as usize]);
                let c = Vec3::from_array(geometry.positions[triangle[2] as usize]);
                (b - a).cross(c - a).normalize_or_zero().to_array()
            } else {
                [0.0; 3]
            };
            let make = |index: u32| Vertex {
                position: geometry.positions[index as usize],
                normal: match &normals {
                    Some(normals) => normals[index as usize],
                    None => face_normal,
                },
                color,
                curve: if mesh.format == crate::scene::MeshFormat::Pts {
                    1.0
                } else {
                    0.0
                },
            };
            if wire {
                line_vertices.extend([
                    make(triangle[0]),
                    make(triangle[1]),
                    make(triangle[1]),
                    make(triangle[2]),
                    make(triangle[2]),
                    make(triangle[0]),
                ]);
            } else {
                vertices.extend([make(triangle[0]), make(triangle[1]), make(triangle[2])]);
            }
        }
        if !vertices.is_empty() {
            batches.push(RenderBatch {
                geometry: BatchGeometry::Mesh { vertices },
                translucent,
                center,
            });
        }
    }
    if scene.state.axes {
        append_axes(&mut line_vertices, bounds_min, bounds_max);
    }
    let frame = &scene.state.frame;
    let aspect = frame.width as f32 / frame.height.max(1) as f32;
    let extent = bounds_max - bounds_min;
    let center = (bounds_min + bounds_max) * 0.5;
    let diagonal = extent.length().max(0.001);
    let camera = scene.state.camera.as_ref();
    let camera_spec = &material.camera;
    let default_fov = camera_spec.fov_degrees.to_radians();
    let horizontal_fov = 2.0 * ((default_fov * 0.5).tan() * aspect).atan();
    let fit_fov = default_fov.min(horizontal_fov);
    let default_distance = diagonal * 0.5 / (fit_fov * 0.5).sin() * camera_spec.fit_padding;
    let mut position = camera
        .map(|value| Vec3::from_array(value.position))
        .unwrap_or(
            center
                + Vec3::from_array(camera_spec.default_view_direction).normalize_or_zero()
                    * default_distance,
        );
    let target = camera
        .map(|value| Vec3::from_array(value.target))
        .unwrap_or(center);
    if matches!(scene.state.projection, Projection::Orthographic) {
        position = orthographic_position(position, target, center, extent * 0.5, camera_spec);
    }
    let up = camera
        .map(|value| Vec3::from_array(value.up))
        .unwrap_or(Vec3::Y);
    let view = Mat4::look_at_rh(position, target, up);
    let forward = (target - position).normalize_or_zero();
    let camera_right = forward.cross(up).normalize_or_zero();
    let camera_up = camera_right.cross(forward).normalize_or_zero();
    let camera_back = -forward;
    let camera_direction = |value: [f32; 3]| {
        (camera_right * value[0] + camera_up * value[1] + camera_back * value[2])
            .normalize_or_zero()
    };
    batches.sort_by(|left, right| match (left.translucent, right.translucent) {
        (false, true) => std::cmp::Ordering::Less,
        (true, false) => std::cmp::Ordering::Greater,
        (true, true) => right
            .center
            .distance_squared(position)
            .total_cmp(&left.center.distance_squared(position)),
        (false, false) => std::cmp::Ordering::Equal,
    });
    let (near, far) = clip_planes(center, extent * 0.5, position, forward, camera_spec);
    let projection = match scene.state.projection {
        Projection::Perspective => Mat4::perspective_rh(
            camera
                .map(|value| value.fov)
                .unwrap_or(camera_spec.fov_degrees)
                .to_radians(),
            aspect,
            near,
            far,
        ),
        Projection::Orthographic => {
            let height = camera
                .map(|value| value.orthographic_height / value.zoom.max(0.01))
                .unwrap_or(diagonal * 1.45);
            Mat4::orthographic_rh(
                -height * aspect / 2.0,
                height * aspect / 2.0,
                -height / 2.0,
                height / 2.0,
                near,
                far,
            )
        }
    };
    let background = match scene.state.background {
        Background::Dark => clear_color(&material.background_dark)?,
        Background::Light => clear_color(&material.background_light)?,
    };
    let mut labels = scene_labels(scene, projection * view, position, &occluders, &mesh_bounds)?;
    if let Some(warning) = scene.warnings.first() {
        labels.insert(
            0,
            RenderLabel {
                flat: true,
                anchor: [0.04, 0.04],
                text: format!(
                    "部分可用 · {} 项提示：{}",
                    scene.warnings.len(),
                    warning.message
                )
                .chars()
                .take(110)
                .collect(),
                color: [210, 170, 105],
            },
        );
    }
    Ok(RenderInput {
        labels,
        light_background: scene.state.background == Background::Light,
        batches,
        annotation_vertices: surface_annotation_vertices(
            scene,
            projection * view,
            position,
            &occluders,
            material.annotation_lift_pixels,
        )?,
        line_vertices,
        width: frame.width,
        height: frame.height,
        view_projection: projection * view,
        camera_position: position,
        camera_up,
        key_direction: camera_direction(material.key_direction),
        fill_direction: camera_direction(material.fill_direction),
        background,
        strokes: scene.state.strokes.clone(),
    })
}

/// Mirrors the screen-sized, depth-tested ink in web/src/surface-render.ts.
fn scene_labels(
    scene: &SceneDescriptor,
    vp: Mat4,
    camera: Vec3,
    occluders: &Occluders,
    bounds: &[(usize, Vec3, Vec3)],
) -> Result<Vec<RenderLabel>> {
    let mut labels = Vec::new();
    let inverse = vp.inverse();
    let project = |point: Vec3| -> Option<[f32; 2]> {
        let p = vp.project_point3(point);
        (p.is_finite() && p.z > 0.0 && p.z < 1.0 && p.x.abs() <= 1.0 && p.y.abs() <= 1.0)
            .then_some([(p.x + 1.0) * 0.5, (1.0 - p.y) * 0.5])
    };
    let color = |hex: &str| -> Result<[u8; 3]> {
        Ok(parse_hex_color(hex)
            .context("invalid label color")?
            .map(|v| (v * 255.0).round() as u8))
    };
    let visible_mesh = |index: usize| {
        scene
            .meshes
            .get(index)
            .is_some_and(|m| m.visible && m.opacity > 0.0)
    };
    for mark in &scene.state.annotations {
        if !visible_mesh(mark.mesh) {
            continue;
        }
        if !mark.visible {
            continue;
        }
        // Try a bounded set of representatives when the midpoint is obscured.
        let candidates = annotation_label_candidates(mark.points.len());
        for index in candidates {
            let p = mark.points[index];
            let point = Vec3::new(p[0] as f32, p[1] as f32, p[2] as f32);
            let Some(anchor) = project(point) else {
                continue;
            };
            let projected = vp.project_point3(point);
            let origin = if scene.state.projection == Projection::Orthographic {
                inverse.project_point3(Vec3::new(projected.x, projected.y, 0.0))
            } else {
                camera
            };
            if !surface_anchor_visible(origin, point, occluders) {
                continue;
            }
            let name = if mark.label.trim().is_empty() {
                "未命名标记"
            } else {
                &mark.label
            };
            labels.push(RenderLabel {
                anchor,
                text: name.into(),
                flat: true,
                color: color(&mark.color)?,
            });
            break;
        }
    }
    for (i, stroke) in scene.state.strokes.iter().enumerate() {
        if let Some(p) = stroke.points.get(stroke.points.len() / 2) {
            let aspect = scene.state.frame.width as f32 / scene.state.frame.height.max(1) as f32;
            let anchor = [
                ((p[0] * 2.0 - 1.0) * stroke.aspect / aspect + 1.0) * 0.5,
                p[1],
            ];
            if anchor.iter().all(|v| (0.0..=1.0).contains(v)) {
                labels.push(RenderLabel {
                    anchor,
                    text: stroke
                        .label
                        .as_ref()
                        .filter(|label| !label.is_empty())
                        .cloned()
                        .unwrap_or_else(|| format!("画笔 {}", i + 1)),
                    flat: true,
                    color: color(&stroke.color)?,
                });
            }
        }
    }
    for &(index, min, max) in bounds {
        let mesh = &scene.meshes[index];
        if mesh.opacity <= 0.0 {
            continue;
        }
        let Some(label) = &mesh.label else {
            continue;
        };
        let point = label
            .anchor
            .map(Vec3::from_array)
            .unwrap_or((min + max) * 0.5);
        if let Some(anchor) = project(point) {
            labels.push(RenderLabel {
                anchor,
                text: label.text.clone(),
                flat: false,
                color: color(&mesh.color)?,
            });
        }
    }
    for group in &scene.label_groups {
        let mut min = Vec3::splat(f32::INFINITY);
        let mut max = Vec3::splat(f32::NEG_INFINITY);
        for &(index, a, b) in bounds {
            if group.meshes.contains(&index) && visible_mesh(index) {
                min = min.min(a);
                max = max.max(b);
            }
        }
        if let Some(anchor) = project((min + max) * 0.5) {
            labels.push(RenderLabel {
                anchor,
                text: group.text.clone(),
                flat: false,
                color: [143, 169, 201],
            });
        }
    }
    Ok(labels)
}

fn surface_annotation_vertices(
    scene: &SceneDescriptor,
    vp: Mat4,
    camera_position: Vec3,
    occluders: &Occluders,
    lift_pixels: f32,
) -> Result<Vec<Vertex>> {
    let mut vertices = Vec::new();
    let ink: ScreenInk = serde_json::from_str(include_str!("../shaders/stroke.json"))?;
    let inverse = vp.inverse();
    let width = scene.state.frame.width.max(1) as f32;
    let height = scene.state.frame.height.max(1) as f32;
    for mark in &scene.state.annotations {
        if !mark.visible
            || !scene
                .meshes
                .get(mark.mesh)
                .is_some_and(|m| m.visible && m.opacity > 0.0)
        {
            continue;
        }
        let color = parse_color(&mark.color, 1.0)?;
        let points: Vec<_> = mark
            .points
            .iter()
            .map(|p| vp.project_point3(Vec3::new(p[0] as f32, p[1] as f32, p[2] as f32)))
            .collect();
        let vertex = |p: Vec3, x: f32, y: f32, color: [f32; 4], normal: Option<Vec3>| {
            let offset = p + Vec3::new(x * 2.0 / width, y * 2.0 / height, 0.0);
            let mut q = inverse.project_point3(offset);
            if let Some(normal) = normal {
                let origin = inverse.project_point3(Vec3::new(offset.x, offset.y, 0.0));
                let direction = (q - origin).normalize_or_zero();
                let denominator = direction.dot(normal);
                if denominator.abs() > 0.08 {
                    let anchor = inverse.project_point3(p);
                    q += direction * (anchor - q).dot(normal) / denominator;
                }
            }
            // Match SurfaceInk: a bounded subpixel lift along the viewing ray.
            let projected = vp.project_point3(q);
            let pixel = inverse.project_point3(projected + Vec3::new(2.0 / width, 0.0, 0.0));
            let near = inverse.project_point3(Vec3::new(projected.x, projected.y, 0.0));
            q += (near - q).normalize_or_zero() * pixel.distance(q) * lift_pixels;
            Vertex {
                position: q.to_array(),
                normal: [0.0; 3],
                color,
                curve: 0.0,
            }
        };
        let disk =
            |out: &mut Vec<Vertex>, p: Vec3, radius: f32, color: [f32; 4], normal: Option<Vec3>| {
                for i in 0..24 {
                    let a = i as f32 * std::f32::consts::PI / 12.0;
                    let b = (i + 1) as f32 * std::f32::consts::PI / 12.0;
                    out.extend([
                        vertex(p, 0.0, 0.0, color, normal),
                        vertex(p, a.cos() * radius, a.sin() * radius, color, normal),
                        vertex(p, b.cos() * radius, b.sin() * radius, color, normal),
                    ]);
                }
            };
        let visible = |p: Vec3| p.z > 0.0 && p.z < 1.0;
        if mark.kind == crate::scene::SurfaceAnnotationKind::Point {
            if let Some(&p) = points.first().filter(|p| visible(**p)) {
                let sample = mark.points[0];
                let anchor = Vec3::new(sample[0] as f32, sample[1] as f32, sample[2] as f32);
                // Orthographic rays are parallel; unproject the anchor on the near plane.
                let ray_origin = if scene.state.projection == Projection::Orthographic {
                    inverse.project_point3(Vec3::new(p.x, p.y, 0.0))
                } else {
                    camera_position
                };
                if !surface_anchor_visible(ray_origin, anchor, occluders) {
                    continue;
                }
                let p = Vec3::new(p.x, p.y, 0.001);
                disk(&mut vertices, p, 4.5, color, None);
            }
        } else {
            for (index, pair) in points.windows(2).enumerate() {
                let normal = |i: usize| {
                    Some(Vec3::new(
                        mark.normals[i][0] as f32,
                        mark.normals[i][1] as f32,
                        mark.normals[i][2] as f32,
                    ))
                };
                let a = pair[0];
                let b = pair[1];
                if !visible(a) || !visible(b) {
                    continue;
                }
                let dx = (b.x - a.x) * width;
                let dy = (b.y - a.y) * height;
                let length = dx.hypot(dy);
                if length <= f32::EPSILON {
                    continue;
                }
                let x = -dy / length * ink.ink_width / 2.0;
                let y = dx / length * ink.ink_width / 2.0;
                vertices.extend([
                    vertex(a, x, y, color, normal(index)),
                    vertex(a, -x, -y, color, normal(index)),
                    vertex(b, x, y, color, normal(index + 1)),
                    vertex(b, x, y, color, normal(index + 1)),
                    vertex(a, -x, -y, color, normal(index)),
                    vertex(b, -x, -y, color, normal(index + 1)),
                ]);
                disk(&mut vertices, a, ink.ink_width / 2.0, color, normal(index));
                disk(
                    &mut vertices,
                    b,
                    ink.ink_width / 2.0,
                    color,
                    normal(index + 1),
                );
            }
        }
    }
    Ok(vertices)
}

fn annotation_label_candidates(length: usize) -> impl Iterator<Item = usize> {
    // A fixed query budget independent of untrusted control/sample counts.
    [
        length / 2,
        0,
        length.saturating_sub(1),
        length / 4,
        length * 3 / 4,
    ]
    .into_iter()
    .filter(move |&i| i < length)
}

fn surface_anchor_visible(origin: Vec3, point: Vec3, occluders: &Occluders) -> bool {
    occluders.visible(origin, point)
}

// Orthographic framing is independent of eye distance. Match the Viewer orbit safety.
fn orthographic_position(
    position: Vec3,
    target: Vec3,
    center: Vec3,
    half: Vec3,
    camera: &CameraSpec,
) -> Vec3 {
    let offset = position - target;
    let safe_distance =
        center.distance(target) + half.length().max(1e-6) * (1.0 + camera.clip_padding_factor);
    if offset.length() < safe_distance {
        target + offset.try_normalize().unwrap_or(Vec3::Z) * safe_distance
    } else {
        position
    }
}

/// Mirrors `MeshViewer.updateClipping` in web/src/viewer.ts; change both in lockstep.
fn clip_planes(
    center: Vec3,
    half: Vec3,
    camera_position: Vec3,
    forward: Vec3,
    camera: &CameraSpec,
) -> (f32, f32) {
    let radius = half.length().max(1e-6);
    // Corner depths of an AABB span the center depth by the summed per-axis projections.
    let span = forward.abs().dot(half);
    let center_depth = (center - camera_position).dot(forward);
    let padding = (radius * camera.clip_padding_factor).max(1e-6);
    let near = (radius * camera.near_floor_factor).max(center_depth - span - padding);
    // far must clear near by a full slack window even when the near floor wins.
    let far = (near + padding * 2.0).max(center_depth + span + padding);
    (near, far)
}

fn overlay_screen_strokes(
    image: &mut RgbaImage,
    strokes: &[ScreenStroke],
    ink: &ScreenInk,
    source_width: u32,
    source_height: u32,
) -> Result<()> {
    if strokes.is_empty() {
        return Ok(());
    }
    let width = image.width();
    let height = image.height();
    let frame_aspect = source_width as f32 / source_height.max(1) as f32;
    let scale = (width as f32 / source_width.max(1) as f32)
        .min(height as f32 / source_height.max(1) as f32);
    let mut pixmap = PixmapMut::from_bytes(image.as_mut(), width, height)
        .context("invalid screen stroke target")?;

    let stroke_style = |width: f32| Stroke {
        width,
        line_cap: LineCap::Round,
        line_join: LineJoin::Round,
        ..Default::default()
    };
    let outline = stroke_style(ink.outline_width * scale);
    let core = stroke_style(ink.ink_width * scale);
    let mut outline_paint = Paint::default();
    outline_paint.set_color_rgba8(
        ink.outline_color[0],
        ink.outline_color[1],
        ink.outline_color[2],
        (ink.outline_alpha * 255.0).round() as u8,
    );
    outline_paint.anti_alias = true;

    for stroke in strokes {
        let mut builder = PathBuilder::new();
        let display_points = stroke
            .points
            .iter()
            .map(|point| {
                let ndc_x = point[0] * 2.0 - 1.0;
                let x = ((ndc_x * stroke.aspect / frame_aspect + 1.0) * 0.5) * width as f32;
                let y = point[1] * height as f32;
                [x, y]
            })
            .collect::<Vec<_>>();
        let Some(first) = display_points.first() else {
            continue;
        };
        builder.move_to(first[0], first[1]);
        for points in display_points[1..].windows(2) {
            let point = points[0];
            let next = points[1];
            builder.quad_to(
                point[0],
                point[1],
                (point[0] + next[0]) * 0.5,
                (point[1] + next[1]) * 0.5,
            );
        }
        if let Some(last) = display_points.last() {
            builder.line_to(last[0], last[1]);
        }
        let Some(path) = builder.finish() else {
            continue;
        };

        pixmap.stroke_path(&path, &outline_paint, &outline, Transform::identity(), None);

        let [red, green, blue] = parse_hex_color(&stroke.color)
            .context("invalid screen stroke color during rendering")?;
        let mut core_paint = Paint::default();
        core_paint.set_color_rgba8(
            (red * 255.0).round() as u8,
            (green * 255.0).round() as u8,
            (blue * 255.0).round() as u8,
            255,
        );
        core_paint.anti_alias = true;
        pixmap.stroke_path(&path, &core_paint, &core, Transform::identity(), None);
    }
    Ok(())
}

fn render_dimensions(width: u32, height: u32) -> (u32, u32) {
    let longest = width.max(height);
    if longest <= 2048 {
        return (width, height);
    }
    let scale = 2048.0 / longest as f64;
    (
        (width as f64 * scale).round().max(1.0) as u32,
        (height as f64 * scale).round().max(1.0) as u32,
    )
}

/// Static pipeline shapes; one factory creates all of them so pipeline policy
/// (depth compare, MSAA, blend mask) stays in exactly one place.
enum PipelineKind {
    Mesh,
    Line,
    Point,
}

const MESH_VERTEX_LAYOUT: wgpu::VertexBufferLayout<'static> = wgpu::VertexBufferLayout {
    array_stride: mem::size_of::<Vertex>() as u64,
    step_mode: wgpu::VertexStepMode::Vertex,
    attributes: &wgpu::vertex_attr_array![0 => Float32x3, 1 => Float32x3, 2 => Float32x4, 3 => Float32],
};

const POINT_VERTEX_LAYOUT: wgpu::VertexBufferLayout<'static> = wgpu::VertexBufferLayout {
    array_stride: mem::size_of::<[f32; 3]>() as u64,
    step_mode: wgpu::VertexStepMode::Instance,
    attributes: &wgpu::vertex_attr_array![0 => Float32x3],
};

fn create_pipeline(
    device: &wgpu::Device,
    layout: &wgpu::PipelineLayout,
    shader: &wgpu::ShaderModule,
    format: wgpu::TextureFormat,
    kind: PipelineKind,
    blend: Option<wgpu::BlendState>,
    depth_write_enabled: bool,
) -> wgpu::RenderPipeline {
    let (label, vertex_entry, fragment_entry, vertex_buffers, topology) = match kind {
        PipelineKind::Mesh => (
            "Blind pipeline",
            "vs_main",
            "fs_main",
            &[MESH_VERTEX_LAYOUT][..],
            wgpu::PrimitiveTopology::TriangleList,
        ),
        PipelineKind::Line => (
            "Blind line pipeline",
            "vs_main",
            "fs_main",
            &[MESH_VERTEX_LAYOUT][..],
            wgpu::PrimitiveTopology::LineList,
        ),
        PipelineKind::Point => (
            "Blind point cloud pipeline",
            "point_vs_main",
            "point_fs_main",
            &[POINT_VERTEX_LAYOUT][..],
            wgpu::PrimitiveTopology::TriangleStrip,
        ),
    };
    device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some(label),
        layout: Some(layout),
        vertex: wgpu::VertexState {
            module: shader,
            entry_point: vertex_entry,
            compilation_options: Default::default(),
            buffers: vertex_buffers,
        },
        fragment: Some(wgpu::FragmentState {
            module: shader,
            entry_point: fragment_entry,
            compilation_options: Default::default(),
            targets: &[Some(wgpu::ColorTargetState {
                format,
                blend,
                write_mask: wgpu::ColorWrites::ALL,
            })],
        }),
        primitive: wgpu::PrimitiveState {
            topology,
            cull_mode: None,
            ..Default::default()
        },
        depth_stencil: Some(wgpu::DepthStencilState {
            format: DEPTH_FORMAT,
            depth_write_enabled,
            depth_compare: wgpu::CompareFunction::LessEqual,
            stencil: Default::default(),
            bias: Default::default(),
        }),
        multisample: wgpu::MultisampleState {
            count: SAMPLE_COUNT,
            ..Default::default()
        },
        multiview: None,
    })
}

fn append_axes(vertices: &mut Vec<Vertex>, min: Vec3, max: Vec3) {
    let length = (max - min).length().max(1.0) * 0.09;
    let origin = Vec3::new(min.x, min.y, min.z);
    let normal = [0.0, 1.0, 0.0];
    for (direction, color) in [
        (Vec3::X, [0.78, 0.24, 0.22, 1.0]),
        (Vec3::Y, [0.25, 0.68, 0.42, 1.0]),
        (Vec3::Z, [0.30, 0.50, 0.82, 1.0]),
    ] {
        vertices.push(Vertex {
            position: origin.to_array(),
            normal,
            color,
            curve: 0.0,
        });
        vertices.push(Vertex {
            position: (origin + direction * length).to_array(),
            normal,
            color,
            curve: 0.0,
        });
    }
}

fn parse_color(value: &str, alpha: f32) -> Result<[f32; 4]> {
    let [r, g, b] = parse_hex_color(value).context("invalid color")?;
    Ok([
        srgb_to_linear(r as f64) as f32,
        srgb_to_linear(g as f64) as f32,
        srgb_to_linear(b as f64) as f32,
        alpha,
    ])
}

/// sRGB hex string converted to the linear clear color the GPU expects.
fn clear_color(hex: &str) -> Result<wgpu::Color> {
    let [r, g, b] = parse_hex_color(hex).context("invalid background color")?;
    Ok(wgpu::Color {
        r: srgb_to_linear(r as f64),
        g: srgb_to_linear(g as f64),
        b: srgb_to_linear(b as f64),
        a: 1.0,
    })
}

fn srgb_to_linear(value: f64) -> f64 {
    if value <= 0.04045 {
        value / 12.92
    } else {
        ((value + 0.055) / 1.055).powf(2.4)
    }
}

fn align_to(value: u32, alignment: u32) -> u32 {
    value.div_ceil(alignment) * alignment
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::Rgba;

    #[tokio::test]
    async fn scene_translation_moves_render_geometry_without_changing_source() {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/tetra.ply");
        let mut scene = SceneDescriptor::create(&[path.clone(), path], None)
            .await
            .unwrap();
        scene.state.axes = false;
        scene.meshes[1].translation = [100.0, 20.0, -5.0];
        let material: MatteShader =
            serde_json::from_str(include_str!("../shaders/matte.json")).unwrap();
        let input = load_scene_geometry(&scene, &material).unwrap();
        assert!(
            (input.batches[1].center
                - input.batches[0].center
                - glam::Vec3::new(100.0, 20.0, -5.0))
            .length()
                < 0.0001
        );
        assert_eq!(scene.meshes[0].revision, scene.meshes[1].revision);
    }

    #[tokio::test]
    async fn renderer_initializes_all_shader_pipelines() {
        Renderer::new().await.unwrap();
    }

    #[tokio::test]
    async fn point_cloud_scene_builds_and_renders_instanced_batch() {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/cloud.ply");
        // Two layers exercise the aligned dynamic-uniform offset used after
        // the first point batch, not only the zero-offset happy path.
        let mut scene = SceneDescriptor::create(&[path.clone(), path], None)
            .await
            .unwrap();
        scene.state.axes = false;
        scene.state.frame.width = 64;
        scene.state.frame.height = 64;
        let material: MatteShader =
            serde_json::from_str(include_str!("../shaders/matte.json")).unwrap();

        let input = load_scene_geometry(&scene, &material).unwrap();
        assert_eq!(input.batches.len(), 2);
        for batch in &input.batches {
            match &batch.geometry {
                BatchGeometry::Points { positions, .. } => assert_eq!(positions.len(), 27),
                BatchGeometry::Mesh { .. } => panic!("point-only PLY rendered as a triangle Mesh"),
            }
        }

        let sources = scene
            .meshes
            .iter()
            .map(|m| Some(std::fs::read(&m.path).unwrap()))
            .collect();
        let png = Renderer::new()
            .await
            .unwrap()
            .render(&scene, sources)
            .await
            .unwrap();
        let image = image::load_from_memory_with_format(&png, ImageFormat::Png).unwrap();
        assert_eq!((image.width(), image.height()), (64, 64));
    }

    #[tokio::test]
    async fn image_labels_follow_annotation_names_visibility_and_occlusion() {
        use crate::scene::{CameraState, SurfaceAnnotation, SurfaceAnnotationKind};
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/tetra.ply");
        let mut scene = SceneDescriptor::create(&[path], None).await.unwrap();
        scene.state.axes = false;
        scene.state.frame.width = 390;
        scene.state.frame.height = 844;
        scene.state.camera = Some(CameraState {
            position: [0.3, 0.3, 3.0],
            target: [0.3, 0.3, 0.0],
            up: [0.0, 1.0, 0.0],
            fov: 34.0,
            zoom: 1.0,
            orthographic_height: 2.0,
        });
        scene.state.annotations.push(SurfaceAnnotation {
            id: "point".into(),
            mesh: 0,
            revision: scene.meshes[0].revision.clone(),
            kind: SurfaceAnnotationKind::Point,
            label: "检查位置 A".into(),
            color: "#ff6b5e".into(),
            visible: true,
            closed: false,
            points: vec![[0.3, 0.3, 0.4]],
            normals: vec![[0.57735; 3]],
            controls: vec![0],
        });
        let material: MatteShader =
            serde_json::from_str(include_str!("../shaders/matte.json")).unwrap();
        let input = load_scene_geometry(&scene, &material).unwrap();
        assert_eq!(input.labels.len(), 1);
        assert_eq!(input.labels[0].text, "检查位置 A");
        scene.state.annotations[0].visible = false;
        let hidden = load_scene_geometry(&scene, &material).unwrap();
        assert!(hidden.labels.is_empty());
        assert!(hidden.annotation_vertices.is_empty());
        scene.state.annotations[0].visible = true;
        scene.meshes[0].opacity = 0.0;
        let transparent = load_scene_geometry(&scene, &material).unwrap();
        assert!(transparent.labels.is_empty());
        assert!(transparent.annotation_vertices.is_empty());
        scene.meshes[0].opacity = 1.0;
        scene.state.annotations[0].points[0] = [0.3, 0.3, 0.0];
        let back = load_scene_geometry(&scene, &material).unwrap();
        assert!(back.labels.is_empty());
        assert!(back.annotation_vertices.is_empty());
        scene.state.strokes.push(ScreenStroke {
            label: Some("屏幕备注".into()),
            color: "#ff6b5e".into(),
            aspect: 390.0 / 844.0,
            points: vec![[0.2, 0.2], [0.4, 0.4]],
        });
        let named = load_scene_geometry(&scene, &material).unwrap();
        assert_eq!(named.labels[0].text, "屏幕备注");
        assert_eq!(named.labels[0].anchor, [0.4, 0.4]);
        scene.state.strokes[0].label = None;
        assert_eq!(
            load_scene_geometry(&scene, &material).unwrap().labels[0].text,
            "画笔 1"
        );
        assert_eq!(
            annotation_label_candidates(4096).count(),
            5,
            "label visibility queries have a fixed budget"
        );
    }

    #[test]
    fn oversized_render_dimensions_keep_the_scene_aspect_ratio() {
        assert_eq!(render_dimensions(4096, 2160), (2048, 1080));
        assert_eq!(render_dimensions(1200, 900), (1200, 900));
    }

    #[tokio::test]
    async fn real_depth_occludes_later_meshes_and_loops_with_a_close_near_plane() {
        use crate::scene::CameraState;
        let dir = tempfile::tempdir().unwrap();
        let plane = dir.path().join("plane.ply");
        std::fs::write(&plane, "ply\nformat ascii 1.0\nelement vertex 4\nproperty float x\nproperty float y\nproperty float z\nelement face 2\nproperty list uchar int vertex_indices\nend_header\n-5 -5 0\n5 -5 0\n5 5 0\n-5 5 0\n3 0 1 2\n3 0 2 3\n").unwrap();
        let curve = dir.path().join("loop.pts");
        std::fs::write(&curve, "-2 -2 -1\n2 -2 -1\n2 2 -1\n-2 2 -1\n").unwrap();
        let mut scene =
            SceneDescriptor::create(&[plane.clone(), plane.clone(), curve, plane], None)
                .await
                .unwrap();
        scene.meshes[0].color = "#ff0000".into();
        scene.meshes[1].color = "#0000ff".into();
        scene.meshes[1].translation[2] = -1.0;
        scene.meshes[2].color = "#00ff00".into();
        // Another panel crosses the camera depth but remains outside the view.
        scene.meshes[3].translation = [100.0, 0.0, 40.0];
        scene.state.axes = false;
        scene.state.frame.width = 512;
        scene.state.frame.height = 512;
        scene.state.camera = Some(CameraState {
            position: [0.0, 0.0, 40.0],
            target: [0.0; 3],
            up: [0.0, 1.0, 0.0],
            fov: 34.0,
            zoom: 1.0,
            orthographic_height: 24.0,
        });
        let renderer = Renderer::new().await.unwrap();
        for projection in [Projection::Perspective, Projection::Orthographic] {
            scene.state.projection = projection;
            let sources = scene
                .meshes
                .iter()
                .map(|m| Some(std::fs::read(&m.path).unwrap()))
                .collect();
            let bytes = renderer.render(&scene, sources).await.unwrap();
            let image = image::load_from_memory(&bytes).unwrap().to_rgba8();
            for y in 192..320 {
                for x in 192..320 {
                    let p = image.get_pixel(x, y);
                    assert!(
                        u16::from(p[0]) > u16::from(p[1]) * 2
                            && u16::from(p[0]) > u16::from(p[2]) * 2,
                        "rear geometry leaked at {x},{y}: {p:?}"
                    );
                }
            }
            // A visible curve must still render after moving in front of the surface.
            scene.meshes[2].translation[2] = 2.0;
            let sources = scene
                .meshes
                .iter()
                .map(|m| Some(std::fs::read(&m.path).unwrap()))
                .collect();
            let bytes = renderer.render(&scene, sources).await.unwrap();
            let image = image::load_from_memory(&bytes).unwrap().to_rgba8();
            assert!(
                image
                    .pixels()
                    .filter(|p| u16::from(p[1]) > u16::from(p[0]) * 2 && p[1] > 80)
                    .count()
                    > 10
            );
            scene.meshes[2].translation[2] = 0.0;

            // Coincident surfaces retain deterministic resource precedence.
            scene.meshes[1].translation[2] = 0.0;
            let sources = scene
                .meshes
                .iter()
                .map(|m| Some(std::fs::read(&m.path).unwrap()))
                .collect();
            let bytes = renderer.render(&scene, sources).await.unwrap();
            let image = image::load_from_memory(&bytes).unwrap().to_rgba8();
            assert!(image.get_pixel(256, 256)[2] > 200);
            scene.meshes[1].translation[2] = -1.0;
        }
    }

    #[test]
    fn clip_planes_stay_tight_when_the_camera_is_close_to_the_scene() {
        let material: MatteShader =
            serde_json::from_str(include_str!("../shaders/matte.json")).unwrap();
        let (near, far) = clip_planes(
            Vec3::ZERO,
            Vec3::splat(1.0),
            Vec3::new(0.0, 0.0, 6.8),
            Vec3::NEG_Z,
            &material.camera,
        );

        // A saved orthographic eye inside the scene must be moved back without
        // changing its target or viewing direction; the entire box then fits.
        let eye = orthographic_position(
            Vec3::new(0.0, 0.0, 0.2),
            Vec3::ZERO,
            Vec3::ZERO,
            Vec3::splat(1.0),
            &material.camera,
        );
        let (ortho_near, ortho_far) = clip_planes(
            Vec3::ZERO,
            Vec3::splat(1.0),
            eye,
            Vec3::NEG_Z,
            &material.camera,
        );
        assert!(eye.z - 1.0 > ortho_near && eye.z + 1.0 < ortho_far);
        assert_eq!(eye.x, 0.0);
        assert_eq!(eye.y, 0.0);

        assert!(near > 5.0, "near plane was too loose: {near}");
        assert!(far < 8.0, "far plane was too loose: {far}");
        assert!(
            far / near < 2.0,
            "depth ratio was too large: {}",
            far / near
        );
    }

    #[test]
    fn screen_strokes_are_composited_over_the_rendered_pixels() {
        let background = Rgba([41, 44, 50, 255]);
        let mut image = RgbaImage::from_pixel(100, 100, background);
        overlay_screen_strokes(
            &mut image,
            &[ScreenStroke {
                label: None,
                color: "#ff6b5e".into(),
                aspect: 1.0,
                points: vec![[0.2, 0.5], [0.8, 0.5]],
            }],
            &ScreenInk {
                ink_width: 4.25,
                outline_width: 7.0,
                outline_color: [13, 16, 20],
                outline_alpha: 0.46,
            },
            100,
            100,
        )
        .unwrap();
        assert_ne!(*image.get_pixel(50, 50), background);
        assert_eq!(*image.get_pixel(2, 2), background);
    }
}
