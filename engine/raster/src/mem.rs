//! The engine's large buffers, allocated fallibly: a picture, layer, mask,
//! RGBA copy, PNG output or decoded image that the memory the call was given
//! can't hold is the call's memory refusal (Fail::Memory, with the bytes
//! asked for), never an abort (PNG plan r8 §2.4: the in-band memory
//! outcome).  The smaller allocations inside tiny-skia and png stay
//! infallible: running out there ends the native child with Rust's
//! "memory allocation of N bytes failed", or traps the WebAssembly instance
//! with the page bound's refusal recorded (r8 §2.2, §2.4).

use crate::Fail;
use tiny_skia::{IntSize, Mask, Pixmap};

/// A Vec of capacity n, or the memory refusal for n elements of T.
pub fn vec_with_capacity<T>(n: usize, what: &'static str) -> Result<Vec<T>, Fail> {
    let mut v = Vec::new();
    let bytes = (n as u64).saturating_mul(std::mem::size_of::<T>() as u64);
    v.try_reserve_exact(n).map_err(|_| Fail::Memory { bytes, what })?;
    Ok(v)
}

/// n zero bytes.
pub fn zeroed(n: usize, what: &'static str) -> Result<Vec<u8>, Fail> {
    let mut v = vec_with_capacity(n, what)?;
    v.resize(n, 0);
    Ok(v)
}

/// The bytes of a w x h raster of `per_pixel` bytes a pixel, or the input's
/// refusal when it can't even be counted (a size past usize).
fn raster_bytes(w: u32, h: u32, per_pixel: u64, what: &'static str) -> Result<usize, Fail> {
    let n = (w as u64).checked_mul(h as u64).and_then(|n| n.checked_mul(per_pixel));
    match n.and_then(|n| usize::try_from(n).ok()) {
        Some(n) => Ok(n),
        None => Err(Fail::Memory { bytes: n.unwrap_or(u64::MAX), what }),
    }
}

/// A transparent w x h pixmap (tiny-skia's Pixmap::new, whose allocation
/// can't fail cleanly).
pub fn pixmap(w: u32, h: u32, what: &'static str) -> Result<Pixmap, Fail> {
    let size = IntSize::from_wh(w, h).ok_or_else(|| Fail::Input(format!("a picture of {} x {} pixels", w, h)))?;
    let data = zeroed(raster_bytes(w, h, 4, what)?, what)?;
    Pixmap::from_vec(data, size).ok_or_else(|| Fail::Backend(format!("tiny-skia refused a {} x {} pixmap", w, h)))
}

/// An empty w x h mask (as Mask::new).
pub fn mask(w: u32, h: u32, what: &'static str) -> Result<Mask, Fail> {
    let size = IntSize::from_wh(w, h).ok_or_else(|| Fail::Input(format!("a mask of {} x {} pixels", w, h)))?;
    let data = zeroed(raster_bytes(w, h, 1, what)?, what)?;
    Mask::from_vec(data, size).ok_or_else(|| Fail::Backend(format!("tiny-skia refused a {} x {} mask", w, h)))
}

/// A writer into a Vec that grows fallibly: the PNG encoder's output.  A
/// growth refused is recorded (`refused`, the bytes asked for) and returned
/// to the encoder as an error, which the caller turns into Fail::Memory.
pub struct TryVec {
    pub buf: Vec<u8>,
    pub refused: Option<u64>,
}

impl TryVec {
    pub fn new() -> TryVec {
        TryVec { buf: Vec::new(), refused: None }
    }
}

impl std::io::Write for TryVec {
    fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
        if self.buf.capacity() - self.buf.len() < data.len() {
            // (doubling, as Vec would, but asked for fallibly)
            let want = (self.buf.len() + data.len()).max(2 * self.buf.capacity()).max(64);
            if self.buf.try_reserve_exact(want - self.buf.len()).is_err() {
                self.refused = Some(want as u64);
                return Err(std::io::Error::new(std::io::ErrorKind::OutOfMemory, "the PNG output"));
            }
        }
        self.buf.extend_from_slice(data);
        Ok(data.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_size_past_the_address_space_is_a_memory_refusal() {
        // (a w x h x 4 past u64: the refusal says the most it can, u64::MAX)
        match pixmap(u32::MAX, u32::MAX, "the picture") {
            Err(Fail::Memory { bytes, what }) => {
                assert_eq!(what, "the picture");
                assert_eq!(bytes, u64::MAX);
            }
            other => panic!("{:?}", other.err()),
        }
        assert!(matches!(vec_with_capacity::<f32>(usize::MAX / 2, "values"), Err(Fail::Memory { .. })));
        assert!(matches!(pixmap(0, 5, "x"), Err(Fail::Input(_))));
        let p = pixmap(3, 2, "x").unwrap();
        assert_eq!((p.width(), p.height(), p.data().len()), (3, 2, 24));
        assert_eq!(mask(3, 2, "x").unwrap().data().len(), 6);
    }

    #[test]
    fn the_writer_grows_and_records_its_refusal() {
        use std::io::Write;
        let mut w = TryVec::new();
        w.write_all(&[1, 2, 3]).unwrap();
        assert_eq!(w.buf, vec![1, 2, 3]);
        assert_eq!(w.refused, None);
    }
}
