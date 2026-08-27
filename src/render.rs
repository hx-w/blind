use std::{borrow::Cow, io::Cursor, mem, path::Path};

use anyhow::{Context, Result, bail};
use bytemuck::{Pod, Zeroable};
use glam::{Mat4, Vec3};
use image::{ImageFormat, RgbaImage};
use wgpu::util::DeviceExt;

use crate::{
    mesh::Geometry,
    scene::{Background, Projection, SceneDescriptor, Shading, parse_hex_color},
};

const MAX_RENDER_SOURCE_BYTES: u64 = 512 * 1024 * 1024;
const MAX_RENDER_TRIANGLES: usize = 2_000_000;

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct Vertex {
    position: [f32; 3],
    normal: [f32; 3],
    color: [f32; 4],
}

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct Uniform {
    view_projection: [[f32; 4]; 4],
    light_direction: [f32; 4],
}

pub struct Renderer {
    device: wgpu::Device,
    queue: wgpu::Queue,
    camera_layout: wgpu::BindGroupLayout,
    triangle_pipeline: wgpu::RenderPipeline,
    line_pipeline: wgpu::RenderPipeline,
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
                    has_dynamic_offset: false,
                    min_binding_size: None,
                },
                count: None,
            }],
        });
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("Blind pipeline layout"),
            bind_group_layouts: &[&camera_layout],
            push_constant_ranges: &[],
        });
        let triangle_pipeline = create_pipeline(
            &device,
            &pipeline_layout,
            &shader,
            format,
            wgpu::PrimitiveTopology::TriangleList,
        );
        let line_pipeline = create_pipeline(
            &device,
            &pipeline_layout,
            &shader,
            format,
            wgpu::PrimitiveTopology::LineList,
        );
        Ok(Self {
            device,
            queue,
            camera_layout,
            triangle_pipeline,
            line_pipeline,
        })
    }

    pub async fn render(&self, scene: &SceneDescriptor) -> Result<Vec<u8>> {
        let scene = scene.clone();
        let geometry = tokio::task::spawn_blocking(move || load_scene_geometry(&scene)).await??;
        self.render_geometry(&geometry).await
    }

    async fn render_geometry(&self, input: &RenderInput) -> Result<Vec<u8>> {
        let width = input.width.clamp(240, 2048);
        let height = input.height.clamp(240, 2048);
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
        let depth_texture = self.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("Blind depth"),
            size: wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Depth24Plus,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
            view_formats: &[],
        });
        let uniform = Uniform {
            view_projection: input.view_projection.to_cols_array_2d(),
            light_direction: [0.45, 0.75, 0.55, 0.0],
        };
        let uniform_buffer = self
            .device
            .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("Camera uniform"),
                contents: bytemuck::bytes_of(&uniform),
                usage: wgpu::BufferUsages::UNIFORM,
            });
        let bind_group = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("Camera bind group"),
            layout: &self.camera_layout,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: uniform_buffer.as_entire_binding(),
            }],
        });
        let triangle_buffer = (!input.mesh_vertices.is_empty()).then(|| {
            self.device
                .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                    label: Some("Mesh vertices"),
                    contents: bytemuck::cast_slice(&input.mesh_vertices),
                    usage: wgpu::BufferUsages::VERTEX,
                })
        });
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
                    view: &color_view,
                    resolve_target: None,
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
            pass.set_bind_group(0, &bind_group, &[]);
            if let Some(buffer) = &triangle_buffer {
                pass.set_pipeline(&self.triangle_pipeline);
                pass.set_vertex_buffer(0, buffer.slice(..));
                pass.draw(0..input.mesh_vertices.len() as u32, 0..1);
            }
            if let Some(buffer) = &line_buffer {
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
        let image = RgbaImage::from_raw(width, height, pixels).context("invalid render buffer")?;
        let mut encoded = Cursor::new(Vec::new());
        image.write_to(&mut encoded, ImageFormat::Png)?;
        Ok(encoded.into_inner())
    }
}

struct RenderInput {
    mesh_vertices: Vec<Vertex>,
    line_vertices: Vec<Vertex>,
    width: u32,
    height: u32,
    view_projection: Mat4,
    background: wgpu::Color,
}

