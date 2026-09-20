//! Per-render triangle BVH for bounded annotation visibility queries.
use glam::Vec3;

pub(crate) struct Occluders {
    triangles: Vec<[Vec3; 3]>,
    nodes: Vec<Node>,
}
struct Node {
    min: Vec3,
    max: Vec3,
    start: usize,
    end: usize,
    children: Option<[usize; 2]>,
}
impl Occluders {
    pub fn new(triangles: Vec<[Vec3; 3]>) -> Self {
        let mut tree = Self {
            triangles,
            nodes: Vec::new(),
        };
        if !tree.triangles.is_empty() {
            tree.build(0, tree.triangles.len());
        }
        tree
    }
    fn build(&mut self, start: usize, end: usize) -> usize {
        let mut min = Vec3::splat(f32::INFINITY);
        let mut max = Vec3::splat(f32::NEG_INFINITY);
        for tri in &self.triangles[start..end] {
            for p in tri {
                min = min.min(*p);
                max = max.max(*p);
            }
        }
        let index = self.nodes.len();
        self.nodes.push(Node {
            min,
            max,
            start,
            end,
            children: None,
        });
        if end - start > 16 {
            let extent = max - min;
            let axis = if extent.x >= extent.y && extent.x >= extent.z {
                0
            } else if extent.y >= extent.z {
                1
            } else {
                2
            };
            let middle = (start + end) / 2;
            self.triangles[start..end].select_nth_unstable_by(middle - start, |a, b| {
                let center =
                    |tri: &[Vec3; 3]| tri[0][axis] / 3.0 + tri[1][axis] / 3.0 + tri[2][axis] / 3.0;
                center(a).total_cmp(&center(b))
            });
            let left = self.build(start, middle);
            let right = self.build(middle, end);
            self.nodes[index].children = Some([left, right]);
        }
        index
    }
    pub fn visible(&self, origin: Vec3, point: Vec3) -> bool {
        if self.nodes.is_empty() {
            return true;
        }
        let distance = origin.distance(point);
        let direction = (point - origin).normalize_or_zero();
        let maximum = distance - (distance * 0.00001).max(0.00001);
        let mut stack = vec![0];
        while let Some(index) = stack.pop() {
            let node = &self.nodes[index];
            if !intersects_box(origin, direction, maximum, node.min, node.max) {
                continue;
            }
            if let Some(children) = node.children {
                stack.extend(children);
                continue;
            }
            for &[a, b, c] in &self.triangles[node.start..node.end] {
                let e1 = b - a;
                let e2 = c - a;
                let h = direction.cross(e2);
                let det = e1.dot(h);
                if det.abs() < 1e-10 {
                    continue;
                }
                let inv = 1.0 / det;
                let s = origin - a;
                let u = inv * s.dot(h);
                if !(0.0..=1.0).contains(&u) {
                    continue;
                }
                let q = s.cross(e1);
                let v = inv * direction.dot(q);
                if v < 0.0 || u + v > 1.0 {
                    continue;
                }
                let t = inv * e2.dot(q);
                if t > 0.0 && t < maximum {
                    return false;
                }
            }
        }
        true
    }
}
fn intersects_box(origin: Vec3, direction: Vec3, maximum: f32, min: Vec3, max: Vec3) -> bool {
    let mut near = 0.0_f32;
    let mut far = maximum;
    for axis in 0..3 {
        if direction[axis].abs() < 1e-12 {
            if origin[axis] < min[axis] || origin[axis] > max[axis] {
                return false;
            }
            continue;
        }
        let a = (min[axis] - origin[axis]) / direction[axis];
        let b = (max[axis] - origin[axis]) / direction[axis];
        near = near.max(a.min(b));
        far = far.min(a.max(b));
        if far < near {
            return false;
        }
    }
    true
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn visibility_handles_surface_backface_and_parallel_rays() {
        let tri = [
            Vec3::new(-1.0, -1.0, 0.0),
            Vec3::new(1.0, -1.0, 0.0),
            Vec3::new(0.0, 1.0, 0.0),
        ];
        let bvh = Occluders::new(vec![tri; 64]);
        assert!(bvh.visible(Vec3::Z, Vec3::ZERO));
        assert!(!bvh.visible(Vec3::Z, Vec3::NEG_Z));
        assert!(bvh.visible(Vec3::new(3.0, 0.0, 1.0), Vec3::new(3.0, 0.0, -1.0)));
        assert!(bvh.visible(Vec3::X, Vec3::new(2.0, 0.0, 0.0)));
    }
}
