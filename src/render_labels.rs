//! Server-side label composition. Font bytes are bundled so CJK labels render
//! identically on headless Linux and macOS, without host font configuration.
use std::sync::LazyLock;

use anyhow::{Context, Result};
use fontdue::{Font, FontSettings};
use image::RgbaImage;
use tiny_skia::{FillRule, Paint, PathBuilder, PixmapMut, Stroke, Transform};

pub(crate) struct RenderLabel {
    pub flat: bool,
    /// Normalized output coordinates, with the origin at the top left.
    pub anchor: [f32; 2],
    pub text: String,
    pub color: [u8; 3],
}

static FONT: LazyLock<Font> = LazyLock::new(|| {
    let bytes =
        zstd::stream::decode_all(&include_bytes!("../assets/fonts/NotoSansSC-Regular.otf.zst")[..])
            .expect("bundled label font decompresses");
    Font::from_bytes(bytes, FontSettings::default()).expect("bundled label font parses")
});

#[derive(Clone, Copy, Debug)]
struct Rect {
    x: f32,
    y: f32,
    w: f32,
    h: f32,
}
impl Rect {
    fn overlap(self, other: Self) -> f32 {
        (self.x + self.w + 5.0 - other.x)
            .min(other.x + other.w + 5.0 - self.x)
            .max(0.0)
            * (self.y + self.h + 5.0 - other.y)
                .min(other.y + other.h + 5.0 - self.y)
                .max(0.0)
    }
}

fn text_lines(text: &str, size: f32, maximum: f32) -> Vec<String> {
    let mut lines = vec![String::new()];
    let mut width = 0.0;
    for c in text
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
    {
        let advance = FONT.metrics(c, size).advance_width;
        if width + advance > maximum && !lines.last().unwrap().is_empty() {
            lines.push(String::new());
            width = 0.0;
        }
        lines.last_mut().unwrap().push(c);
        width += advance;
    }
    lines
}
fn text_width(text: &str, size: f32) -> f32 {
    text.chars()
        .map(|c| FONT.metrics(c, size).advance_width)
        .sum()
}

pub(crate) fn draw_text_line(
    image: &mut RgbaImage,
    text: &str,
    x: u32,
    y: u32,
    max_width: u32,
    size: f32,
    color: [u8; 3],
) {
    let mut visible = String::new();
    let ellipsis_width = text_width("…", size);
    let mut used = 0.0;
    for c in text.chars() {
        let advance = FONT.metrics(c, size).advance_width;
        if used + advance > max_width as f32 {
            while used + ellipsis_width > max_width as f32 {
                let Some(last) = visible.pop() else { break };
                used -= FONT.metrics(last, size).advance_width;
            }
            visible.push('…');
            break;
        }
        visible.push(c);
        used += advance;
    }
    let ascent = FONT
        .horizontal_line_metrics(size)
        .map(|metrics| metrics.ascent)
        .unwrap_or(size);
    let baseline = y as f32 + ascent;
    let mut pen = x as f32;
    for c in visible.chars() {
        let (metrics, bitmap) = FONT.rasterize(c, size);
        let left = pen.floor() as i32 + metrics.xmin;
        let top = baseline.floor() as i32 - metrics.ymin - metrics.height as i32;
        for row in 0..metrics.height {
            for col in 0..metrics.width {
                let px = left + col as i32;
                let py = top + row as i32;
                if px < 0 || py < 0 || px >= image.width() as i32 || py >= image.height() as i32 {
                    continue;
                }
                let alpha = bitmap[row * metrics.width + col] as u32;
                let pixel = image.get_pixel_mut(px as u32, py as u32);
                for channel in 0..3 {
                    pixel[channel] = ((color[channel] as u32 * alpha
                        + pixel[channel] as u32 * (255 - alpha)
                        + 127)
                        / 255) as u8;
                }
            }
        }
        pen += metrics.advance_width;
    }
}

fn place(anchor: [f32; 2], size: [f32; 2], viewport: [f32; 2], occupied: &[Rect]) -> Rect {
    let [x, y] = anchor;
    let [w, h] = size;
    let [width, height] = viewport;
    let mut best = Rect {
        x: 0.0,
        y: 0.0,
        w,
        h,
    };
    let mut best_score = f32::INFINITY;
    for ring in 0..8 {
        let gap = 10.0 + ring as f32 * 18.0;
        for [px, py] in [
            [x + gap, y - h - gap],
            [x - w - gap, y - h - gap],
            [x + gap, y + gap],
            [x - w - gap, y + gap],
            [x - w / 2.0, y - h - gap],
            [x - w / 2.0, y + gap],
        ] {
            let rect = Rect {
                x: px.clamp(6.0, (width - w - 6.0).max(6.0)),
                y: py.clamp(6.0, (height - h - 6.0).max(6.0)),
                w,
                h,
            };
            let overlap: f32 = occupied.iter().map(|r| rect.overlap(*r)).sum();
            let score = overlap * 1000.0 + (rect.x + w / 2.0 - x).hypot(rect.y + h / 2.0 - y);
            if score < best_score {
                best = rect;
                best_score = score;
            }
            if overlap == 0.0 {
                return rect;
            }
        }
    }
    best
}

