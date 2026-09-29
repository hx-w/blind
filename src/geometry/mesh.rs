use std::{
    fs,
    io::{BufReader, Cursor, Write},
    path::Path,
};

use anyhow::{Context, Result, bail};
use glam::{Quat, Vec3};
use ply_rs::{
    parser::Parser,
    ply::{DefaultElement, Property},
};

use crate::scene::MeshFormat;

const MAX_PTS_POINTS: usize = 4_096;
const TUBE_RADIAL_SEGMENTS: usize = 16;

#[derive(Debug, Clone)]
pub struct Geometry {
    pub positions: Vec<[f32; 3]>,
    pub indices: Vec<u32>,
}

impl Geometry {
    pub fn load(path: &Path, format: MeshFormat) -> Result<Self> {
        Self::from_bytes(&fs::read(path)?, format)
    }

    pub fn from_bytes(bytes: &[u8], format: MeshFormat) -> Result<Self> {
        let geometry = match format {
            MeshFormat::Obj => load_obj(bytes),
            MeshFormat::Stl => load_stl(bytes),
            MeshFormat::Ply => load_ply(bytes),
            MeshFormat::Pts => load_pts(bytes),
        }?;
        if geometry.positions.is_empty() {
            bail!("{} contains no vertices", "source");
        }
        if geometry
            .positions
            .iter()
            .flatten()
            .any(|value| !value.is_finite())
        {
            bail!("{} contains non-finite vertex coordinates", "source");
        }
        if geometry.indices.len() < 3 {
            if geometry.indices.is_empty() && format == MeshFormat::Ply {
                return Ok(geometry);
            }
            bail!("{} contains no triangles", "source");
        }
        if geometry.indices.len() % 3 != 0 {
            bail!("{} contains an incomplete triangle", "source");
        }
        if geometry
            .indices
            .iter()
            .any(|index| *index as usize >= geometry.positions.len())
        {
            bail!("{} contains an out-of-range vertex index", "source");
        }
        Ok(geometry)
    }

    pub fn is_point_cloud(&self) -> bool {
        self.indices.is_empty()
    }

    /// Reviewable primitives: points for clouds, triangles otherwise.
    pub fn primitive_count(&self) -> usize {
        if self.is_point_cloud() {
            self.positions.len()
        } else {
            self.indices.len() / 3
        }
    }

    pub fn bounds(&self) -> ([f32; 3], [f32; 3]) {
        bounds_of(self.positions.iter().copied())
    }

    pub fn smooth_normals(&self) -> Vec<[f32; 3]> {
        let mut normals = vec![[0.0_f32; 3]; self.positions.len()];
        for triangle in self.indices.chunks_exact(3) {
            let a = self.positions[triangle[0] as usize];
            let b = self.positions[triangle[1] as usize];
            let c = self.positions[triangle[2] as usize];
            let normal = cross(sub(b, a), sub(c, a));
            for index in triangle {
                let target = &mut normals[*index as usize];
                target[0] += normal[0];
                target[1] += normal[1];
                target[2] += normal[2];
            }
        }
        normals.into_iter().map(normalize).collect()
    }

    pub fn to_binary_ply(&self) -> Result<Vec<u8>> {
        let vertex_count =
            u32::try_from(self.positions.len()).context("render geometry has too many vertices")?;
        let face_count = self.indices.len() / 3;
        let mut bytes = Vec::with_capacity(
            256 + self.positions.len() * 12 + face_count * (1 + 3 * size_of::<u32>()),
        );
        write!(
            bytes,
            "ply\nformat binary_little_endian 1.0\nelement vertex {vertex_count}\nproperty float x\nproperty float y\nproperty float z\nelement face {face_count}\nproperty list uchar uint vertex_indices\nend_header\n"
        )?;
        for position in &self.positions {
            for value in position {
                bytes.extend_from_slice(&value.to_le_bytes());
            }
        }
        for triangle in self.indices.chunks_exact(3) {
            bytes.push(3);
            for index in triangle {
                bytes.extend_from_slice(&index.to_le_bytes());
            }
        }
        Ok(bytes)
    }
}

