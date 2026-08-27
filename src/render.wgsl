struct Camera {
  view_projection: mat4x4<f32>,
  light_direction: vec4<f32>,
};

@group(0) @binding(0) var<uniform> camera: Camera;

struct VertexInput {
  @location(0) position: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) color: vec4<f32>,
};

struct VertexOutput {
  @builtin(position) clip_position: vec4<f32>,
  @location(0) normal: vec3<f32>,
  @location(1) color: vec4<f32>,
};

@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;
  output.clip_position = camera.view_projection * vec4<f32>(input.position, 1.0);
  output.normal = input.normal;
  output.color = input.color;
  return output;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  let normal = normalize(input.normal);
  let key = max(dot(normal, normalize(-camera.light_direction.xyz)), 0.0);
  let fill = max(dot(normal, normalize(vec3<f32>(-0.4, -0.2, 0.7))), 0.0);
  let light = 0.42 + key * 0.46 + fill * 0.12;
  return vec4<f32>(input.color.rgb * light, input.color.a);
}