pub(crate) fn overlay_labels(
    image: &mut RgbaImage,
    labels: &[RenderLabel],
    light: bool,
) -> Result<()> {
    if labels.is_empty() {
        return Ok(());
    }
    let width = image.width();
    let height = image.height();
    let size = 12.0_f32;
    let line_height = 17.0_f32;
    let mut occupied = Vec::new();
    for label in labels {
        let lines = text_lines(&label.text, size, (width as f32 - 32.0).clamp(24.0, 220.0));
        let w = lines
            .iter()
            .map(|line| text_width(line, size))
            .fold(0.0_f32, f32::max)
            + 16.0;
        let h = lines.len() as f32 * line_height + 10.0;
        let anchor = [
            label.anchor[0] * width as f32,
            label.anchor[1] * height as f32,
        ];
        let rect = place(anchor, [w, h], [width as f32, height as f32], &occupied);
        occupied.push(rect);
        let mut pixmap =
            PixmapMut::from_bytes(image.as_mut(), width, height).context("invalid label target")?;
        let mut paint = Paint {
            anti_alias: true,
            ..Default::default()
        };
        paint.set_color_rgba8(label.color[0], label.color[1], label.color[2], 180);
        let mut leader = PathBuilder::new();
        leader.move_to(anchor[0], anchor[1]);
        leader.line_to(
            anchor[0].clamp(rect.x, rect.x + w),
            anchor[1].clamp(rect.y, rect.y + h),
        );
        if let Some(path) = leader.finish() {
            pixmap.stroke_path(
                &path,
                &paint,
                &Stroke {
                    width: 0.8,
                    ..Default::default()
                },
                Transform::identity(),
                None,
            );
        }
        let mut border = PathBuilder::new();
        let r = if label.flat { 2.0 } else { 5.0 };
        let Rect { x, y, .. } = rect;
        border.move_to(x + r, y);
        border.line_to(x + w - r, y);
        border.quad_to(x + w, y, x + w, y + r);
        border.line_to(x + w, y + h - r);
        border.quad_to(x + w, y + h, x + w - r, y + h);
        border.line_to(x + r, y + h);
        border.quad_to(x, y + h, x, y + h - r);
        border.line_to(x, y + r);
        border.quad_to(x, y, x + r, y);
        border.close();
        let path = border.finish().context("invalid label outline")?;
        let mut background = Paint {
            anti_alias: true,
            ..Default::default()
        };
        let base = if light {
            [245_u8, 246, 248]
        } else {
            [32_u8, 35, 39]
        };
        let fill = if label.flat {
            std::array::from_fn(|i| {
                (f32::from(base[i]) * 0.72 + f32::from(label.color[i]) * 0.28).round() as u8
            })
        } else {
            base
        };
        background.set_color_rgba8(fill[0], fill[1], fill[2], 255);
        pixmap.fill_path(
            &path,
            &background,
            FillRule::Winding,
            Transform::identity(),
            None,
        );
        if !label.flat {
            pixmap.stroke_path(
                &path,
                &paint,
                &Stroke {
                    width: 0.8,
                    ..Default::default()
                },
                Transform::identity(),
                None,
            );
        }
        let color = if light {
            [45_u8, 49, 55]
        } else {
            [227_u8, 230, 234]
        };
        let ascent = FONT
            .horizontal_line_metrics(size)
            .context("missing label font metrics")?
            .ascent;
        for (line_index, line) in lines.iter().enumerate() {
            let mut pen = rect.x + 8.0;
            let baseline = rect.y + 4.0 + ascent + line_index as f32 * line_height;
            for c in line.chars() {
                let (metrics, bitmap) = FONT.rasterize(c, size);
                let left = pen.floor() as i32 + metrics.xmin;
                let top = baseline.floor() as i32 - metrics.ymin - metrics.height as i32;
                for row in 0..metrics.height {
                    for col in 0..metrics.width {
                        let x = left + col as i32;
                        let y = top + row as i32;
                        if x < 0 || y < 0 || x >= width as i32 || y >= height as i32 {
                            continue;
                        }
                        let alpha = bitmap[row * metrics.width + col] as u32;
                        let pixel = image.get_pixel_mut(x as u32, y as u32);
                        for channel in 0..3 {
                            pixel[channel] = ((color[channel] as u32 * alpha
                                + pixel[channel] as u32 * (255 - alpha)
                                + 127)
                                / 255) as u8;
                        }
                    }
                }
                pen += metrics.advance_width;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bundled_font_draws_chinese_latin_and_punctuation() {
        for c in "位置路径检查AB12·".chars() {
            assert_ne!(FONT.lookup_glyph_index(c), 0, "missing {c}");
        }
        let mut image = RgbaImage::from_pixel(320, 240, image::Rgba([41, 44, 50, 255]));
        let original = image.clone();
        overlay_labels(
            &mut image,
            &[RenderLabel {
                flat: true,
                anchor: [0.5, 0.5],
                text: "1 · 检查位置 A".into(),
                color: [255, 107, 94],
            }],
            false,
        )
        .unwrap();
        assert_ne!(image, original);
        assert!(
            image
                .pixels()
                .filter(|p| p[0] > 200 && p[1] > 200 && p[2] > 200)
                .count()
                > 30,
            "text must be painted, not just a badge"
        );
    }
    #[test]
    fn dense_labels_wrap_and_stay_in_bounds_without_colliding() {
        assert!(text_lines(&"很长的标签".repeat(10), 12.0, 120.0).len() > 1);
        let mut occupied = Vec::new();
        for _ in 0..6 {
            let rect = place([160.0, 120.0], [90.0, 27.0], [320.0, 240.0], &occupied);
            assert!(
                rect.x >= 0.0
                    && rect.y >= 0.0
                    && rect.x + rect.w <= 320.0
                    && rect.y + rect.h <= 240.0
            );
            assert!(occupied.iter().all(|other| rect.overlap(*other) == 0.0));
            occupied.push(rect);
        }
    }
}
