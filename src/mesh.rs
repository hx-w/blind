use std::{
    fs,
    fs::File,
    io::{BufReader, Write},
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
const SPHERE_LONGITUDE_SEGMENTS: usize = 12;
const SPHERE_LATITUDE_SEGMENTS: usize = 8;

#[derive(Debug, Clone)]
pub struct Geometry {
    pub positions: Vec<[f32; 3]>,
    pub indices: Vec<u32>,
}

impl Geometry {
    pub fn load(path: &Path, format: MeshFormat) -> Result<Self> {
        let geometry = match format {
            MeshFormat::Obj => load_obj(path),
            MeshFormat::Stl => load_stl(path),
            MeshFormat::Ply => load_ply(path),
            MeshFormat::Pts => load_pts(path),
        }?;
        if geometry.positions.is_empty() || geometry.indices.len() < 3 {
            bail!("{} contains no triangles", path.display());
        }
        if geometry.indices.len() % 3 != 0 {
            bail!("{} contains an incomplete triangle", path.display());
        }
        if geometry
            .indices
            .iter()
            .any(|index| *index as usize >= geometry.positions.len())
        {
            bail!("{} contains an out-of-range vertex index", path.display());
        }
        Ok(geometry)
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

fn load_obj(path: &Path) -> Result<Geometry> {
    let options = tobj::LoadOptions {
        triangulate: true,
        single_index: true,
        ..Default::default()
    };
    let (models, _) = tobj::load_obj(path, &options)
        .with_context(|| format!("failed to parse OBJ {}", path.display()))?;
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

fn load_stl(path: &Path) -> Result<Geometry> {
    let mut file = BufReader::new(File::open(path)?);
    let mesh = stl_io::read_stl(&mut file)
        .with_context(|| format!("failed to parse STL {}", path.display()))?;
    Ok(Geometry {
        positions: mesh.vertices.into_iter().map(|value| value.0).collect(),
        indices: mesh
            .faces
            .into_iter()
            .flat_map(|face| face.vertices.map(|value| value as u32))
            .collect(),
    })
}

fn load_ply(path: &Path) -> Result<Geometry> {
    let mut file = BufReader::new(File::open(path)?);
    let parser = Parser::<DefaultElement>::new();
    let ply = parser
        .read_ply(&mut file)
        .with_context(|| format!("failed to parse PLY {}", path.display()))?;
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
    let faces = ply.payload.get("face").context("PLY has no face element")?;
    let mut indices = Vec::new();
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
    Ok(Geometry { positions, indices })
}

fn load_pts(path: &Path) -> Result<Geometry> {
    let bytes = fs::read(path).with_context(|| format!("failed to read PTS {}", path.display()))?;
    pts_geometry(&bytes).with_context(|| format!("failed to parse PTS {}", path.display()))
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

    let (min, max) = bounds_of(points.iter().map(|point| point.to_array()));
    let diagonal = (Vec3::from_array(max) - Vec3::from_array(min))
        .length()
        .max(1e-6);
    let tube_radius = (diagonal * 0.006).clamp(0.04, 0.12);
    let point_radius = tube_radius * 1.75;
    let mut geometry = Geometry {
        positions: Vec::new(),
        indices: Vec::new(),
    };
    append_closed_tube(&mut geometry, &points, tube_radius)?;
    for point in points {
        append_sphere(&mut geometry, point, point_radius)?;
    }
    Ok(geometry)
}

fn append_closed_tube(geometry: &mut Geometry, points: &[Vec3], radius: f32) -> Result<()> {
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
        for side in 0..TUBE_RADIAL_SEGMENTS {
            let angle = std::f32::consts::TAU * side as f32 / TUBE_RADIAL_SEGMENTS as f32;
            let radial = normal * angle.cos() + binormal * angle.sin();
            geometry
                .positions
                .push((points[index] + radial * radius).to_array());
        }
    }
    for index in 0..count {
        let next = (index + 1) % count;
        for side in 0..TUBE_RADIAL_SEGMENTS {
            let next_side = (side + 1) % TUBE_RADIAL_SEGMENTS;
            let a = base + (index * TUBE_RADIAL_SEGMENTS + side) as u32;
            let b = base + (next * TUBE_RADIAL_SEGMENTS + side) as u32;
            let c = base + (next * TUBE_RADIAL_SEGMENTS + next_side) as u32;
            let d = base + (index * TUBE_RADIAL_SEGMENTS + next_side) as u32;
            geometry.indices.extend_from_slice(&[a, d, c, a, c, b]);
        }
    }
    Ok(())
}

fn append_sphere(geometry: &mut Geometry, center: Vec3, radius: f32) -> Result<()> {
    let base = u32::try_from(geometry.positions.len()).context("PTS geometry is too large")?;
    geometry
        .positions
        .push((center + Vec3::Y * radius).to_array());
    for latitude in 1..SPHERE_LATITUDE_SEGMENTS {
        let phi = std::f32::consts::PI * latitude as f32 / SPHERE_LATITUDE_SEGMENTS as f32;
        for longitude in 0..SPHERE_LONGITUDE_SEGMENTS {
            let theta = std::f32::consts::TAU * longitude as f32 / SPHERE_LONGITUDE_SEGMENTS as f32;
            let normal = Vec3::new(phi.sin() * theta.cos(), phi.cos(), phi.sin() * theta.sin());
            geometry
                .positions
                .push((center + normal * radius).to_array());
        }
    }
    let bottom = u32::try_from(geometry.positions.len()).context("PTS geometry is too large")?;
    geometry
        .positions
        .push((center - Vec3::Y * radius).to_array());
    let ring = |latitude: usize, longitude: usize| {
        base + 1
            + ((latitude - 1) * SPHERE_LONGITUDE_SEGMENTS + longitude % SPHERE_LONGITUDE_SEGMENTS)
                as u32
    };
    for longitude in 0..SPHERE_LONGITUDE_SEGMENTS {
        let next = (longitude + 1) % SPHERE_LONGITUDE_SEGMENTS;
        geometry
            .indices
            .extend_from_slice(&[base, ring(1, next), ring(1, longitude)]);
    }
    for latitude in 1..SPHERE_LATITUDE_SEGMENTS - 1 {
        for longitude in 0..SPHERE_LONGITUDE_SEGMENTS {
            let next = (longitude + 1) % SPHERE_LONGITUDE_SEGMENTS;
            let a = ring(latitude, longitude);
            let b = ring(latitude + 1, longitude);
            let c = ring(latitude + 1, next);
            let d = ring(latitude, next);
            geometry.indices.extend_from_slice(&[a, c, b, a, d, c]);
        }
    }
    let last_ring = SPHERE_LATITUDE_SEGMENTS - 1;
    for longitude in 0..SPHERE_LONGITUDE_SEGMENTS {
        let next = (longitude + 1) % SPHERE_LONGITUDE_SEGMENTS;
        geometry.indices.extend_from_slice(&[
            ring(last_ring, next),
            bottom,
            ring(last_ring, longitude),
        ]);
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
    fn denta_pts_becomes_closed_tube_and_sample_spheres() {
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
        let round_trip = load_ply(&path).unwrap();
        assert_eq!(round_trip.positions.len(), geometry.positions.len());
        assert_eq!(round_trip.indices.len(), geometry.indices.len());
    }

    #[test]
    fn pts_rejects_too_few_ordered_points() {
        let error = pts_geometry(b"BEGIN\n0 0 0\n1 0 0\nEND\n").unwrap_err();
        assert!(error.to_string().contains("at least three"));
    }

    #[test]
    fn generated_tube_and_sphere_faces_point_outward() {
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
        append_closed_tube(&mut tube, &points, 0.2).unwrap();
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

        let mut sphere = Geometry {
            positions: Vec::new(),
            indices: Vec::new(),
        };
        append_sphere(&mut sphere, Vec3::ZERO, 1.0).unwrap();
        for triangle in sphere.indices.chunks_exact(3) {
            let vertices = [
                Vec3::from_array(sphere.positions[triangle[0] as usize]),
                Vec3::from_array(sphere.positions[triangle[1] as usize]),
                Vec3::from_array(sphere.positions[triangle[2] as usize]),
            ];
            let centroid = (vertices[0] + vertices[1] + vertices[2]) / 3.0;
            let face = (vertices[1] - vertices[0]).cross(vertices[2] - vertices[0]);
            assert!(face.dot(centroid) > 0.0);
        }
    }
}
