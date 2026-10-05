//! A collection image uses the layout captured with the shared viewer state.
use std::io::Cursor;

use crate::scene::{CollectionLayout, ScreenStroke};
use anyhow::{Result, ensure};
use image::{ImageFormat, Rgba, RgbaImage, imageops::FilterType};

const TILE_WIDTH: u32 = 960;
const TILE_HEIGHT: u32 = 720;

#[derive(Clone, Copy)]
struct Grid {
    width: u32,
    height: u32,
    columns: u32,
    rows: u32,
}

impl Grid {
    fn new(count: usize, layout: Option<CollectionLayout>) -> Result<Self> {
        ensure!(
            (2..=16).contains(&count),
            "collection image requires 2 to 16 scenes"
        );
        let layout = layout.unwrap_or_else(|| {
            let columns = (count as f64).sqrt().ceil() as u32;
            let rows = (count as u32).div_ceil(columns);
            CollectionLayout {
                width: columns * TILE_WIDTH + columns - 1,
                height: rows * TILE_HEIGHT + rows - 1,
                columns,
            }
        });
        layout.validate(count)?;
        Ok(Self {
            width: layout.width,
            height: layout.height,
            columns: layout.columns,
            rows: (count as u32).div_ceil(layout.columns),
        })
    }
    fn cell(self, index: usize) -> (u32, u32, u32, u32) {
        let col = index as u32 % self.columns;
        let row = index as u32 / self.columns;
        let content_width = self.width - self.columns + 1;
        let content_height = self.height - self.rows + 1;
        let x = col + col * content_width / self.columns;
        let y = row + row * content_height / self.rows;
        let right = col + (col + 1) * content_width / self.columns;
        let bottom = row + (row + 1) * content_height / self.rows;
        (x, y, right - x, bottom - y)
    }
}

pub(crate) fn scene_viewport_size(
    count: usize,
    layout: Option<CollectionLayout>,
    index: usize,
) -> Result<(u32, u32)> {
    let grid = Grid::new(count, layout)?;
    let (_, _, width, height) = grid.cell(index);
    Ok((width, height))
}

pub(crate) fn compose(
    images: &[(String, String, Vec<u8>)],
    active_id: &str,
    layout: Option<CollectionLayout>,
    strokes: &[ScreenStroke],
) -> Result<Vec<u8>> {
    ensure!(
        (2..=16).contains(&images.len()),
        "collection image requires 2 to 16 scenes"
    );
    let grid = Grid::new(images.len(), layout)?;
    let mut output = RgbaImage::from_pixel(grid.width, grid.height, Rgba([27, 29, 32, 255]));

    for (index, (id, title, png)) in images.iter().enumerate() {
        let (x, y, tile_width, tile_height) = grid.cell(index);
        let active = id == active_id;

        let source = image::load_from_memory(png)?.to_rgba8();
        ensure!(
            source.width() > 0 && source.height() > 0,
            "empty scene image"
        );
        let scale = (tile_width as f64 / source.width() as f64)
            .min(tile_height as f64 / source.height() as f64);
        let scaled_width = (source.width() as f64 * scale)
            .round()
            .clamp(1.0, tile_width as f64) as u32;
        let scaled_height = (source.height() as f64 * scale)
            .round()
            .clamp(1.0, tile_height as f64) as u32;
        let scaled = if source.dimensions() == (scaled_width, scaled_height) {
            source
        } else {
            image::imageops::resize(&source, scaled_width, scaled_height, FilterType::Triangle)
        };
        image::imageops::overlay(
            &mut output,
            &scaled,
            i64::from(x + (tile_width - scaled_width) / 2),
            i64::from(y + (tile_height - scaled_height) / 2),
        );
        draw_overlay_label(&mut output, title, x, y, tile_width, active);
    }
    crate::render::overlay_collection_strokes(&mut output, strokes)?;
    let mut buffer = Cursor::new(Vec::new());
    output.write_to(&mut buffer, ImageFormat::Png)?;
    Ok(buffer.into_inner())
}

fn draw_overlay_label(
    image: &mut RgbaImage,
    title: &str,
    x: u32,
    y: u32,
    tile_width: u32,
    active: bool,
) {
    let width = 208.min(tile_width.saturating_sub(16));
    let background = if active {
        [42, 59, 74, 255]
    } else {
        [32, 35, 39, 255]
    };
    let dot = if active {
        [103, 167, 224, 255]
    } else {
        [128, 134, 144, 255]
    };
    fill_round_rect(image, x + 8, y + 8, width, 28, 6, background);
    fill_round_rect(image, x + 18, y + 19, 6, 6, 3, dot);
    super::labels::draw_text_line(
        image,
        title,
        x + 32,
        y + 14,
        width.saturating_sub(34),
        12.0,
        if active {
            [227, 230, 234]
        } else {
            [164, 171, 181]
        },
    );
}

fn fill_round_rect(
    image: &mut RgbaImage,
    x: u32,
    y: u32,
    width: u32,
    height: u32,
    radius: u32,
    color: [u8; 4],
) {
    for row in 0..height {
        for column in 0..width {
            let dx = if column < radius {
                radius - column
            } else {
                (column + radius + 1).saturating_sub(width)
            };
            let dy = if row < radius {
                radius - row
            } else {
                (row + radius + 1).saturating_sub(height)
            };
            if dx * dx + dy * dy <= radius * radius {
                image.put_pixel(x + column, y + row, Rgba(color));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn overlay_export_preserves_full_panes_and_cross_pane_ink() {
        let png = |color| {
            let mut bytes = Cursor::new(Vec::new());
            RgbaImage::from_pixel(400, 480, Rgba(color))
                .write_to(&mut bytes, ImageFormat::Png)
                .unwrap();
            bytes.into_inner()
        };
        let images = vec![
            ("left".into(), "Left".into(), png([120, 0, 0, 255])),
            ("right".into(), "Right".into(), png([0, 0, 120, 255])),
        ];
        let layout = CollectionLayout {
            width: 801,
            height: 480,
            columns: 2,
        };
        assert_eq!(scene_viewport_size(2, Some(layout), 0).unwrap(), (400, 480));
        let decode = |strokes: &[ScreenStroke]| {
            image::load_from_memory(&compose(&images, "left", Some(layout), strokes).unwrap())
                .unwrap()
                .to_rgba8()
        };
        let plain = decode(&[]);
        assert_eq!(plain.get_pixel(0, 0).0, [120, 0, 0, 255]);
        assert_eq!(plain.get_pixel(799, 479).0, [0, 0, 120, 255]);
        assert_eq!(plain.get_pixel(400, 240).0, [27, 29, 32, 255]);
        let marked = decode(&[ScreenStroke {
            label: None,
            color: "#ff6b5e".into(),
            aspect: 801. / 480.,
            points: vec![[0.25, 0.5], [0.75, 0.5]],
        }]);
        assert_eq!(marked.get_pixel(400, 240).0[..3], [255, 107, 94]);
    }
}
