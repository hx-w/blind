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
    depth_bias: f32,
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
    point_scale: [f32; 4],
    point_color: [f32; 4],
    point_depth_bias: [f32; 4],
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
    depth_bias_step: f32,
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

    pub async fn render(&self, scene: &SceneDescriptor) -> Result<Vec<u8>> {
        let scene = scene.clone();
        let material = self.material.clone();
        let geometry =
            tokio::task::spawn_blocking(move || load_scene_geometry(&scene, &material)).await??;
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
            point_scale: [
                self.material.point_diameter_pixels / width as f32,
                self.material.point_diameter_pixels / height as f32,
                0.0,
                0.0,
            ],
            point_color: [0.0; 4],
            point_depth_bias: [0.0; 4],
        };
        // Every batch gets its own uniform slot so point batches carry their
        // shared color and depth bias without paying per point.
        let uniform_size = mem::size_of::<Uniform>();
        let uniform_stride = align_to(
            uniform_size as u32,
            self.device.limits().min_uniform_buffer_offset_alignment,
        );
        let mut uniform_bytes = vec![0_u8; uniform_stride as usize * input.batches.len().max(1)];
        for index in 0..input.batches.len().max(1) {
            let mut slot = uniform;
            if let Some(BatchGeometry::Points {
                color, depth_bias, ..
            }) = input.batches.get(index).map(|batch| &batch.geometry)
            {
                slot.point_color = *color;
                slot.point_depth_bias = [*depth_bias, 0.0, 0.0, 0.0];
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
        let mut encoded = Cursor::new(Vec::new());
        image.write_to(&mut encoded, ImageFormat::Png)?;
        Ok(encoded.into_inner())
    }
}

struct RenderInput {
    batches: Vec<RenderBatch>,
    line_vertices: Vec<Vertex>,
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
        depth_bias: f32,
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

fn load_scene_geometry(scene: &SceneDescriptor, material: &MatteShader) -> Result<RenderInput> {
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
        let geometry = Geometry::load(Path::new(&mesh.path), mesh.format)?;
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
    let mut batches = Vec::new();
    let mut line_vertices = Vec::new();
    let wire = scene.state.shading == Shading::Wire;
    let flat = scene.state.shading == Shading::Flat;
    for (layer, mesh, geometry, mesh_min, mesh_max) in loaded {
        let color = parse_color(&mesh.color, mesh.opacity)?;
        let depth_bias = layer as f32 * material.depth_bias_step;
        let center = (Vec3::from_array(mesh_min) + Vec3::from_array(mesh_max)) * 0.5;
        let translucent = mesh.opacity < material.translucent_threshold;
        if geometry.is_point_cloud() {
            batches.push(RenderBatch {
                // The position vec moves straight into the batch; the shared
                // color and depth bias live in the batch's uniform slot.
                geometry: BatchGeometry::Points {
                    positions: geometry.positions,
                    color,
                    depth_bias,
                },
                translucent,
                center,
            });
            continue;
        }
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
                depth_bias,
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
    let position = camera
        .map(|value| Vec3::from_array(value.position))
        .unwrap_or(
            center
                + Vec3::from_array(camera_spec.default_view_direction).normalize_or_zero()
                    * default_distance,
        );
    let target = camera
        .map(|value| Vec3::from_array(value.target))
        .unwrap_or(center);
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
    Ok(RenderInput {
        batches,
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
            depth_compare: wgpu::CompareFunction::Less,
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
            depth_bias: 0.0,
        });
        vertices.push(Vertex {
            position: (origin + direction * length).to_array(),
            normal,
            color,
            depth_bias: 0.0,
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

        let png = Renderer::new().await.unwrap().render(&scene).await.unwrap();
        let image = image::load_from_memory_with_format(&png, ImageFormat::Png).unwrap();
        assert_eq!((image.width(), image.height()), (64, 64));
    }

    #[test]
    fn oversized_render_dimensions_keep_the_scene_aspect_ratio() {
        assert_eq!(render_dimensions(4096, 2160), (2048, 1080));
        assert_eq!(render_dimensions(1200, 900), (1200, 900));
    }

    #[test]
    fn shared_depth_bias_separates_layers_on_16_bit_depth_buffers() {
        let material: MatteShader =
            serde_json::from_str(include_str!("../shaders/matte.json")).unwrap();
        let two_depth_units_in_webgl_clip_space = 4.0 / 65_536.0;
        assert!(material.depth_bias_step >= two_depth_units_in_webgl_clip_space);
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