fn load_obj(bytes: &[u8]) -> Result<Geometry> {
    let options = tobj::LoadOptions {
        triangulate: true,
        single_index: true,
        ..Default::default()
    };
    let (models, _) = tobj::load_obj_buf(&mut BufReader::new(Cursor::new(bytes)), &options, |_| {
        Ok((Vec::new(), Default::default()))
    })
    .with_context(|| format!("failed to parse OBJ {}", "source"))?;
    let mut positions = Vec::new();
    let mut indices = Vec::new();
    for model in models {
        let base = positions.len() as u32;
        positions.extend(
            model
                .mesh
                .positions
                .chunks_exact(3)
                .map(|value| [value[0], value[1], value[2]]),
        );
        indices.extend(model.mesh.indices.into_iter().map(|index| base + index));
    }
    Ok(Geometry { positions, indices })
}

fn load_stl(bytes: &[u8]) -> Result<Geometry> {
    let mut file = BufReader::new(Cursor::new(bytes));
    let mesh =
        stl_io::read_stl(&mut file).with_context(|| format!("failed to parse STL {}", "source"))?;
    Ok(Geometry {
        positions: mesh.vertices.into_iter().map(|value| value.0).collect(),
        indices: mesh
            .faces
            .into_iter()
            .flat_map(|face| face.vertices.map(|value| value as u32))
            .collect(),
    })
}

fn load_ply(bytes: &[u8]) -> Result<Geometry> {
    let mut file = BufReader::new(Cursor::new(bytes));
    let parser = Parser::<DefaultElement>::new();
    let ply = parser
        .read_ply(&mut file)
        .with_context(|| format!("failed to parse PLY {}", "source"))?;
    let vertices = ply
        .payload
        .get("vertex")
        .context("PLY has no vertex element")?;
    let positions = vertices
        .iter()
        .map(|vertex| {
            Ok([
                property_f32(vertex, "x")?,
                property_f32(vertex, "y")?,
                property_f32(vertex, "z")?,
            ])
        })
        .collect::<Result<Vec<_>>>()?;
    let mut indices = Vec::new();
    if let Some(faces) = ply.payload.get("face") {
        for face in faces {
            let values = list_u32(
                face.get("vertex_indices")
                    .or_else(|| face.get("vertex_index"))
                    .context("PLY face has no vertex_indices property")?,
            )?;
            if values.len() < 3 {
                continue;
            }
            for index in 1..values.len() - 1 {
                indices.extend_from_slice(&[values[0], values[index], values[index + 1]]);
            }
        }
        if !faces.is_empty() && indices.is_empty() {
            bail!("PLY face element contains no triangles");
        }
    }
    Ok(Geometry { positions, indices })
}

fn load_pts(bytes: &[u8]) -> Result<Geometry> {
    pts_geometry(bytes)
}

/// Bytes ready to serve over HTTP plus their content type: PTS rings ship as
/// generated binary PLY so every client receives triangle geometry.
pub fn serve_bytes(bytes: Vec<u8>, format: MeshFormat) -> Result<(Vec<u8>, &'static str)> {
    match format {
        MeshFormat::Pts => Ok((
            pts_geometry(&bytes)?.to_binary_ply()?,
            MeshFormat::Ply.mime(),
        )),
        _ => Ok((bytes, format.mime())),
    }
}

pub fn pts_geometry(bytes: &[u8]) -> Result<Geometry> {
    pts_geometry_from_points(&parse_pts_points(bytes)?, TUBE_RADIAL_SEGMENTS)
}

/// Raw payload size and LOD preview from a single PTS parse: the raw endpoint
/// ships PTS as generated binary PLY, so the raw size comes from the
/// full-detail build.
pub fn pts_raw_size_and_lod_geometry(
    bytes: &[u8],
    target_triangles: usize,
) -> Result<(usize, usize, Geometry)> {
    let points = parse_pts_points(bytes)?;
    let raw = pts_geometry_from_points(&points, TUBE_RADIAL_SEGMENTS)?;
    let source_triangles = raw.primitive_count();
    let raw_size = raw.to_binary_ply()?.len();
    Ok((
        raw_size,
        source_triangles,
        pts_lod_geometry_from_points(&points, target_triangles)?,
    ))
}

fn pts_lod_geometry_from_points(points: &[Vec3], target_triangles: usize) -> Result<Geometry> {
    // A closed tube needs at least three rings of three vertices (18 faces).
    // Reduce sampling before tessellation; mesh decimation damages thin tubes.
    let radial_segments = (target_triangles / 6).clamp(3, 10);
    let ring_budget = (target_triangles / (2 * radial_segments)).max(3);
    let radius = pts_tube_radius(points);
    let curve = smooth_closed_curve_budgeted(points, radius, ring_budget);
    let mut geometry = Geometry {
        positions: Vec::new(),
        indices: Vec::new(),
    };
    append_closed_tube(&mut geometry, &curve, radius, radial_segments)?;
    Ok(geometry)
}

