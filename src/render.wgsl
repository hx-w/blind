struct Camera {
  view_projection: mat4x4<f32>,
  key_direction: vec4<f32>,
  fill_direction: vec4<f32>,
  lighting: vec4<f32>,
  camera_position: vec4<f32>,
  camera_up: vec4<f32>,
  finish: vec4<f32>,
  tone: vec4<f32>,
  surface: vec4<f32>,
  curve_surface: vec4<f32>,
  curve_edge: vec4<f32>,
  point_scale: vec4<f32>,
  point_color: vec4<f32>,
};

@group(0) @binding(0) var<uniform> camera: Camera;

struct VertexInput {
  @location(0) position: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) color: vec4<f32>,
  @location(3) curve: f32,
};

struct VertexOutput {
  @builtin(position) clip_position: vec4<f32>,
  @location(0) normal: vec3<f32>,
  @location(1) color: vec4<f32>,
  @location(2) world_position: vec3<f32>,
  @location(3) @interpolate(flat) curve: f32,
};

@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;
  output.clip_position = camera.view_projection * vec4<f32>(input.position, 1.0);
  output.normal = input.normal;
  output.color = input.color;
  output.world_position = input.position;
  output.curve = input.curve;
  return output;
}

/// Shared matte lighting (wrapped key/fill, hemisphere, view facing, tone
/// clamp). This is the cross-renderer contract with web/src/material.ts;
/// change both in lockstep.
fn matte_light(normal: vec3<f32>, view_direction: vec3<f32>) -> f32 {
  let key = clamp((dot(normal, normalize(camera.key_direction.xyz)) + camera.finish.y) / (1.0 + camera.finish.y), 0.0, 1.0);
  let fill = clamp((dot(normal, normalize(camera.fill_direction.xyz)) + camera.finish.y) / (1.0 + camera.finish.y), 0.0, 1.0);
  let hemisphere = dot(normal, normalize(camera.camera_up.xyz)) * 0.5 + 0.5;
  let facing = clamp((dot(normal, view_direction) + camera.finish.y) / (1.0 + camera.finish.y), 0.0, 1.0);
  var light = camera.lighting.x + key * camera.lighting.y + fill * camera.lighting.z
    + hemisphere * camera.lighting.w + facing * camera.finish.x;
  return clamp((light - camera.tone.x) * camera.finish.z + camera.tone.x, camera.tone.y, camera.tone.z);
}

@fragment
fn fs_main(input: VertexOutput, @builtin(front_facing) front_facing: bool) -> @location(0) vec4<f32> {
  if input.color.a < camera.tone.w && !front_facing {
    discard;
  }
  if dot(input.normal, input.normal) < 0.000001 { return input.color; }
  var normal = normalize(input.normal);
  if (!front_facing) {
    normal = -normal;
  }
  let view_direction = normalize(camera.camera_position.xyz - input.world_position);
  let half_direction = normalize(normalize(camera.key_direction.xyz) + view_direction);
  let specular = pow(max(dot(normal, half_direction), 0.0), camera.surface.w) * camera.surface.z;
  let rim = pow(1.0 - clamp(dot(normal, view_direction), 0.0, 1.0), camera.surface.y) * camera.surface.x;
  let light = matte_light(normal, view_direction);
  var shaded = input.color.rgb * light + vec3<f32>(specular);
  shaded *= 1.0 - rim;
  if input.curve > 0.5 {
    let tube_light = camera.curve_surface.x
      + camera.curve_surface.y * max(dot(normal, normalize(camera.key_direction.xyz)), 0.0)
      + camera.lighting.z * max(dot(normal, normalize(camera.fill_direction.xyz)), 0.0);
    let highlight = pow(max(dot(normal, half_direction), 0.0), camera.curve_surface.w) * camera.curve_surface.z;
    let edge = pow(1.0 - clamp(dot(normal, view_direction), 0.0, 1.0), camera.curve_edge.y);
    shaded = (input.color.rgb * tube_light + vec3<f32>(highlight)) * (1.0 - camera.curve_edge.x * edge);
  }
  return vec4<f32>(shaded, input.color.a);
}

struct PointInput {
  @location(0) position: vec3<f32>,
};

struct PointOutput {
  @builtin(position) clip_position: vec4<f32>,
  @location(0) disk: vec2<f32>,
  @location(1) color: vec4<f32>,
  @location(2) view_direction: vec3<f32>,
  @location(3) basis_x: vec3<f32>,
  @location(4) basis_y: vec3<f32>,
};

@vertex
fn point_vs_main(input: PointInput, @builtin(vertex_index) vertex_index: u32) -> PointOutput {
  // TriangleStrip quad: corner walks (-1,-1), (1,-1), (-1,1), (1,1).
  let corner = vec2<f32>(
    f32(vertex_index & 1u) * 2.0 - 1.0,
    f32(vertex_index >> 1u) * 2.0 - 1.0,
  );
  // The sphere-normal basis is per instance, so build it here instead of once
  // per covered fragment.
  let view_direction = normalize(camera.camera_position.xyz - input.position);
  var basis_up = normalize(camera.camera_up.xyz);
  if abs(dot(view_direction, basis_up)) > 0.999 {
    basis_up = select(vec3<f32>(0.0, 1.0, 0.0), vec3<f32>(1.0, 0.0, 0.0), abs(view_direction.x) < 0.9);
  }
  let basis_x = normalize(cross(view_direction, basis_up));
  let basis_y = normalize(cross(basis_x, view_direction));
  var clip = camera.view_projection * vec4<f32>(input.position, 1.0);
  clip.x += corner.x * camera.point_scale.x * clip.w;
  clip.y += corner.y * camera.point_scale.y * clip.w;
  return PointOutput(
    clip,
    corner,
    camera.point_color,
    view_direction,
    basis_x,
    basis_y,
  );
}

@fragment
fn point_fs_main(input: PointOutput) -> @location(0) vec4<f32> {
  let radius_squared = dot(input.disk, input.disk);
  if radius_squared > 1.0 {
    discard;
  }
  let view_direction = normalize(input.view_direction);
  let sphere_z = sqrt(1.0 - radius_squared);
  let normal = normalize(
    input.basis_x * input.disk.x - input.basis_y * input.disk.y + view_direction * sphere_z
  );
  let light = matte_light(normal, view_direction);
  let edge = max(fwidth(radius_squared), 0.001);
  let coverage = 1.0 - smoothstep(1.0 - edge, 1.0, radius_squared);
  return vec4<f32>(input.color.rgb * light, input.color.a * coverage);
}
