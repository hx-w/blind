import * as THREE from 'three';
import shader from '../../shaders/matte.json';

const vertexShader = `
  uniform float depthBias;
  varying vec3 viewNormal;
  varying vec3 viewPosition;

  void main() {
    vec4 view = modelViewMatrix * vec4(position, 1.0);
    viewPosition = view.xyz;
    viewNormal = normalize(normalMatrix * normal);
    gl_Position = projectionMatrix * view;
    gl_Position.z -= depthBias * gl_Position.w;
  }
`;

const fragmentShader = `
  uniform vec3 baseColor;
  uniform float opacity;
  uniform bool flatShading;
  uniform vec3 keyDirection;
  uniform vec3 fillDirection;
  uniform vec4 lighting;
  uniform vec3 finish;
  varying vec3 viewNormal;
  varying vec3 viewPosition;

  float wrappedDiffuse(float cosine, float wrap) {
    return clamp((cosine + wrap) / (1.0 + wrap), 0.0, 1.0);
  }

  void main() {
    vec3 normal = flatShading
      ? normalize(cross(dFdx(viewPosition), dFdy(viewPosition)))
      : normalize(viewNormal);
    if (!gl_FrontFacing) normal = -normal;
    float key = wrappedDiffuse(dot(normal, normalize(keyDirection)), finish.y);
    float fill = wrappedDiffuse(dot(normal, normalize(fillDirection)), finish.y);
    float hemisphere = normal.y * 0.5 + 0.5;
    vec3 viewDirection = normalize(-viewPosition);
    float facing = wrappedDiffuse(dot(normal, viewDirection), finish.y);
    float light = lighting.x + key * lighting.y + fill * lighting.z
      + hemisphere * lighting.w + facing * finish.x;
    light = clamp((light - 0.72) * finish.z + 0.72, 0.42, 1.04);
    gl_FragColor = vec4(baseColor * light, opacity);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

export interface MeshMaterialStyle {
  color: string;
  opacity: number;
  flat: boolean;
  wireframe: boolean;
  layer: number;
}

export function createMatteMaterial(style: MeshMaterialStyle): THREE.ShaderMaterial {
  const material = new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms: {
      baseColor: { value: new THREE.Color(style.color) },
      opacity: { value: style.opacity },
      flatShading: { value: style.flat },
      keyDirection: { value: new THREE.Vector3(...shader.key_direction) },
      fillDirection: { value: new THREE.Vector3(...shader.fill_direction) },
      lighting: { value: new THREE.Vector4(shader.ambient, shader.key, shader.fill, shader.hemisphere) },
      finish: { value: new THREE.Vector3(shader.view, shader.wrap, shader.contrast) },
      depthBias: { value: style.layer * shader.depth_bias_step },
    },
    side: style.opacity < 1 ? THREE.FrontSide : THREE.DoubleSide,
    transparent: style.opacity < 1,
    depthWrite: style.opacity >= 1,
    wireframe: style.wireframe,
  });
  material.forceSinglePass = true;
  return material;
}

export function updateMatteMaterial(material: THREE.ShaderMaterial, style: MeshMaterialStyle): void {
  (material.uniforms.baseColor.value as THREE.Color).set(style.color);
  material.uniforms.opacity.value = style.opacity;
  material.uniforms.flatShading.value = style.flat;
  material.uniforms.depthBias.value = style.layer * shader.depth_bias_step;
  material.transparent = style.opacity < 1;
  material.side = style.opacity < 1 ? THREE.FrontSide : THREE.DoubleSide;
  material.depthWrite = style.opacity >= 1;
  material.forceSinglePass = true;
  material.wireframe = style.wireframe;
  material.needsUpdate = true;
}
