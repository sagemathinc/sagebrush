//! PNG files: read with limits checked before anything the size of the image
//! is allocated, converted as matplotlib's imread converts them (Pillow's
//! modes, as matplotlib.image._pil_png_to_float_array maps them), and
//! written from a drawing.

use crate::{mem, Fail};
use png::{BitDepth, ColorType, Decoder, InterlaceInfo, Limits, Transformations};
use std::io::Cursor;
use tiny_skia::Pixmap;

/// A decoded PNG's samples, unpacked: one value per channel per pixel, at
/// the file's bit depth (0..2^depth - 1), in rows.
pub struct Image {
    pub width: u32,
    pub height: u32,
    pub color: ColorType,
    pub depth: u8,
    pub samples: Vec<u16>,
    pub palette: Vec<u8>,
    pub trns: Vec<u8>,
}

/// The rows of an Adam7-interlaced image's seven passes, in all.
fn adam7_rows(w: u32, h: u32) -> usize {
    const PASSES: [(u32, u32, u32, u32); 7] = [(0, 0, 8, 8), (4, 0, 8, 8), (0, 4, 4, 8), (2, 0, 4, 4), (0, 2, 2, 4), (1, 0, 2, 2), (0, 1, 1, 2)];
    PASSES
        .iter()
        .map(|&(x0, y0, _dx, dy)| if w > x0 && h > y0 { ((h - y0).div_ceil(dy)) as usize } else { 0 })
        .sum()
}

/// The chunks a PNG file of `len` bytes may have, for an image of `rows`
/// rows (Adam7's passes counted): any encoder's, which splits the image data
/// into chunks of 8 KB or more, or one a row, and adds a few others.  The
/// decoder's work for each chunk, also an empty one, is bounded by this,
/// where the 256 MB file limit alone would allow millions (the module cannot
/// be interrupted).
pub fn max_chunks(len: usize, rows: usize) -> usize {
    4096 + rows + len / 4096
}

/// One pass over the file's chunks, without allocating, before the decoder
/// sees them: the checksums of the chunks before the image data, which
/// Pillow checks (the png crate lets an ancillary chunk's pass; a wrong one
/// makes the file "broken"), and the number of chunks, at most max_chunks.
fn check_chunks(b: &[u8]) -> Result<(), String> {
    // (the rows, from the IHDR chunk, which comes first; a file without one
    // is the decoder's to report)
    let rows = if b.len() >= 8 + 8 + 13 && &b[12..16] == b"IHDR" {
        let w = u32::from_be_bytes([b[16], b[17], b[18], b[19]]);
        let h = u32::from_be_bytes([b[20], b[21], b[22], b[23]]);
        if b[28] == 1 { adam7_rows(w, h) } else { h as usize }
    } else {
        0
    };
    let limit = max_chunks(b.len(), rows.min(7 * 16384));
    let (mut i, mut count, mut data) = (8, 0usize, false);
    while i + 8 <= b.len() {
        let n = u32::from_be_bytes([b[i], b[i + 1], b[i + 2], b[i + 3]]) as usize;
        let kind = &b[i + 4..i + 8];
        count += 1;
        if count > limit {
            return Err(format!(
                "a PNG file of more than {} chunks, the most Sagebrush reads for an image of {} rows in {} bytes",
                limit, rows, b.len()
            ));
        }
        if n > b.len() - i - 8 || b.len() - i - 8 - n < 4 {
            return Ok(()); // (the decoder reports a short file)
        }
        data |= kind == b"IDAT";
        if !data {
            let want = u32::from_be_bytes([b[i + 8 + n], b[i + 9 + n], b[i + 10 + n], b[i + 11 + n]]);
            let mut h = crc32fast::Hasher::new();
            h.update(&b[i + 4..i + 8 + n]);
            if h.finalize() != want {
                return Err(format!("a broken PNG file (bad checksum in its {} chunk)", String::from_utf8_lossy(kind)));
            }
        }
        if kind == b"IEND" {
            return Ok(());
        }
        i += 12 + n;
    }
    Ok(())
}

fn channels(c: ColorType) -> usize {
    match c {
        ColorType::Grayscale | ColorType::Indexed => 1,
        ColorType::GrayscaleAlpha => 2,
        ColorType::Rgb => 3,
        ColorType::Rgba => 4,
    }
}

