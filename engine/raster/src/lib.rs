//! Sagebrush's PNG module, a wasm32 module of its own that the runtime loads
//! the first time a PNG is written or read (src/runtime/raster.ts): its
//! plots' SVG drawn with tiny-skia, and PNG files read with limits.
//!
//! ABI (single-threaded): rs_alloc(len) -> ptr for an input; rs_render and
//! rs_decode return their outcome (Fail's codes, PNG plan r8 §2.4) with its
//! reply in the reply buffer, which rs_reply_ptr()/rs_reply_len() locate:
//! - 0, the result (below);
//! - 1, the input refused (a malformed or unsupported drawing or file, or a
//!   limit), a UTF-8 message;
//! - 2, a memory refusal: u64 bytes asked for (little-endian), then what
//!   they were for, UTF-8;
//! - 3, the engine itself failed (a Sagebrush bug), a UTF-8 message.
//!
//! In WebAssembly the heap's pages are bounded (wasm.rs): rs_begin(pages)
//! sets how many pages it may grow by, rs_last_refusal() what a refused
//! growth asked for, rs_heap_base() where the heap starts.
//!
//! - rs_render(svg, svg_len, scale, width, height, background,
//!   background_len, dpi, text, text_len): an RGBA PNG of width x height
//!   pixels (0 x 0: the drawing's size), at scale pixels per SVG unit, on
//!   background (a CSS color; empty or "none": transparent).  text holds the
//!   PNG text chunks: key, value, key, value, ..., each UTF-8 after its byte
//!   length (u32, little-endian).  The reply is
//!   u32 png_len (little-endian), the PNG, then the characters the font
//!   lacked, UTF-8.
//! - rs_decode(png, len): u32 width, u32 height, u32 channels (1: a 2-D
//!   array), then width * height * channels float32s (little-endian), as
//!   matplotlib's imread returns them.

mod dash;
mod font;
mod mem;
mod pngio;
mod svg;
#[cfg(target_arch = "wasm32")]
mod wasm;

/// The largest picture made or read: on a side, and in all.
pub const MAX_AXIS: u32 = 16384;
pub const MAX_PIXELS: u64 = 1 << 24;

/// How a call failed: the outcomes the host tells apart (PNG plan r8 §2.4).
#[derive(Debug, Clone, PartialEq)]
pub enum Fail {
    /// The input refused: a malformed or unsupported drawing or PNG file, or
    /// a limit (the host's ValueError).
    Input(String),
    /// A fallible allocation of `bytes` refused: the memory the call was
    /// given can't hold `what`.
    Memory { bytes: u64, what: &'static str },
    /// The engine itself failed: a Sagebrush bug.
    Backend(String),
}

impl Fail {
    /// The outcome's code in the ABI (1, 2 or 3).
    pub fn code(&self) -> u32 {
        match self {
            Fail::Input(_) => 1,
            Fail::Memory { .. } => 2,
            Fail::Backend(_) => 3,
        }
    }
}

impl std::fmt::Display for Fail {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        match self {
            Fail::Input(s) | Fail::Backend(s) => f.write_str(s),
            Fail::Memory { bytes, what } => write!(f, "{} needs {} bytes, which the PNG engine could not allocate", what, bytes),
        }
    }
}

// (the errors written as strings throughout: the input's)
impl From<String> for Fail {
    fn from(s: String) -> Fail {
        Fail::Input(s)
    }
}

impl From<&str> for Fail {
    fn from(s: &str) -> Fail {
        Fail::Input(s.to_string())
    }
}

static mut REPLY: Vec<u8> = Vec::new();

#[no_mangle]
// SAFETY: an export of the raster module's wasm ABI (no_mangle; the rs_ prefix keeps
// the symbol unique); the block is leaked to the host, which returns it through rs_free
// with its length.
#[allow(unsafe_code)]
pub extern "C" fn rs_alloc(len: usize) -> *mut u8 {
    let mut v = Vec::<u8>::with_capacity(len);
    let p = v.as_mut_ptr();
    std::mem::forget(v);
    p
}