fn parse_pts_points(bytes: &[u8]) -> Result<Vec<Vec3>> {
    let mut points = Vec::new();
    for line in String::from_utf8_lossy(bytes).lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with("SELECTION_SEED") {
            continue;
        }
        let mut values = line.split_whitespace().map(|value| value.parse::<f32>());
        let [Some(Ok(x)), Some(Ok(y)), Some(Ok(z))] = [values.next(), values.next(), values.next()]
        else {
            continue;
        };
        let point = Vec3::new(x, y, z);
        if !point.is_finite() {
            continue;
        }
        if points
            .last()
            .is_some_and(|previous: &Vec3| previous.distance_squared(point) <= 1e-12)
        {
            continue;
        }
        points.push(point);
        if points.len() > MAX_PTS_POINTS {
            bail!("PTS supports at most {MAX_PTS_POINTS} ordered points");
        }
    }
    if points.len() > 3
        && points
            .last()
            .is_some_and(|last| last.distance_squared(points[0]) <= 1e-12)
    {
        points.pop();
    }
    if points.len() < 3 {
        bail!("PTS must contain at least three finite ordered points");
    }
    Ok(points)
}

fn pts_tube_radius(points: &[Vec3]) -> f32 {
    let (min, max) = bounds_of(points.iter().map(|point| point.to_array()));
    let diagonal = (Vec3::from_array(max) - Vec3::from_array(min))
        .length()
        .max(1e-6);
    (diagonal * 0.006).clamp(0.04, 0.12)
}

fn pts_geometry_from_points(points: &[Vec3], tube_radial_segments: usize) -> Result<Geometry> {
    let tube_radius = pts_tube_radius(points);
    let mut geometry = Geometry {
        positions: Vec::new(),
        indices: Vec::new(),
    };
    let curve = smooth_closed_curve(points, tube_radius);
    append_closed_tube(&mut geometry, &curve, tube_radius, tube_radial_segments)?;
    Ok(geometry)
}

/// Centripetal Catmull–Rom interpolates the original ordered samples without
/// moving them. Its distance-based knots avoid overshoot on uneven sampling.
fn smooth_closed_curve(points: &[Vec3], radius: f32) -> Vec<Vec3> {
    smooth_closed_curve_budgeted(points, radius, usize::MAX)
}

/// Keep every original sample when the ring budget permits, reducing only the
/// interpolated subdivisions. For denser inputs, uniformly resample the smooth
/// centerline by arc length. Raw geometry always preserves the original samples.
fn smooth_closed_curve_budgeted(points: &[Vec3], radius: f32, ring_budget: usize) -> Vec<Vec3> {
    let n = points.len();
    let desired_steps: Vec<_> = (0..n)
        .map(|i| ((points[i].distance(points[(i + 1) % n]) / radius).ceil() as usize).clamp(2, 8))
        .collect();
    let desired_extra: usize = desired_steps.iter().map(|steps| steps - 1).sum();
    let extra_budget = if ring_budget >= n {
        ring_budget.saturating_sub(n).min(desired_extra)
    } else {
        desired_extra
    };
    let mut assigned_extra = 0;
    let mut curve = Vec::new();
    for i in 0..n {
        let [p0, p1, p2, p3] = [
            points[(i + n - 1) % n],
            points[i],
            points[(i + 1) % n],
            points[(i + 2) % n],
        ];
        let t0 = 0.0;
        let t1 = p0.distance(p1).sqrt().max(1e-6);
        let t2 = t1 + p1.distance(p2).sqrt().max(1e-6);
        let t3 = t2 + p2.distance(p3).sqrt().max(1e-6);
        let previous_extra = assigned_extra;
        assigned_extra += desired_steps[i] - 1;
        let steps = 1 + assigned_extra * extra_budget / desired_extra
            - previous_extra * extra_budget / desired_extra;
        let blend = |a: Vec3, b: Vec3, ta: f32, tb: f32, t: f32| {
            a * ((tb - t) / (tb - ta)) + b * ((t - ta) / (tb - ta))
        };
        for step in 0..steps {
            let t = t1 + (t2 - t1) * step as f32 / steps as f32;
            let a1 = blend(p0, p1, t0, t1, t);
            let a2 = blend(p1, p2, t1, t2, t);
            let a3 = blend(p2, p3, t2, t3, t);
            let b1 = blend(a1, a2, t0, t2, t);
            let b2 = blend(a2, a3, t1, t3, t);
            curve.push(blend(b1, b2, t1, t2, t));
        }
    }
    if ring_budget < n {
        resample_closed_curve(&curve, ring_budget.max(3))
    } else {
        curve
    }
}

