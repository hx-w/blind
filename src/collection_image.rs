//! A collection image keeps every scene visible, independent of the viewer viewport.
use std::io::Cursor;

use anyhow::{Result, ensure};
use image::{ImageFormat, Rgba, RgbaImage, imageops::FilterType};

const TILE_WIDTH: u32 = 960;
const TILE_HEIGHT: u32 = 720;
const HEADER_HEIGHT: u32 = 44;
const GAP: u32 = 8;
const MARGIN: u32 = 8;

pub(crate) fn compose(images: &[(String, String, Vec<u8>)], active_id: &str) -> Result<Vec<u8>> {
    ensure!(
        (2..=16).contains(&images.len()),
        "collection image requires 2 to 16 scenes"
    );
    let columns = (images.len() as f64).sqrt().ceil() as u32;
    let rows = (images.len() as u32).div_ceil(columns);
    let width = MARGIN * 2 + columns * TILE_WIDTH + (columns - 1) * GAP;
    let height = MARGIN * 2 + rows * (TILE_HEIGHT + HEADER_HEIGHT) + (rows - 1) * GAP;
    let mut output = RgbaImage::from_pixel(width, height, Rgba([27, 29, 32, 255]));

    for (index, (id, title, png)) in images.iter().enumerate() {
        let column = index as u32 % columns;
        let row = index as u32 / columns;
        let x = MARGIN + column * (TILE_WIDTH + GAP);
        let y = MARGIN + row * (TILE_HEIGHT + HEADER_HEIGHT + GAP);
        let active = id == active_id;
        fill_rect(
            &mut output,
            x,
            y,
            TILE_WIDTH,
            HEADER_HEIGHT,
            [32, 35, 39, 255],
        );
        fill_rect(
            &mut output,
            x,
            y + HEADER_HEIGHT,
            TILE_WIDTH,
            TILE_HEIGHT,
            [41, 44, 50, 255],
        );
        if active {
            fill_rect(&mut output, x, y, TILE_WIDTH, 3, [103, 167, 224, 255]);
        }
        crate::render_labels::draw_text_line(
            &mut output,
            &format!("{:02}  {title}", index + 1),
            x + 16,
            y + 12,
            TILE_WIDTH - 32,
            18.0,
            [227, 230, 234],
        );

        let source = image::load_from_memory(png)?.to_rgba8();
        ensure!(
            source.width() > 0 && source.height() > 0,
            "empty scene image"
        );
        let scale = (TILE_WIDTH as f64 / source.width() as f64)
            .min(TILE_HEIGHT as f64 / source.height() as f64);
        let scaled_width = (source.width() as f64 * scale)
            .round()
            .clamp(1.0, TILE_WIDTH as f64) as u32;
        let scaled_height = (source.height() as f64 * scale)
            .round()
            .clamp(1.0, TILE_HEIGHT as f64) as u32;
        let scaled =
            image::imageops::resize(&source, scaled_width, scaled_height, FilterType::Triangle);
        image::imageops::overlay(
            &mut output,
            &scaled,
            i64::from(x + (TILE_WIDTH - scaled_width) / 2),
            i64::from(y + HEADER_HEIGHT + (TILE_HEIGHT - scaled_height) / 2),
        );
    }
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
        let result = image::load_from_memory(&compose(&images, "second").unwrap())
            .unwrap()
            .to_rgba8();
        assert_eq!(result.dimensions(), (1944, 780));
        assert_eq!(result.get_pixel(488, 420).0, [255, 0, 0, 255]);
        assert_eq!(result.get_pixel(1456, 420).0, [0, 0, 255, 255]);
        assert_eq!(result.get_pixel(976, 8).0, [103, 167, 224, 255]);
    }
}