/// # Safety
/// ptr must come from rs_alloc(len).
#[no_mangle]
// SAFETY: an export of the raster module's wasm ABI (no_mangle; the rs_ prefix keeps
// the symbol unique); per `# Safety` the block came from rs_alloc(len), so rebuilding
// the Vec (length 0, capacity len) and dropping it frees exactly that allocation.
#[allow(unsafe_code)]
pub unsafe extern "C" fn rs_free(ptr: *mut u8, len: usize) {
    drop(Vec::from_raw_parts(ptr, 0, len));
}

#[no_mangle]
// SAFETY: an export of the raster module's wasm ABI (no_mangle; the rs_ prefix keeps
// the symbol unique); reading REPLY's address: REPLY is used on one thread with no
// other reference to it live (the module is single-threaded).
#[allow(unsafe_code)]
pub extern "C" fn rs_reply_ptr() -> *const u8 {
    unsafe { (*std::ptr::addr_of!(REPLY)).as_ptr() }
}

#[no_mangle]
// SAFETY: an export of the raster module's wasm ABI (no_mangle; the rs_ prefix keeps
// the symbol unique); reading REPLY's length: REPLY is used on one thread with no
// other reference to it live (the module is single-threaded).
#[allow(unsafe_code)]
pub extern "C" fn rs_reply_len() -> usize {
    unsafe { (*std::ptr::addr_of!(REPLY)).len() }
}

// SAFETY: REPLY is replaced on one thread with no other reference to it live (the
// module is single-threaded).
#[allow(unsafe_code)]
fn reply(r: Result<Vec<u8>, Fail>) -> u32 {
    let (code, bytes) = match r {
        Ok(b) => (0, b),
        Err(e) => {
            let code = e.code();
            (code, match e {
                Fail::Input(s) | Fail::Backend(s) => s.into_bytes(),
                Fail::Memory { bytes, what } => [&bytes.to_le_bytes()[..], what.as_bytes()].concat(),
            })
        }
    };
    unsafe {
        let rep = &mut *std::ptr::addr_of_mut!(REPLY);
        // let a large reply go rather than keep its memory
        *rep = bytes;
    }
    code
}

/// # Safety
/// The pointers and lengths must describe readable memory.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
// SAFETY: an export of the raster module's wasm ABI (no_mangle; the rs_ prefix keeps
// the symbol unique); the inputs are read per `# Safety` (each pointer and length
// describes bytes the host wrote into this instance).
#[allow(unsafe_code)]
pub unsafe extern "C" fn rs_render(svg: *const u8, svg_len: usize, scale: f32, width: u32, height: u32, background: *const u8, background_len: usize, dpi: f32, text: *const u8, text_len: usize) -> u32 {
    #[cfg(target_arch = "wasm32")]
    wasm::clear_refusal();
    let svg = std::slice::from_raw_parts(svg, svg_len);
    let text = std::slice::from_raw_parts(text, text_len);
    let background = std::slice::from_raw_parts(background, background_len);
    let size = if width == 0 && height == 0 { None } else { Some((width, height)) };
    reply(render(svg, scale, size, background, dpi, text))
}