fn resample_closed_curve(curve: &[Vec3], count: usize) -> Vec<Vec3> {
    let mut distances = Vec::with_capacity(curve.len() + 1);
    distances.push(0.0);
    for i in 0..curve.len() {
        distances.push(distances[i] + curve[i].distance(curve[(i + 1) % curve.len()]));
    }
    let length = distances[curve.len()];
    let mut segment = 0;
    (0..count)
        .map(|i| {
            let distance = length * (i as f32 / count as f32);
            while segment + 1 < curve.len() && distances[segment + 1] <= distance {
                segment += 1;
            }
            let span = distances[segment + 1] - distances[segment];
            let fraction = if span > 0.0 {
                (distance - distances[segment]) / span
            } else {
                0.0
            };
            curve[segment].lerp(curve[(segment + 1) % curve.len()], fraction)
        })
        .collect()
}

fn append_closed_tube(
    geometry: &mut Geometry,
    points: &[Vec3],
    radius: f32,
    radial_segments: usize,
) -> Result<()> {
    let count = points.len();
    let tangents: Vec<_> = (0..count)
        .map(|index| {
            let previous = points[(index + count - 1) % count];
            let current = points[index];
            let next = points[(index + 1) % count];
            (next - previous)
                .try_normalize()
                .or_else(|| (next - current).try_normalize())
                .or_else(|| (current - previous).try_normalize())
                .unwrap_or(Vec3::Z)
        })
        .collect();
    let mut normals = Vec::with_capacity(count);
    normals.push(perpendicular(tangents[0]));
    for index in 1..count {
        let tangent = tangents[index];
        let transported = normals[index - 1] - tangent * normals[index - 1].dot(tangent);
        normals.push(
            transported
                .try_normalize()
                .unwrap_or_else(|| perpendicular(tangent)),
        );
    }
    let transported_end = (normals[count - 1] - tangents[0] * normals[count - 1].dot(tangents[0]))
        .try_normalize()
        .unwrap_or(normals[0]);
    let closure_angle = tangents[0]
        .dot(transported_end.cross(normals[0]))
        .atan2(transported_end.dot(normals[0]));
    for (index, normal) in normals.iter_mut().enumerate() {
        let correction = closure_angle * index as f32 / count as f32;
        *normal = (Quat::from_axis_angle(tangents[index], correction) * *normal).normalize();
    }

    let base = u32::try_from(geometry.positions.len()).context("PTS geometry is too large")?;
    for index in 0..count {
        let normal = normals[index];
        let binormal = tangents[index].cross(normal).normalize_or_zero();
        for side in 0..radial_segments {
            let angle = std::f32::consts::TAU * side as f32 / radial_segments as f32;
            let radial = normal * angle.cos() + binormal * angle.sin();
            geometry
                .positions
                .push((points[index] + radial * radius).to_array());
        }
    }
    for index in 0..count {
        let next = (index + 1) % count;
        for side in 0..radial_segments {
            let next_side = (side + 1) % radial_segments;
            let a = base + (index * radial_segments + side) as u32;
            let b = base + (next * radial_segments + side) as u32;
            let c = base + (next * radial_segments + next_side) as u32;
            let d = base + (index * radial_segments + next_side) as u32;
            geometry.indices.extend_from_slice(&[a, d, c, a, c, b]);
        }
    }
    Ok(())
}

fn bounds_of<I: IntoIterator<Item = [f32; 3]>>(positions: I) -> ([f32; 3], [f32; 3]) {
    let mut min = [f32::INFINITY; 3];
    let mut max = [f32::NEG_INFINITY; 3];
    for position in positions {
        for axis in 0..3 {
            min[axis] = min[axis].min(position[axis]);
            max[axis] = max[axis].max(position[axis]);
        }
    }
    (min, max)
}

fn perpendicular(tangent: Vec3) -> Vec3 {
    let reference = if tangent.x.abs() < 0.8 {
        Vec3::X
    } else {
        Vec3::Y
    };
    tangent.cross(reference).normalize_or_zero()
}

