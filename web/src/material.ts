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
  uniform vec4 tone;
  uniform vec4 surface;
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
    vec3 halfDirection = normalize(normalize(keyDirection) + viewDirection);
    float specular = pow(max(dot(normal, halfDirection), 0.0), surface.w) * surface.z;
    float rim = pow(1.0 - clamp(dot(normal, viewDirection), 0.0, 1.0), surface.y) * surface.x;
    float light = lighting.x + key * lighting.y + fill * lighting.z
      + hemisphere * lighting.w + facing * finish.x;
    light = clamp((light - tone.x) * finish.z + tone.x, tone.y, tone.z);
    vec3 shaded = baseColor * light + vec3(specular);
    shaded *= 1.0 - rim;
    gl_FragColor = vec4(shaded, opacity);
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
      tone: { value: new THREE.Vector4(shader.contrast_pivot, shader.light_min, shader.light_max, shader.translucent_threshold) },
      surface: { value: new THREE.Vector4(shader.rim, shader.rim_power, shader.specular, shader.shininess) },
      depthBias: { value: style.layer * shader.depth_bias_step },
    },
    side: isTranslucent(style.opacity) ? THREE.FrontSide : THREE.DoubleSide,
    transparent: isTranslucent(style.opacity),
    depthWrite: !isTranslucent(style.opacity),
    wireframe: style.wireframe,
  });
  material.forceSinglePass = true;
  return material;
}

function isTranslucent(opacity: number): boolean {
  return opacity < shader.translucent_threshold;
}

export function updateMatteMaterial(material: THREE.ShaderMaterial, style: MeshMaterialStyle): void {
  const translucent = isTranslucent(style.opacity);
  (material.uniforms.baseColor.value as THREE.Color).set(style.color);
  material.uniforms.opacity.value = style.opacity;
  material.uniforms.flatShading.value = style.flat;
  material.uniforms.depthBias.value = style.layer * shader.depth_bias_step;
  material.transparent = translucent;
  material.side = translucent ? THREE.FrontSide : THREE.DoubleSide;
  material.depthWrite = !translucent;
  material.wireframe = style.wireframe;
}