fn load_scene_geometry(scene: &SceneDescriptor) -> Result<RenderInput> {
    let visible: Vec<_> = scene.meshes.iter().filter(|mesh| mesh.visible).collect();
    if visible.is_empty() {
        bail!("scene has no visible Meshes");
    }
    let mut loaded = Vec::new();
    let mut source_bytes = 0_u64;
    let mut triangles = 0_usize;
    let mut bounds_min = Vec3::splat(f32::INFINITY);
    let mut bounds_max = Vec3::splat(f32::NEG_INFINITY);
    for mesh in visible {
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
        let (min, max) = geometry.bounds();
        bounds_min = bounds_min.min(Vec3::from_array(min));
        bounds_max = bounds_max.max(Vec3::from_array(max));
        loaded.push((mesh, geometry));
    }
    let mut mesh_vertices = Vec::new();
    let mut line_vertices = Vec::new();
    let wire = scene.state.shading == Shading::Wire;
    let flat = scene.state.shading == Shading::Flat;
    for (mesh, geometry) in loaded {
        let color = parse_color(&mesh.color, mesh.opacity)?;
        let normals = (!flat).then(|| geometry.smooth_normals());
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
                mesh_vertices.extend([make(triangle[0]), make(triangle[1]), make(triangle[2])]);
            }
        }
    }
    if scene.state.grid {
        append_grid(
            &mut line_vertices,
            bounds_min,
            bounds_max,
            scene.state.background == Background::Light,
        );
    }
    if scene.state.axes {
        append_axes(&mut line_vertices, bounds_min, bounds_max);
    }
    let frame = &scene.state.frame;
    let aspect = frame.width as f32 / frame.height.max(1) as f32;
    let center = (bounds_min + bounds_max) * 0.5;
    let diagonal = (bounds_max - bounds_min).length().max(0.001);
    let camera = scene.state.camera.as_ref();
    let position = camera
        .map(|value| Vec3::from_array(value.position))
        .unwrap_or(center + Vec3::new(diagonal * 1.15, diagonal * 0.85, diagonal * 1.45));
    let target = camera
        .map(|value| Vec3::from_array(value.target))
        .unwrap_or(center);
    let up = camera
        .map(|value| Vec3::from_array(value.up))
        .unwrap_or(Vec3::Y);
    let view = Mat4::look_at_rh(position, target, up);
    let projection = match scene.state.projection {
        Projection::Perspective => Mat4::perspective_rh(
            camera.map(|value| value.fov).unwrap_or(34.0).to_radians(),
            aspect,
            diagonal * 0.001,
            diagonal * 100.0,
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
                diagonal * 0.001,
                diagonal * 100.0,
            )
        }
    };
    let background = match scene.state.background {
        Background::Dark => wgpu::Color {
            r: 0.033,
            g: 0.038,
            b: 0.047,
            a: 1.0,
        },
        Background::Light => wgpu::Color {
            r: 0.84,
            g: 0.86,
            b: 0.89,
            a: 1.0,
        },
    };
    Ok(RenderInput {
        mesh_vertices,
        line_vertices,
        width: frame.width,
        height: frame.height,
        view_projection: projection * view,
        background,
    })
}

fn create_pipeline(
    device: &wgpu::Device,
    layout: &wgpu::PipelineLayout,
    shader: &wgpu::ShaderModule,
    format: wgpu::TextureFormat,
    topology: wgpu::PrimitiveTopology,
) -> wgpu::RenderPipeline {
    device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some("Blind pipeline"), layout: Some(layout),
        vertex: wgpu::VertexState { module: shader, entry_point: "vs_main", compilation_options: Default::default(), buffers: &[wgpu::VertexBufferLayout {
            array_stride: mem::size_of::<Vertex>() as u64, step_mode: wgpu::VertexStepMode::Vertex,
            attributes: &wgpu::vertex_attr_array![0 => Float32x3, 1 => Float32x3, 2 => Float32x4],
        }] },
        fragment: Some(wgpu::FragmentState { module: shader, entry_point: "fs_main", compilation_options: Default::default(), targets: &[Some(wgpu::ColorTargetState {
            format, blend: Some(wgpu::BlendState::ALPHA_BLENDING), write_mask: wgpu::ColorWrites::ALL,
        })] }),
        primitive: wgpu::PrimitiveState { topology, cull_mode: None, ..Default::default() },
        depth_stencil: Some(wgpu::DepthStencilState { format: wgpu::TextureFormat::Depth24Plus, depth_write_enabled: true, depth_compare: wgpu::CompareFunction::Less, stencil: Default::default(), bias: Default::default() }),
        multisample: Default::default(), multiview: None,
    })
}

fn append_grid(vertices: &mut Vec<Vertex>, min: Vec3, max: Vec3, light: bool) {
    let size = (max - min).length().max(1.0) * 1.5;
    let center = (min + max) * 0.5;
    let y = min.y - size * 0.03;
    let color = if light {
        [0.22, 0.25, 0.29, 0.22]
    } else {
        [0.55, 0.60, 0.66, 0.18]
    };
    let normal = [0.0, 1.0, 0.0];
    for step in -10..=10 {
        let offset = step as f32 / 10.0 * size;
        vertices.push(Vertex {
            position: [center.x - size, y, center.z + offset],
            normal,
            color,
        });
        vertices.push(Vertex {
            position: [center.x + size, y, center.z + offset],
            normal,
            color,
        });
        vertices.push(Vertex {
            position: [center.x + offset, y, center.z - size],
            normal,
            color,
        });
        vertices.push(Vertex {
            position: [center.x + offset, y, center.z + size],
            normal,
            color,
        });
    }
}

fn append_axes(vertices: &mut Vec<Vertex>, min: Vec3, max: Vec3) {
    let length = (max - min).length().max(1.0) * 0.25;
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
        });
        vertices.push(Vertex {
            position: (origin + direction * length).to_array(),
            normal,
            color,
        });
    }
}

fn parse_color(value: &str, alpha: f32) -> Result<[f32; 4]> {
    let [r, g, b] = parse_hex_color(value).context("invalid color")?;
    Ok([r, g, b, alpha])
}

fn align_to(value: u32, alignment: u32) -> u32 {
    value.div_ceil(alignment) * alignment
}