fn property_f32(element: &DefaultElement, name: &str) -> Result<f32> {
    let value = element
        .get(name)
        .with_context(|| format!("PLY vertex has no {name} property"))?;
    let value = match value {
        Property::Char(v) => *v as f32,
        Property::UChar(v) => *v as f32,
        Property::Short(v) => *v as f32,
        Property::UShort(v) => *v as f32,
        Property::Int(v) => *v as f32,
        Property::UInt(v) => *v as f32,
        Property::Float(v) => *v,
        Property::Double(v) => *v as f32,
        _ => bail!("PLY property {name} is not numeric"),
    };
    Ok(value)
}

fn list_u32(value: &Property) -> Result<Vec<u32>> {
    let values = match value {
        Property::ListChar(v) => v.iter().map(|v| *v as u32).collect(),
        Property::ListUChar(v) => v.iter().map(|v| *v as u32).collect(),
        Property::ListShort(v) => v.iter().map(|v| *v as u32).collect(),
        Property::ListUShort(v) => v.iter().map(|v| *v as u32).collect(),
        Property::ListInt(v) => v.iter().map(|v| *v as u32).collect(),
        Property::ListUInt(v) => v.clone(),
        _ => bail!("PLY face indices are not an integer list"),
    };
    Ok(values)
}

