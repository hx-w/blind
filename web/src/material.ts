import * as THREE from 'three';
import shader from '../../shaders/matte.json';

const vertexShader = `
  #include <clipping_planes_pars_vertex>
  varying vec3 viewNormal;
  varying vec3 viewPosition;

  void main() {
    vec4 view = modelViewMatrix * vec4(position, 1.0);
    viewPosition = view.xyz;
    viewNormal = normalize(normalMatrix * normal);
    gl_Position = projectionMatrix * view;
    vec4 mvPosition = view;
    #include <clipping_planes_vertex>
  }
`;

const pointVertexShader = `
  #include <clipping_planes_pars_vertex>
  uniform float pointSize;
  varying vec3 viewPosition;

  void main() {
    vec4 view = modelViewMatrix * vec4(position, 1.0);
    viewPosition = view.xyz;
    gl_Position = projectionMatrix * view;
    gl_PointSize = pointSize;
    vec4 mvPosition = view;
    #include <clipping_planes_vertex>
  }
`;

// Uniform declarations shared by both fragment shaders.
const sharedFragmentUniforms = `
  #include <clipping_planes_pars_fragment>
  uniform vec3 baseColor;
  uniform float opacity;
  uniform vec3 keyDirection;
  uniform vec3 fillDirection;
  uniform vec4 lighting;
  uniform vec3 finish;
  uniform vec4 tone;
  uniform int renderMode;
  uniform float lightIntensity;
`;

// Shared matte lighting (wrapped key/fill, hemisphere, view facing, tone
// clamp). This is the cross-renderer contract with src/render.wgsl; change
// both in lockstep.
const lightingChunk = `
  float wrappedDiffuse(float cosine, float wrap) {
    return clamp((cosine + wrap) / (1.0 + wrap), 0.0, 1.0);
  }

  vec3 shadedLight(vec3 normal, vec3 viewDirection) {
    float key = wrappedDiffuse(dot(normal, normalize(keyDirection)), finish.y);
    float fill = wrappedDiffuse(dot(normal, normalize(fillDirection)), finish.y);
    float hemisphere = normal.y * 0.5 + 0.5;
    float facing = wrappedDiffuse(dot(normal, viewDirection), finish.y);
    float light = lighting.x + key * lighting.y + fill * lighting.z
      + hemisphere * lighting.w + facing * finish.x;
    return vec3(clamp((light - tone.x) * finish.z + tone.x, tone.y, tone.z));
  }
`;

