struct Camera {
  view_projection: mat4x4<f32>,
  key_direction: vec4<f32>,
  fill_direction: vec4<f32>,
  lighting: vec4<f32>,
  camera_position: vec4<f32>,
  camera_up: vec4<f32>,
  finish: vec4<f32>,
};

@group(0) @binding(0) var<uniform> camera: Camera;

struct VertexInput {
  @location(0) position: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) color: vec4<f32>,
  @location(3) depth_bias: f32,
};

struct VertexOutput {
  @builtin(position) clip_position: vec4<f32>,
  @location(0) normal: vec3<f32>,
  @location(1) color: vec4<f32>,
  @location(2) world_position: vec3<f32>,
};

@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;
  output.clip_position = camera.view_projection * vec4<f32>(input.position, 1.0);
  output.clip_position.z -= input.depth_bias * output.clip_position.w;
  output.normal = input.normal;
  output.color = input.color;
  output.world_position = input.position;
  return output;
}

@fragment
fn fs_main(input: VertexOutput, @builtin(front_facing) front_facing: bool) -> @location(0) vec4<f32> {
  if input.color.a < 0.999 && !front_facing {
    discard;
  }
  var normal = normalize(input.normal);
  if (!front_facing) {
    normal = -normal;
  }
  let key = clamp((dot(normal, normalize(camera.key_direction.xyz)) + camera.finish.y) / (1.0 + camera.finish.y), 0.0, 1.0);
  let fill = clamp((dot(normal, normalize(camera.fill_direction.xyz)) + camera.finish.y) / (1.0 + camera.finish.y), 0.0, 1.0);
  let hemisphere = dot(normal, normalize(camera.camera_up.xyz)) * 0.5 + 0.5;
  let view_direction = normalize(camera.camera_position.xyz - input.world_position);
  let facing = clamp((dot(normal, view_direction) + camera.finish.y) / (1.0 + camera.finish.y), 0.0, 1.0);
  var light = camera.lighting.x + key * camera.lighting.y + fill * camera.lighting.z
    + hemisphere * camera.lighting.w + facing * camera.finish.x;
  light = clamp((light - 0.72) * camera.finish.z + 0.72, 0.42, 1.04);
  return vec4<f32>(input.color.rgb * light, input.color.a);
}
