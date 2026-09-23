//! A collection image uses the layout captured with the shared viewer state.
use std::io::Cursor;

use crate::scene::{CollectionLayout, ScreenStroke};
use anyhow::{Result, ensure};
use image::{ImageFormat, Rgba, RgbaImage, imageops::FilterType};

const TILE_WIDTH: u32 = 960;
const TILE_HEIGHT: u32 = 720;
const HEADER_HEIGHT: u32 = 44;
const GAP: u32 = 8;
const MARGIN: u32 = 8;

#[derive(Clone, Copy)]
struct Grid {
    width: u32,
    height: u32,
    columns: u32,
    rows: u32,
    header: u32,
}

impl Grid {
    fn new(count: usize, layout: Option<CollectionLayout>) -> Result<Self> {
        ensure!(
            (2..=16).contains(&count),
            "collection image requires 2 to 16 scenes"
        );
        if let Some(layout) = layout {
            layout.validate(count)?;
            Ok(Self {
                width: layout.width,
                height: layout.height,
                columns: layout.columns,
                rows: (count as u32).div_ceil(layout.columns),
                header: 35,
            })
        } else {
            // Older ten-scene links have no layout field. Their review spread
            // used five columns; keep that arrangement when exporting them.
            let columns = if count == 10 {
                5
            } else {
                (count as f64).sqrt().ceil() as u32
            };
            let rows = (count as u32).div_ceil(columns);
            let (tile_width, tile_height, header) = if count == 10 {
                (400, 472, 35)
            } else {
                (TILE_WIDTH, TILE_HEIGHT, HEADER_HEIGHT)
            };
            Ok(Self {
                width: MARGIN * 2 + columns * tile_width + (columns - 1) * GAP,
                height: MARGIN * 2 + rows * (tile_height + header) + (rows - 1) * GAP,
                columns,
                rows,
                header,
            })
        }
    }
    fn cell(self, index: usize) -> (u32, u32, u32, u32) {
        let col = index as u32 % self.columns;
        let row = index as u32 / self.columns;
        let content_width = self.width - 2 * MARGIN - (self.columns - 1) * GAP;
        let content_height = self.height - 2 * MARGIN - (self.rows - 1) * GAP;
        let x = MARGIN + col * GAP + col * content_width / self.columns;
        let y = MARGIN + row * GAP + row * content_height / self.rows;
        let right = MARGIN + col * GAP + (col + 1) * content_width / self.columns;
        let bottom = MARGIN + row * GAP + (row + 1) * content_height / self.rows;
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
    ensure!(
        height > grid.header,
        "collection layout has no scene viewport"
    );
    Ok((width, height - grid.header))
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
        let (x, y, tile_width, cell_height) = grid.cell(index);
        let tile_height = cell_height - grid.header;
        let active = id == active_id;
        fill_rect(
            &mut output,
            x,
            y,
            tile_width,
            grid.header,
            [32, 35, 39, 255],
        );
        fill_rect(
            &mut output,
            x,
            y + grid.header,
            tile_width,
            tile_height,
            [41, 44, 50, 255],
        );
        crate::render_labels::draw_text_line(
            &mut output,
            title,
            x + 13,
            y + 10,
            tile_width.saturating_sub(26),
            12.0,
            [227, 230, 234],
        );

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
        let scaled =
            image::imageops::resize(&source, scaled_width, scaled_height, FilterType::Triangle);
        image::imageops::overlay(
            &mut output,
            &scaled,
            i64::from(x + (tile_width - scaled_width) / 2),
            i64::from(y + grid.header + (tile_height - scaled_height) / 2),
        );
        if active {
            let ink = [103, 167, 224, 255];
            fill_rect(&mut output, x, y, tile_width, 1, ink);
            fill_rect(&mut output, x, y + cell_height - 1, tile_width, 1, ink);
            fill_rect(&mut output, x, y, 1, cell_height, ink);
            fill_rect(&mut output, x + tile_width - 1, y, 1, cell_height, ink);
        }
    }
    crate::render::overlay_collection_strokes(&mut output, strokes)?;
    let mut buffer = Cursor::new(Vec::new());
    output.write_to(&mut buffer, ImageFormat::Png)?;
    Ok(buffer.into_inner())
}

fn fill_rect(image: &mut RgbaImage, x: u32, y: u32, width: u32, height: u32, color: [u8; 4]) {
    for row in y..y + height {
        for column in x..x + width {
            image.put_pixel(column, row, Rgba(color));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn image_contains_each_scene_in_its_own_tile() {
        let png = |color| {
            let mut bytes = Cursor::new(Vec::new());
            RgbaImage::from_pixel(20, 20, Rgba(color))
                .write_to(&mut bytes, ImageFormat::Png)
                .unwrap();
            bytes.into_inner()
        };
        let images = vec![
            ("first".into(), "设计".into(), png([255, 0, 0, 255])),
            ("second".into(), "扫描".into(), png([0, 0, 255, 255])),
        ];
        let result = image::load_from_memory(&compose(&images, "second", None, &[]).unwrap())
            .unwrap()
            .to_rgba8();
        assert_eq!(result.dimensions(), (1944, 780));
        assert_eq!(result.get_pixel(488, 420).0, [255, 0, 0, 255]);
        assert_eq!(result.get_pixel(1456, 420).0, [0, 0, 255, 255]);
        assert_eq!(result.get_pixel(976, 8).0, [103, 167, 224, 255]);
    }

    #[test]
    fn captured_layout_and_screen_stroke_cross_scene_boundary() {
        let png = || {
            let mut bytes = Cursor::new(Vec::new());
            RgbaImage::from_pixel(10, 10, Rgba([41, 44, 50, 255]))
                .write_to(&mut bytes, ImageFormat::Png)
                .unwrap();
            bytes.into_inner()
        };
        let images = (0..10)
            .map(|index| (format!("scene_{index}"), format!("Scene {index}"), png()))
            .collect::<Vec<_>>();
        let layout = CollectionLayout {
            width: 2000,
            height: 1000,
            columns: 5,
        };
        let strokes = vec![ScreenStroke {
            label: None,
            color: "#ff6b5e".into(),
            aspect: 2.0,
            points: vec![[0.15, 0.30], [0.25, 0.30], [0.35, 0.30]],
        }];
        let output =
            image::load_from_memory(&compose(&images, "scene_6", Some(layout), &strokes).unwrap())
                .unwrap()
                .to_rgba8();
        assert_eq!(output.dimensions(), (2000, 1000));
        assert_eq!(
            scene_viewport_size(10, Some(layout), 0).unwrap(),
            (390, 453)
        );
        assert_eq!(output.get_pixel(500, 300).0[..3], [255, 107, 94]);
    }
}