/// Decodes `bytes`, refusing an image wider or taller than `max_axis` or of
/// more than `max_pixels` pixels before its pixels are allocated.
pub fn decode(bytes: &[u8], max_axis: u32, max_pixels: u64) -> Result<Image, Fail> {
    if !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Err("not a PNG file".into());
    }
    check_chunks(bytes)?;
    // The decoder's own buffers (chunks it keeps, such as text) are bounded
    // too; the image itself is allocated below, once its size is checked.
    let mut dec = Decoder::new_with_limits(Cursor::new(bytes), Limits { bytes: 64 << 20 });
    dec.set_transformations(Transformations::IDENTITY);
    let mut reader = dec.read_info().map_err(|e| {
        let e = e.to_string();
        // (as Pillow: a file it cannot make sense of before the image data is
        // "broken", one without image data cannot be loaded)
        if e.contains("limits are exceeded") {
            "a PNG file whose chunks need more than the 64 MB Sagebrush gives them".to_string()
        } else if e.contains("IDAT or fdAT chunk is missing") {
            format!("a PNG file that cannot be read ({})", e)
        } else {
            format!("a broken PNG file ({})", e)
        }
    })?;
    let info = reader.info();
    let (width, height) = (info.width, info.height);
    if width == 0 || height == 0 || width > max_axis || height > max_axis || width as u64 * height as u64 > max_pixels {
        return Err(Fail::Input(format!(
            "a PNG image of {} x {} pixels: Sagebrush reads at most {} on a side and {} in all",
            width, height, max_axis, max_pixels
        )));
    }
    let color = info.color_type;
    let depth = info.bit_depth as u8;
    let palette = info.palette.as_ref().map(|p| p.to_vec()).unwrap_or_default();
    let trns = info.trns.as_ref().map(|p| p.to_vec()).unwrap_or_default();
    // The rows are read one by one, exactly as many as the image has, and no
    // more: past the last row the decoder would go on inflating whatever
    // image data follows (finish_decoding), which a crafted file can make
    // arbitrarily long.  So the work is bounded by the file and the image.
    let line = reader.output_line_size(width).ok_or("a PNG image too large to read")?;
    let rows_bytes = line.checked_mul(height as usize).ok_or(Fail::Memory { bytes: u64::MAX, what: "a PNG image's rows" })?;
    let mut buf = mem::zeroed(rows_bytes, "a PNG image's rows")?;
    let bpp = channels(color) as u8 * depth;
    let rows = if info.interlaced { adam7_rows(width, height) } else { height as usize };
    for i in 0..rows {
        let row = reader
            .next_interlaced_row()
            .map_err(|e| format!("a PNG file that cannot be read ({})", e))?
            .ok_or("a PNG file that cannot be read (its image data ends early)")?;
        match row.interlace() {
            InterlaceInfo::Adam7(a) => png::expand_interlaced_row(&mut buf, line, row.data(), a, bpp),
            InterlaceInfo::Null(_) => buf[i * line..i * line + row.data().len()].copy_from_slice(row.data()),
        }
    }
    let ch = channels(color);
    let per_row = width as usize * ch;
    let mut samples = mem::vec_with_capacity(per_row.saturating_mul(height as usize), "a PNG image's samples")?;
    for y in 0..height as usize {
        let row = &buf[y * line..(y + 1) * line];
        match depth {
            16 => samples.extend((0..per_row).map(|i| u16::from_be_bytes([row[2 * i], row[2 * i + 1]]))),
            8 => samples.extend(row[..per_row].iter().map(|&b| b as u16)),
            d => {
                let d = d as usize;
                let mask = (1u16 << d) - 1;
                samples.extend((0..per_row).map(|i| {
                    let bit = i * d;
                    ((row[bit / 8] as u16) >> (8 - d - bit % 8)) & mask
                }));
            }
        }
    }
    Ok(Image { width, height, color, depth, samples, palette, trns })
}