const fragmentShader = `
  uniform bool flatShading;
  uniform bool curve;
  uniform vec4 curveSurface;
  uniform vec2 curveEdge;
  uniform vec4 surface;
  varying vec3 viewNormal;
  varying vec3 viewPosition;
  ${sharedFragmentUniforms}
  ${lightingChunk}

  void main() {
    #include <clipping_planes_fragment>
    vec3 normal = flatShading
      ? normalize(cross(dFdx(viewPosition), dFdy(viewPosition)))
      : normalize(viewNormal);
    // Screen derivatives already face the camera on either side of a flat face.
    if (!flatShading && !gl_FrontFacing) normal = -normal;
    vec3 viewDirection = normalize(-viewPosition);
    vec3 halfDirection = normalize(normalize(keyDirection) + viewDirection);
    float specular = pow(max(dot(normal, halfDirection), 0.0), surface.w) * surface.z;
    float rim = pow(1.0 - clamp(dot(normal, viewDirection), 0.0, 1.0), surface.y) * surface.x;
    if (renderMode == 2) {
      gl_FragColor = vec4(normal * 0.5 + 0.5, opacity);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
      return;
    }
    if (renderMode == 1) {
      float grazing = max(dot(normal, normalize(keyDirection)), 0.0);
      gl_FragColor = vec4(baseColor * (0.10 + grazing * lightIntensity * 0.90), opacity);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
      return;
    }
    vec3 shaded = baseColor * shadedLight(normal, viewDirection) + vec3(specular);
    shaded *= 1.0 - rim;
    // A lit, polished tube: rounded diffuse falloff and a narrow white highlight.
    // Screen/surface annotations remain flat ink and never use this material.
    if (curve) {
      float tubeLight = curveSurface.x
        + curveSurface.y * max(dot(normal, normalize(keyDirection)), 0.0)
        + lighting.z * max(dot(normal, normalize(fillDirection)), 0.0);
      float highlight = pow(max(dot(normal, halfDirection), 0.0), curveSurface.w) * curveSurface.z;
      // Darken the actual tube silhouette so pale curves separate from lit scans.
      float edge = pow(1.0 - clamp(dot(normal, viewDirection), 0.0, 1.0), curveEdge.y);
      shaded = (baseColor * tubeLight + vec3(highlight)) * (1.0 - curveEdge.x * edge);
    }
    gl_FragColor = vec4(shaded, opacity);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

const pointFragmentShader = `
  varying vec3 viewPosition;
  ${sharedFragmentUniforms}
  ${lightingChunk}

  void main() {
    #include <clipping_planes_fragment>
    vec2 disk = gl_PointCoord * 2.0 - 1.0;
    float radiusSquared = dot(disk, disk);
    if (radiusSquared > 1.0) discard;
    vec3 normal = normalize(vec3(disk.x, -disk.y, sqrt(1.0 - radiusSquared)));
    vec3 shaded = renderMode == 2 ? normal * 0.5 + 0.5 :
      renderMode == 1 ? baseColor * (0.10 + max(dot(normal, normalize(keyDirection)), 0.0) * lightIntensity * 0.90) :
      baseColor * shadedLight(normal, normalize(-viewPosition));
    float edge = max(fwidth(radiusSquared), 0.001);
    float coverage = 1.0 - smoothstep(1.0 - edge, 1.0, radiusSquared);
    gl_FragColor = vec4(shaded, opacity * coverage);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

export interface MeshMaterialStyle {
  color: string;
  opacity: number;
  flat: boolean;
  wireframe: boolean;
  curve: boolean;
  renderMode: 'matte' | 'raking' | 'normals';
  light: {azimuth: number; elevation: number; intensity: number};
}

function lightDirection(light: MeshMaterialStyle['light']): THREE.Vector3 {
  const a = light.azimuth * Math.PI / 180, e = light.elevation * Math.PI / 180;
  // Elevation is measured from the screen plane, so every azimuth remains grazing.
  return new THREE.Vector3(Math.cos(a) * Math.cos(e), Math.sin(a) * Math.cos(e), Math.sin(e));
}

const renderModeId = {matte: 0, raking: 1, normals: 2} as const;

function isTranslucent(opacity: number): boolean {
  return opacity < shader.translucent_threshold;
}

function baseUniforms(style: MeshMaterialStyle) {
  return {
    baseColor: { value: new THREE.Color(style.color) },
    opacity: { value: style.opacity },
    keyDirection: { value: style.renderMode === 'matte' ? new THREE.Vector3(...shader.key_direction) : lightDirection(style.light) },
    fillDirection: { value: new THREE.Vector3(...shader.fill_direction) },
    lighting: { value: new THREE.Vector4(shader.ambient, shader.key, shader.fill, shader.hemisphere) },
    finish: { value: new THREE.Vector3(shader.view, shader.wrap, shader.contrast) },
    tone: { value: new THREE.Vector4(shader.contrast_pivot, shader.light_min, shader.light_max, shader.translucent_threshold) },
    renderMode: { value: renderModeId[style.renderMode] },
    lightIntensity: { value: style.light.intensity },
  };
}

// Single dispatch point for the Mesh/Points material families, so both load
// paths style geometry identically.
export function createObjectMaterial(
  child: THREE.Mesh | THREE.Points,
  style: MeshMaterialStyle,
  pixelRatio: number,
): THREE.ShaderMaterial {
  const material = child instanceof THREE.Points
    ? new THREE.ShaderMaterial({
      vertexShader: pointVertexShader,
      fragmentShader: pointFragmentShader,
      uniforms: {
        ...baseUniforms(style),
        pointSize: { value: shader.point_diameter_pixels * pixelRatio },
      },
      transparent: true,
      depthWrite: !isTranslucent(style.opacity),
    })
    : new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms: {
        ...baseUniforms(style),
        flatShading: { value: style.flat },
        curve: { value: style.curve },
        curveSurface: { value: new THREE.Vector4(...shader.curve_surface) },
        curveEdge: { value: new THREE.Vector2(...shader.curve_edge) },
        surface: { value: new THREE.Vector4(shader.rim, shader.rim_power, shader.specular, shader.shininess) },
      },
      side: isTranslucent(style.opacity) ? THREE.FrontSide : THREE.DoubleSide,
      transparent: isTranslucent(style.opacity),
      depthWrite: !isTranslucent(style.opacity),
      wireframe: style.wireframe,
    });
  material.forceSinglePass = true;
  material.clipping = true;
  return material;
}

export function updateObjectMaterial(child: THREE.Mesh | THREE.Points, style: MeshMaterialStyle): void {
  const material = child.material as THREE.ShaderMaterial;
  const translucent = isTranslucent(style.opacity);
  (material.uniforms.baseColor.value as THREE.Color).set(style.color);
  material.uniforms.opacity.value = style.opacity;
  material.uniforms.renderMode.value = renderModeId[style.renderMode];
  material.uniforms.lightIntensity.value = style.light.intensity;
  (material.uniforms.keyDirection.value as THREE.Vector3).copy(style.renderMode === 'matte' ? new THREE.Vector3(...shader.key_direction) : lightDirection(style.light));
  material.depthWrite = !translucent;
  if (child instanceof THREE.Points) return;
  material.uniforms.flatShading.value = style.flat;
  material.uniforms.curve.value = style.curve;
  material.transparent = translucent;
  material.side = translucent ? THREE.FrontSide : THREE.DoubleSide;
  material.wireframe = style.wireframe;
}
