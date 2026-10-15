//! DejaVu Sans (regular and bold) as paths: the tables gen_glyphs.py writes
//! (glyph outlines in font units, advances, kerning pairs), built into the
//! module.  Text is drawn by filling these outlines.  The bold table has
//! words' characters only: a symbol in bold text is the regular one.

use std::collections::HashMap;
use std::sync::OnceLock;
use tiny_skia::PathBuilder;

pub struct Face {
    pub units_per_em: f32,
    pub ascender: f32,
    pub descender: f32,
    glyphs: HashMap<u32, (u16, Vec<u8>)>,
    kern: HashMap<(u32, u32), i16>,
    fallback: Option<&'static Face>,
}

fn u16_at(b: &[u8], i: usize) -> u16 {
    u16::from_le_bytes([b[i], b[i + 1]])
}
fn i16_at(b: &[u8], i: usize) -> i16 {
    i16::from_le_bytes([b[i], b[i + 1]])
}
fn u32_at(b: &[u8], i: usize) -> u32 {
    u32::from_le_bytes([b[i], b[i + 1], b[i + 2], b[i + 3]])
}

impl Face {
    fn parse(b: &[u8], fallback: Option<&'static Face>) -> Face {
        assert_eq!(&b[0..4], b"SBGL");
        assert_eq!(u16_at(b, 4), 2, "glyph table version");
        let units_per_em = u16_at(b, 6) as f32;
        let ascender = i16_at(b, 8) as f32;
        let descender = i16_at(b, 10) as f32;
        let count = u32_at(b, 12) as usize;
        let mut i = 16;
        let mut glyphs = HashMap::with_capacity(count);
        for _ in 0..count {
            let c = u32_at(b, i);
            let adv = u16_at(b, i + 4);
            let len = u32_at(b, i + 6) as usize;
            glyphs.insert(c, (adv, b[i + 10..i + 10 + len].to_vec()));
            i += 10 + len;
        }
        let nk = u32_at(b, i) as usize;
        i += 4;
        let mut kern = HashMap::with_capacity(nk);
        for _ in 0..nk {
            kern.insert((u32_at(b, i), u32_at(b, i + 4)), i16_at(b, i + 8));
            i += 10;
        }
        Face { units_per_em, ascender, descender, glyphs, kern, fallback }
    }

    pub fn has(&self, c: char) -> bool {
        self.glyphs.contains_key(&(c as u32)) || self.fallback.is_some_and(|f| f.has(c))
    }

    /// c's advance and commands: this face's, the fallback's, else .notdef's
    fn glyph(&self, c: char) -> Option<&(u16, Vec<u8>)> {
        let own = self.glyphs.get(&(c as u32));
        own.or_else(|| self.fallback.and_then(|f| f.glyphs.get(&(c as u32)))).or_else(|| self.glyphs.get(&0))
    }

    /// The advance of c in font units (.notdef's if the font lacks it; a
    /// zero-width space has none).
    pub fn advance(&self, c: char) -> f32 {
        if c == '\u{200b}' {
            return 0.0;
        }
        self.glyph(c).map(|g| g.0 as f32).unwrap_or(0.0)
    }

    pub fn kerning(&self, a: char, b: char) -> f32 {
        *self.kern.get(&(a as u32, b as u32)).unwrap_or(&0) as f32
    }

    /// Adds c's outline to pb, at the pen position (x, y) (y down, the
    /// baseline), at `scale` pixels per font unit, slanted by `skew` (an
    /// oblique: x += skew * height).
    pub fn outline(&self, pb: &mut PathBuilder, c: char, x: f32, y: f32, scale: f32, skew: f32) {
        if c == '\u{200b}' {
            return;
        }
        let Some((_, cmds)) = self.glyph(c) else { return };
        // the points are varints of their differences (gen_glyphs.py)
        let mut i = 0;
        let (mut fx, mut fy) = (0i32, 0i32);
        let mut point = |i: &mut usize| {
            fx += varint(cmds, i);
            fy += varint(cmds, i);
            (x + (fx as f32 + skew * fy as f32) * scale, y - fy as f32 * scale)
        };
        let mut open = false;
        while i < cmds.len() {
            let k = cmds[i];
            i += 1;
            match k {
                b'M' => {
                    if open {
                        pb.close();
                    }
                    let (px, py) = point(&mut i);
                    pb.move_to(px, py);
                    open = true;
                }
                b'L' => {
                    let (px, py) = point(&mut i);
                    pb.line_to(px, py);
                }
                b'Q' => {
                    let (x1, y1) = point(&mut i);
                    let (x2, y2) = point(&mut i);
                    pb.quad_to(x1, y1, x2, y2);
                }
                _ => {
                    if open {
                        pb.close();
                        open = false;
                    }
                }
            }
        }
        if open {
            pb.close();
        }
    }
}

/// A zigzag varint at b[*i..] (7 bits a byte, low first), advancing i
fn varint(b: &[u8], i: &mut usize) -> i32 {
    let (mut v, mut shift) = (0u32, 0);
    loop {
        let byte = b[*i];
        *i += 1;
        v |= ((byte & 127) as u32) << shift;
        if byte < 128 {
            break;
        }
        shift += 7;
    }
    ((v >> 1) as i32) ^ -((v & 1) as i32)
}

static REGULAR: OnceLock<Face> = OnceLock::new();
static BOLD: OnceLock<Face> = OnceLock::new();

pub fn face(bold: bool) -> &'static Face {
    if bold {
        BOLD.get_or_init(|| Face::parse(include_bytes!("../glyphs-dejavu-sans-bold.bin"), Some(face(false))))
    } else {
        REGULAR.get_or_init(|| Face::parse(include_bytes!("../glyphs-dejavu-sans.bin"), None))
    }
}