/// The image as matplotlib's imread returns a PNG: float32 values in [0, 1],
/// shape (h, w) for grayscale, (h, w, 3) for RGB, (h, w, 4) for RGBA, and
/// RGBA for a palette or grayscale with alpha.  Returns (channels, values),
/// channels 1 meaning a 2-D array.
///
/// As in Pillow: 16-bit RGB, RGBA and gray+alpha keep their high byte, 16-bit
/// gray is divided by 65535, 1-bit gray is 0 or 1, 2- and 4-bit gray come
/// out as matplotlib has them (below), and a palette takes its tRNS alpha
/// (255 for entries it does not cover).  A tRNS chunk of a gray or RGB image is not applied.
pub fn to_float(img: &Image) -> Result<(usize, Vec<f32>), Fail> {
    let s = &img.samples;
    let hi = |v: u16| if img.depth == 16 { (v >> 8) as f32 / 255.0 } else { v as f32 / 255.0 };
    // (the values: as many as the samples, or 4 a pixel for RGBA made from
    // gray and alpha or a palette)
    let n = match img.color {
        ColorType::GrayscaleAlpha => s.len().saturating_mul(2),
        ColorType::Indexed => s.len().saturating_mul(4),
        _ => s.len(),
    };
    let mut out: Vec<f32> = mem::vec_with_capacity(n, "a PNG image's values")?;
    Ok(match img.color {
        ColorType::Grayscale => {
            // Pillow scales 2- and 4-bit gray to 8 bits (v * 85, v * 17) and
            // matplotlib then divides by 3 and 15, so their values reach 85
            // and 17: matplotlib's results, kept
            let (mul, div) = match img.depth {
                1 => (1.0, 1.0),
                2 => (85.0, 3.0),
                4 => (17.0, 15.0),
                8 => (1.0, 255.0),
                _ => (1.0, 65535.0),
            };
            out.extend(s.iter().map(|&v| (v as f32 * mul) / div));
            (1, out)
        }
        ColorType::Rgb => {
            out.extend(s.iter().map(|&v| hi(v)));
            (3, out)
        }
        ColorType::Rgba => {
            out.extend(s.iter().map(|&v| hi(v)));
            (4, out)
        }
        ColorType::GrayscaleAlpha => {
            for p in s.chunks_exact(2) {
                let (l, a) = (hi(p[0]), hi(p[1]));
                out.extend_from_slice(&[l, l, l, a]);
            }
            (4, out)
        }
        ColorType::Indexed => {
            for &i in s {
                let i = i as usize;
                let c = |k: usize| *img.palette.get(3 * i + k).unwrap_or(&0) as f32 / 255.0;
                let a = *img.trns.get(i).unwrap_or(&255) as f32 / 255.0;
                out.extend_from_slice(&[c(0), c(1), c(2), a]);
            }
            (4, out)
        }
    })
}

/// The image as a tiny-skia pixmap (premultiplied RGBA), for drawing it.
pub fn to_pixmap(img: &Image) -> Result<Pixmap, Fail> {
    let (ch, v) = to_float(img)?;
    let mut pix = mem::pixmap(img.width, img.height, "an embedded image")?;
    let data = pix.data_mut();
    let b = |x: f32| (x * 255.0).round().clamp(0.0, 255.0);
    for i in 0..(img.width as usize * img.height as usize) {
        let (r, g, bl, a) = match ch {
            1 => (v[i], v[i], v[i], 1.0),
            3 => (v[3 * i], v[3 * i + 1], v[3 * i + 2], 1.0),
            _ => (v[4 * i], v[4 * i + 1], v[4 * i + 2], v[4 * i + 3]),
        };
        let a8 = b(a);
        data[4 * i] = (b(r) * a8 / 255.0).round() as u8;
        data[4 * i + 1] = (b(g) * a8 / 255.0).round() as u8;
        data[4 * i + 2] = (b(bl) * a8 / 255.0).round() as u8;
        data[4 * i + 3] = a8 as u8;
    }
    Ok(pix)
}