fn sub(a: [f32; 3], b: [f32; 3]) -> [f32; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
fn cross(a: [f32; 3], b: [f32; 3]) -> [f32; 3] {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}
fn normalize(value: [f32; 3]) -> [f32; 3] {
    let length = (value[0] * value[0] + value[1] * value[1] + value[2] * value[2]).sqrt();
    if length <= f32::EPSILON {
        [0.0, 1.0, 0.0]
    } else {
        [value[0] / length, value[1] / length, value[2] / length]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn denta_pts_becomes_a_continuous_closed_curve() {
        let source = b"BEGIN_6\n0 0 0\n2 0 0\n2 2 0\n0 2 0\n0 0 0\nSELECTION_SEED 1 1 1\nEND_6\n";
        let geometry = pts_geometry(source).unwrap();
        assert!(geometry.positions.len() > 400);
        assert!(geometry.indices.len() > 2_000);
        assert_eq!(geometry.indices.len() % 3, 0);
        assert!(
            geometry
                .indices
                .iter()
                .all(|index| (*index as usize) < geometry.positions.len())
        );

        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("margin.ply");
        std::fs::write(&path, geometry.to_binary_ply().unwrap()).unwrap();
        let round_trip = load_ply(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(round_trip.positions.len(), geometry.positions.len());
        assert_eq!(round_trip.indices.len(), geometry.indices.len());
    }

    #[test]
    fn ply_without_faces_loads_as_point_cloud_and_round_trips() {
        let source = b"ply\nformat ascii 1.0\nelement vertex 4\nproperty float x\nproperty float y\nproperty float z\nend_header\n0 0 0\n1 0 0\n0 1 0\n0 0 1\n";
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("cloud.ply");
        std::fs::write(&path, source).unwrap();

        let geometry = Geometry::load(&path, MeshFormat::Ply).unwrap();
        assert!(geometry.is_point_cloud());
        assert_eq!(geometry.positions.len(), 4);

        let round_trip_path = directory.path().join("cloud-binary.ply");
        std::fs::write(&round_trip_path, geometry.to_binary_ply().unwrap()).unwrap();
        let round_trip = Geometry::load(&round_trip_path, MeshFormat::Ply).unwrap();
        assert!(round_trip.is_point_cloud());
        assert_eq!(round_trip.positions, geometry.positions);
    }

    #[test]
    fn ply_with_nonempty_invalid_faces_is_not_treated_as_a_point_cloud() {
        let source = b"ply\nformat ascii 1.0\nelement vertex 2\nproperty float x\nproperty float y\nproperty float z\nelement face 1\nproperty list uchar uint vertex_indices\nend_header\n0 0 0\n1 0 0\n2 0 1\n";
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("invalid-face.ply");
        std::fs::write(&path, source).unwrap();

        let error = Geometry::load(&path, MeshFormat::Ply).unwrap_err();
        assert!(error.to_string().contains("contains no triangles"));
    }

    #[test]
    fn pts_rejects_too_few_ordered_points() {
        let error = pts_geometry(b"BEGIN\n0 0 0\n1 0 0\nEND\n").unwrap_err();
        assert!(error.to_string().contains("at least three"));
    }

    #[test]
    fn generated_tube_faces_point_outward() {
        let mut tube = Geometry {
            positions: Vec::new(),
            indices: Vec::new(),
        };
        let points: Vec<_> = (0..32)
            .map(|index| {
                let angle = std::f32::consts::TAU * index as f32 / 32.0;
                Vec3::new(angle.cos() * 4.0, angle.sin() * 4.0, 0.0)
            })
            .collect();
        append_closed_tube(&mut tube, &points, 0.2, TUBE_RADIAL_SEGMENTS).unwrap();
        for triangle in tube.indices.chunks_exact(3) {
            let vertices = [
                Vec3::from_array(tube.positions[triangle[0] as usize]),
                Vec3::from_array(tube.positions[triangle[1] as usize]),
                Vec3::from_array(tube.positions[triangle[2] as usize]),
            ];
            let centroid = (vertices[0] + vertices[1] + vertices[2]) / 3.0;
            let centerline = centroid.truncate().normalize().extend(0.0) * 4.0;
            let outward = centroid - centerline;
            let face = (vertices[1] - vertices[0]).cross(vertices[2] - vertices[0]);
            assert!(face.dot(outward) > 0.0);
        }
    }

    #[test]
    fn curve_preserves_samples_and_has_no_point_bulges() {
        let points: Vec<_> = (0..32)
            .map(|i| {
                let t = std::f32::consts::TAU * i as f32 / 32.0;
                Vec3::new(4.0 * t.cos(), 4.0 * t.sin(), 0.0)
            })
            .collect();
        let curve = smooth_closed_curve(&points, 0.1);
        for p in &points {
            assert!(curve.iter().any(|q| q.distance(*p) < 1e-5));
        }
        let mut tube = Geometry {
            positions: vec![],
            indices: vec![],
        };
        append_closed_tube(&mut tube, &curve, 0.1, 16).unwrap();
        assert_eq!(tube.positions.len(), curve.len() * 16);
        for (ring, center) in tube.positions.chunks_exact(16).zip(&curve) {
            for p in ring {
                assert!((Vec3::from_array(*p).distance(*center) - 0.1).abs() < 1e-5);
            }
        }
        // Closed tube is manifold: no seam, open ends, or sample spheres.
        let mut edges = std::collections::HashMap::new();
        for tri in tube.indices.chunks_exact(3) {
            for (a, b) in [(tri[0], tri[1]), (tri[1], tri[2]), (tri[2], tri[0])] {
                *edges.entry((a.min(b), a.max(b))).or_insert(0) += 1;
            }
        }
        assert!(edges.values().all(|count| *count == 2));
    }

    #[test]
    fn budgeted_curve_preserves_samples_when_they_fit() {
        let points: Vec<_> = (0..32)
            .map(|i| {
                let angle = std::f32::consts::TAU * i as f32 / 32.0;
                Vec3::new(4.0 * angle.cos(), 4.0 * angle.sin(), 0.0)
            })
            .collect();
        for budget in [32, 39, 100, 256] {
            let curve = smooth_closed_curve_budgeted(&points, 0.1, budget);
            assert!(curve.len() <= budget);
            for point in &points {
                assert!(curve.iter().any(|sample| sample.distance(*point) < 1e-5));
            }
        }
    }

    #[test]
    fn dense_pts_lod_has_bounded_faces_and_a_closed_smooth_centerline() {
        let points: Vec<_> = (0..MAX_PTS_POINTS)
            .map(|i| {
                let angle = std::f32::consts::TAU * i as f32 / MAX_PTS_POINTS as f32;
                Vec3::new(4.0 * angle.cos(), 4.0 * angle.sin(), 0.0)
            })
            .collect();
        for budget in [1, 18, 59, 60, 1_000, 50_000] {
            let geometry = pts_lod_geometry_from_points(&points, budget).unwrap();
            assert!(geometry.primitive_count() <= budget.max(18));
            assert!(geometry.positions.iter().flatten().all(|x| x.is_finite()));
            let mut edges = std::collections::HashMap::new();
            for tri in geometry.indices.chunks_exact(3) {
                for (a, b) in [(tri[0], tri[1]), (tri[1], tri[2]), (tri[2], tri[0])] {
                    *edges.entry((a.min(b), a.max(b))).or_insert(0) += 1;
                }
            }
            assert!(edges.values().all(|count| *count == 2));
        }
        let curve = smooth_closed_curve_budgeted(&points, 0.1, 50);
        assert_eq!(curve.len(), 50);
        for (i, point) in curve.iter().enumerate() {
            assert!((point.length() - 4.0).abs() < 1e-4);
            let segment_length = point.distance(curve[(i + 1) % curve.len()]);
            assert!((segment_length - 8.0 * (std::f32::consts::PI / 50.0).sin()).abs() < 1e-4);
        }
    }
}