fn render(svg: &[u8], scale: f32, size: Option<(u32, u32)>, background: &[u8], dpi: f32, text: &[u8]) -> Result<Vec<u8>, Fail> {
    let svg = std::str::from_utf8(svg).map_err(|_| "an SVG that is not UTF-8".to_string())?;
    let mut strings = vec![];
    let mut i = 0;
    while i < text.len() {
        let n = u32::from_le_bytes(text.get(i..i + 4).ok_or("PNG text cut short")?.try_into().unwrap()) as usize;
        let s = text.get(i + 4..i + 4 + n).ok_or("PNG text cut short")?;
        strings.push(String::from_utf8(s.to_vec()).map_err(|_| "PNG text that is not UTF-8".to_string())?);
        i += 4 + n;
    }
    if strings.len() % 2 != 0 {
        return Err("a PNG text key without its value".into());
    }
    let pairs: Vec<(String, String)> = strings.chunks(2).map(|kv| (kv[0].clone(), kv[1].clone())).collect();
    let background = std::str::from_utf8(background).map_err(|_| "a background color that is not UTF-8".to_string())?;
    let (png, missing) = render_png(svg, scale, size, background, dpi, &pairs)?;
    let mut r = mem::vec_with_capacity(png.len() + 4 + missing.len(), "the PNG output")?;
    r.extend_from_slice(&(png.len() as u32).to_le_bytes());
    r.extend_from_slice(&png);
    r.extend_from_slice(missing.as_bytes());
    Ok(r)
}

/// rs_render for Rust callers (the CPython extension, engine/py): the PNG
/// and the characters the font lacked.  size None: the drawing's own;
/// background a CSS color, "" or "none" for transparent.
pub fn render_png(svg: &str, scale: f32, size: Option<(u32, u32)>, background: &str, dpi: f32, text: &[(String, String)]) -> Result<(Vec<u8>, String), Fail> {
    let bg = if background.is_empty() { None } else { svg::color(background)? };
    // drawn on nothing, the background composited when written (pngio::encode)
    let (pix, out) = svg::render(svg, scale, size, None)?;
    let png = pngio::encode(&pix, bg, dpi, text)?;
    Ok((png, out.missing.iter().collect()))
}

/// rs_decode for Rust callers: width, height, channels and the float32
/// values, row by row.
pub fn decode_png(bytes: &[u8]) -> Result<(u32, u32, u32, Vec<f32>), Fail> {
    let img = pngio::decode(bytes, MAX_AXIS, MAX_PIXELS)?;
    let (ch, v) = pngio::to_float(&img)?;
    Ok((img.width, img.height, ch as u32, v))
}

/// # Safety
/// The pointer and length must describe readable memory.
#[no_mangle]
// SAFETY: an export of the raster module's wasm ABI (no_mangle; the rs_ prefix keeps
// the symbol unique); the input is read per `# Safety` (the host wrote `len` bytes
// at `png` into this instance).
#[allow(unsafe_code)]
pub unsafe extern "C" fn rs_decode(png: *const u8, len: usize) -> u32 {
    #[cfg(target_arch = "wasm32")]
    wasm::clear_refusal();
    let bytes = std::slice::from_raw_parts(png, len);
    reply(decode(bytes))
}

fn decode(bytes: &[u8]) -> Result<Vec<u8>, Fail> {
    let (w, h, ch, v) = decode_png(bytes)?;
    let mut r = mem::vec_with_capacity(v.len().saturating_mul(4).saturating_add(12), "the decoded image's reply")?;
    r.extend_from_slice(&w.to_le_bytes());
    r.extend_from_slice(&h.to_le_bytes());
    r.extend_from_slice(&ch.to_le_bytes());
    for x in v {
        r.extend_from_slice(&x.to_le_bytes());
    }
    Ok(r)
}

/// Standard base64 (data: URLs), ignoring whitespace.
pub fn base64(s: &str) -> Result<Vec<u8>, Fail> {
    let mut out = mem::vec_with_capacity(s.len() / 4 * 3 + 3, "an embedded image's bytes")?;
    let (mut acc, mut bits) = (0u32, 0u32);
    for c in s.bytes() {
        let v = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            b'=' => break,
            b' ' | b'\n' | b'\r' | b'\t' => continue,
            _ => return Err("a data: URL that is not base64".into()),
        } as u32;
        acc = (acc << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    #[test]
    fn base64_decodes_and_refuses_other_characters() {
        assert_eq!(super::base64("aGVsbG8=").unwrap(), b"hello");
        assert_eq!(super::base64("aGVs\nbG8").unwrap(), b"hello");
        assert!(super::base64("a$b").is_err());
    }
}