/// The drawing as an 8-bit RGBA PNG (straight alpha), with its resolution
/// (pHYs, from dpi) and text chunks, as matplotlib's savefig writes one.
///
/// The drawing (premultiplied) goes over `background` here, in straight
/// alpha as Agg's buffer keeps colors: where nothing is drawn the pixel is
/// the background's exact color, also a partly transparent one, and with no
/// background it is (255, 255, 255, 0), Agg's clear color.
pub fn encode(pix: &Pixmap, background: Option<crate::svg::Rgba>, dpi: f32, text: &[(String, String)]) -> Result<Vec<u8>, Fail> {
    let byte = |v: f32| (v.clamp(0.0, 1.0) * 255.0 + 0.5).floor();
    let bg = background.map(|c| [byte(c.0), byte(c.1), byte(c.2), byte(c.3)]);
    let mut rgba = mem::vec_with_capacity(pix.data().len(), "the picture's RGBA copy")?;
    for p in pix.pixels() {
        let (pr, pg, pb, pa) = (p.red() as f32, p.green() as f32, p.blue() as f32, p.alpha() as f32);
        let px = match bg {
            _ if pa == 255.0 => [pr, pg, pb, 255.0],
            None if pa == 0.0 => [255.0, 255.0, 255.0, 0.0],
            None => [pr * 255.0 / pa, pg * 255.0 / pa, pb * 255.0 / pa, pa],
            Some([r, g, b, a]) => {
                let ca = pa / 255.0;
                let ba = a / 255.0 * (1.0 - ca);
                let oa = ca + ba;
                if oa == 0.0 {
                    [r, g, b, 0.0]
                } else {
                    [(pr + r * ba) / oa, (pg + g * ba) / oa, (pb + b * ba) / oa, oa * 255.0]
                }
            }
        };
        rgba.extend(px.iter().map(|v| (v + 0.5).floor().clamp(0.0, 255.0) as u8));
    }
    let mut out = mem::TryVec::new();
    let written = {
        let mut enc = png::Encoder::new(&mut out, pix.width(), pix.height());
        enc.set_color(ColorType::Rgba);
        enc.set_depth(BitDepth::Eight);
        if dpi > 0.0 && dpi.is_finite() {
            // dots per metre, as Pillow writes the dpi it is given
            let ppm = (dpi / 0.0254 + 0.5) as u32;
            enc.set_pixel_dims(Some(png::PixelDimensions { xppu: ppm, yppu: ppm, unit: png::Unit::Meter }));
        }
        // (as Pillow writes them: tEXt when Latin-1 holds the text, else iTXt;
        // the keyword must be Latin-1, 1 to 79 characters)
        for (k, v) in text {
            if k.is_empty() || k.chars().count() > 79 || k.chars().any(|c| c as u32 > 0xff) {
                return Err(Fail::Input(format!("the PNG text keyword {:?}: 1 to 79 Latin-1 characters", k)));
            }
            if v.chars().all(|c| c as u32 <= 0xff) {
                enc.add_text_chunk(k.clone(), v.clone()).map_err(|e| format!("the PNG text {:?} ({})", k, e))?;
            } else {
                enc.add_itxt_chunk(k.clone(), v.clone()).map_err(|e| format!("the PNG text {:?} ({})", k, e))?;
            }
        }
        enc.write_header().and_then(|mut w| w.write_image_data(&rgba).and_then(|_| w.finish()))
    };
    // (a refused growth of the output is the memory refusal, whatever the
    // encoder made of the error)
    if let Some(bytes) = out.refused {
        return Err(Fail::Memory { bytes, what: "the PNG output" });
    }
    written.map_err(|e| Fail::Backend(format!("the PNG encoder: {}", e)))?;
    Ok(out.buf)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn empty_idats(k: usize) -> Vec<u8> {
        let chunk = |kind: &[u8], data: &[u8]| {
            let mut c = (data.len() as u32).to_be_bytes().to_vec();
            c.extend_from_slice(kind);
            c.extend_from_slice(data);
            let mut h = crc32fast::Hasher::new();
            h.update(&c[4..]);
            c.extend_from_slice(&h.finalize().to_be_bytes());
            c
        };
        let mut f = b"\x89PNG\r\n\x1a\n".to_vec();
        f.extend(chunk(b"IHDR", &[0, 0, 0, 1, 0, 0, 0, 1, 8, 0, 0, 0, 0]));
        for _ in 0..k {
            f.extend(chunk(b"IDAT", &[]));
        }
        f.extend(chunk(b"IDAT", &[0x78, 0x9c, 0x63, 0x60, 0x00, 0x00, 0x00, 0x02, 0x00, 0x01]));
        f.extend(chunk(b"IEND", &[]));
        f
    }

    #[test]
    fn chunks_are_counted_through_the_image_data() {
        // (HARD-6BC-2) a 1 x 1 gray image after k empty IDAT chunks: k + 3
        // chunks in all, at most 4096 + 1 + len / 4096
        let fits = |k: usize| k + 3 <= max_chunks(empty_idats(k).len(), 1);
        let k = (4000..5000).take_while(|&k| fits(k)).last().unwrap();
        assert!(check_chunks(&empty_idats(k)).is_ok());
        assert!(decode(&empty_idats(k), 16, 256).is_ok());
        let e = check_chunks(&empty_idats(k + 1)).err().unwrap();
        assert!(e.starts_with("a PNG file of more than "), "{}", e);
        assert!(decode(&empty_idats(200_000), 16, 256).is_err());
    }

    #[test]
    fn adam7_rows_count_each_pass() {
        // a 1 x 1 image has one row (pass 1); 8 x 8 has 1+1+1+2+2+4+4
        assert_eq!(adam7_rows(1, 1), 1);
        assert_eq!(adam7_rows(8, 8), 15);
        // passes without columns have no rows: 1 pixel wide, 8 high
        assert_eq!(adam7_rows(1, 8), 1 + 1 + 2 + 4);
    }

    #[test]
    fn check_chunks_finds_a_bad_crc_before_the_image_data() {
        let mut png = b"\x89PNG\r\n\x1a\n".to_vec();
        let chunk = |kind: &[u8], data: &[u8]| {
            let mut c = (data.len() as u32).to_be_bytes().to_vec();
            c.extend_from_slice(kind);
            c.extend_from_slice(data);
            let mut h = crc32fast::Hasher::new();
            h.update(kind);
            h.update(data);
            c.extend_from_slice(&h.finalize().to_be_bytes());
            c
        };
        png.extend(chunk(b"IHDR", &[0, 0, 0, 1, 0, 0, 0, 1, 8, 0, 0, 0, 0]));
        png.extend(chunk(b"tEXt", b"a\0b"));
        assert!(check_chunks(&png).is_ok());
        let n = png.len();
        png[n - 1] ^= 1;
        assert_eq!(check_chunks(&png).unwrap_err(), "a broken PNG file (bad checksum in its tEXt chunk)");
        // a length past the end is the decoder's to report
        let mut cut = png[..8].to_vec();
        cut.extend_from_slice(&[0xff, 0xff, 0xff, 0xff]);
        cut.extend_from_slice(b"IHDR");
        assert!(check_chunks(&cut).is_ok());
    }

    #[test]
    fn decode_refuses_large_images_before_allocating() {
        // a header and image data: the size check comes first
        let mut png = b"\x89PNG\r\n\x1a\n".to_vec();
        let ihdr = [0, 0, 0x40, 0x01, 0, 0, 0, 1, 8, 2, 0, 0, 0];
        png.extend_from_slice(&13u32.to_be_bytes());
        png.extend_from_slice(b"IHDR");
        png.extend_from_slice(&ihdr);
        let mut h = crc32fast::Hasher::new();
        h.update(b"IHDR");
        h.update(&ihdr);
        png.extend_from_slice(&h.finalize().to_be_bytes());
        // (image data that is never read: the size is refused first)
        let idat = [0x78u8, 0x9c, 0x03, 0x00];
        png.extend_from_slice(&(idat.len() as u32).to_be_bytes());
        png.extend_from_slice(b"IDAT");
        png.extend_from_slice(&idat);
        let mut h = crc32fast::Hasher::new();
        h.update(b"IDAT");
        h.update(&idat);
        png.extend_from_slice(&h.finalize().to_be_bytes());
        let err = decode(&png, 16384, 1 << 24).err().unwrap().to_string();
        assert!(err.starts_with("a PNG image of 16385 x 1 pixels"), "{}", err);
        assert_eq!(decode(b"GIF89a", 16384, 1 << 24).err().unwrap(), Fail::Input("not a PNG file".into()));
    }
}
