import * as THREE from 'three';
import type { SurfaceAnnotation, Vec3 } from './api';
import shader from '../../shaders/matte.json';
import ink from '../../shaders/stroke.json';

/** Constant pixel width, laid onto each sample's tangent plane and depth tested.
 * Camera-facing ribbons intersect sloped meshes and lose half their visible width. */
export class SurfaceInk {
  readonly object = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({
    vertexColors: true, side: THREE.DoubleSide, depthWrite: false,
  }));
  constructor() { this.object.renderOrder = 10000; this.object.frustumCulled = false; }
  update(marks: SurfaceAnnotation[], camera: THREE.Camera, width: number, height: number,
    visible: (index: number) => boolean, anchorVisible: (point: Vec3, index: number) => boolean, selected?: string, preview?: Vec3): void {
    const positions: number[] = [], colors: number[] = [];
    let bias=0;
    const vertex = (p: THREE.Vector3, dx: number, dy: number, color: THREE.Color, normal?: THREE.Vector3) => {
      const q = p.clone(); q.x += dx * 2 / width; q.y += dy * 2 / height; q.unproject(camera);
      if(normal) {
        const ray=q.clone().project(camera);ray.z=-1;ray.unproject(camera);
        const direction=q.clone().sub(ray).normalize(), denominator=direction.dot(normal);
        if(Math.abs(denominator)>.08) {
          const anchor=p.clone().unproject(camera);
          q.addScaledVector(direction,anchor.sub(q).dot(normal)/denominator);
        }
      }
      q.project(camera);q.z-=bias;q.unproject(camera);
      positions.push(q.x, q.y, q.z); colors.push(color.r, color.g, color.b);
    };
    const disk = (p: THREE.Vector3, radius: number, color: THREE.Color, normal?: THREE.Vector3) => {
      for (let i = 0; i < 24; i++) {
        const a = i * Math.PI / 12, b = (i + 1) * Math.PI / 12;
        vertex(p, 0, 0, color,normal); vertex(p, Math.cos(a) * radius, Math.sin(a) * radius, color,normal);
        vertex(p, Math.cos(b) * radius, Math.sin(b) * radius, color,normal);
      }
    };
    for (const mark of marks) {
      if (!mark.visible || !visible(mark.mesh)) continue;
      bias=(mark.mesh+.75)*shader.depth_bias_step;
      const color = new THREE.Color(mark.color), highlight=new THREE.Color('#f4f2ea');
      const ps = mark.points.map(point => new THREE.Vector3(...point).project(camera));
      const normals=mark.normals.map(n=>new THREE.Vector3(...n));
      const isVisible = (p: THREE.Vector3) => p.z > -1 && p.z < 1;
      if (mark.kind === 'point') {
        if (isVisible(ps[0]) && anchorVisible(mark.points[0], mark.mesh)) {
          ps[0].z = -0.99;
          if(mark.id===selected) disk(ps[0],7,highlight);
          disk(ps[0],4.5,color);
        }
      } else {
        const stroke=(radius:number, tint:THREE.Color)=> {
          for (let i = 1; i < ps.length; i++) {
            const a = ps[i - 1], b = ps[i];
            if (!isVisible(a) || !isVisible(b)) continue;
            const dx = (b.x - a.x) * width, dy = (b.y - a.y) * height, length = Math.hypot(dx, dy);
            if (!length) continue;
            const x = -dy / length * radius, y = dx / length * radius;
            vertex(a,x,y,tint,normals[i-1]);vertex(a,-x,-y,tint,normals[i-1]);vertex(b,x,y,tint,normals[i]);
            vertex(b,x,y,tint,normals[i]);vertex(a,-x,-y,tint,normals[i-1]);vertex(b,-x,-y,tint,normals[i]);
            disk(a,radius,tint,normals[i-1]);disk(b,radius,tint,normals[i]);
          }
        };
        if(mark.id===selected) stroke(ink.ink_width/2+1.5,highlight);
        stroke(ink.ink_width/2,color);
        if (mark.id === selected) for (const i of mark.controls) {
          if (!isVisible(ps[i]) || !anchorVisible(mark.points[i], mark.mesh)) continue;
          const handle = ps[i].clone(); handle.z = -0.99;
          disk(handle,4.5,highlight);disk(handle,2.5,color);
        }
      }
    }
    if (preview) { const p = new THREE.Vector3(...preview).project(camera); p.z = -0.99; disk(p, 3, new THREE.Color('#f4f2ea')); }
    this.object.geometry.dispose();
    this.object.geometry = new THREE.BufferGeometry();
    this.object.geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    this.object.geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  }
}
