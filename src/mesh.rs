use std::{fs::File, io::BufReader, path::Path};

use anyhow::{Context, Result, bail};
use ply_rs::{
    parser::Parser,
    ply::{DefaultElement, Property},
};

use crate::scene::MeshFormat;

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
        let mut min = [f32::INFINITY; 3];
        let mut max = [f32::NEG_INFINITY; 3];
        for position in &self.positions {
            for axis in 0..3 {
                min[axis] = min[axis].min(position[axis]);
                max[axis] = max[axis].max(position[axis]);
            }
        }
        (min, max)
    }

    pub fn smooth_normals(&self) -> Vec<[f32; 3]> {
        let mut normals = vec![[0.0_f32; 3]; self.positions.len()];
        for triangle in self.indices.chunks_exact(3) {
            let a = self.positions[triangle[0] as usize];
            let b = self.positions[triangle[1] as usize];
            let c = self.positions[triangle[2] as usize];
            let normal = normalize(cross(sub(b, a), sub(c, a)));
            for index in triangle {
                let target = &mut normals[*index as usize];
                target[0] += normal[0];
                target[1] += normal[1];
                target[2] += normal[2];
            }
        }
        normals.into_iter().map(normalize).collect()
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
