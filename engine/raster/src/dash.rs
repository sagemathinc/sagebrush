//! Stroke dashing (SVG's stroke-dasharray and stroke-dashoffset), our own.
//!
//! tiny-skia's `Path::dash` gives up on a path of more than 1,000,000 dashes
//! (its MAX_DASH_COUNT), and its painter then draws nothing for the stroke
//! (PNG plan r4 §1).  Here the number of dashes has no limit: their path
//! grows in the memory the call was given, and running out of it is the
//! call's memory refusal, never a missing stroke.
//!
//! The rules are SVG's, as tiny-skia applies them (so a drawing looks the
//! same): the pattern starts `offset` into it, wrapped into one period; each
//! contour starts the pattern afresh; a closed contour that starts inside an
//! "on" dash joins its last dash to its first; a zero-length "on" dash is a
//! zero-length line, which round and square caps draw.  Distances are in
//! f64, so a long path with short dashes still advances; curves are measured
//! by subdivision to tiny-skia's tolerance, 0.5 / the transform's scale, with
//! explicit stacks rather than recursion.

use crate::Fail;
use tiny_skia::{Path, PathBuilder, PathSegment, Point};

/// A dash pattern: on, off, on, off, ... (an even number of lengths), and
/// where in it a contour starts.
pub struct Pattern {
    array: Vec<f64>,
    first_index: usize,
    first_len: f64,
}

impl Pattern {
    /// The pattern, or None where the stroke is drawn solid, as tiny-skia's
    /// StrokeDash::new refuses it: fewer than two lengths or an odd number,
    /// a negative or non-finite length or offset, or nothing in all.
    pub fn new(array: &[f32], offset: f32) -> Option<Pattern> {
        if array.len() < 2 || array.len() % 2 != 0 || !offset.is_finite() {
            return None;
        }
        if array.iter().any(|v| !v.is_finite() || *v < 0.0) {
            return None;
        }
        let array: Vec<f64> = array.iter().map(|&v| v as f64).collect();
        let period: f64 = array.iter().sum();
        if !(period > 0.0 && period.is_finite()) {
            return None;
        }
        // the offset wrapped into [0, period); a negative one counts back
        let mut phase = offset as f64;
        if phase < 0.0 {
            phase = -phase;
            if phase > period {
                phase %= period;
            }
            phase = period - phase;
            if phase == period {
                phase = 0.0;
            }
        } else if phase >= period {
            phase %= period;
        }
        // the interval the phase falls in, and what is left of it
        let (mut first_index, mut first_len) = (0, array[0]);
        for (i, &g) in array.iter().enumerate() {
            if phase > g || (phase == g && g != 0.0) {
                phase -= g;
            } else {
                first_index = i;
                first_len = g - phase;
                break;
            }
        }
        Some(Pattern { array, first_index, first_len })
    }
}

#[derive(Clone, Copy)]
enum Seg {
    Line([P; 2]),
    Quad([P; 3]),
    Cubic([P; 4]),
}

#[derive(Clone, Copy, PartialEq, Debug)]
struct P(f64, f64);

impl P {
    fn of(p: Point) -> P {
        P(p.x as f64, p.y as f64)
    }
    fn dist(self, o: P) -> f64 {
        (self.0 - o.0).hypot(self.1 - o.1)
    }
    /// A quadratic piece's midpoint, from its control point (self) and its
    /// ends: a/4 + c/2 + b/4.
    fn mid_with(self, a: P, b: P) -> P {
        P(a.0 / 4.0 + self.0 / 2.0 + b.0 / 4.0, a.1 / 4.0 + self.1 / 2.0 + b.1 / 4.0)
    }
}

fn lerp(a: P, b: P, t: f64) -> P {
    P(a.0 + (b.0 - a.0) * t, a.1 + (b.1 - a.1) * t)
}

/// The Bézier's blossom at (u, v) (quadratic) or (u, v, w) (cubic): its
/// points at t are blossom(t, t[, t]); a piece from a to b has the control
/// points blossom(a, b), or blossom(a, a, b) and blossom(a, b, b).
fn blossom2(p: &[P; 3], u: f64, v: f64) -> P {
    lerp(lerp(p[0], p[1], u), lerp(p[1], p[2], u), v)
}

fn blossom3(p: &[P; 4], u: f64, v: f64, w: f64) -> P {
    let a = [lerp(p[0], p[1], u), lerp(p[1], p[2], u), lerp(p[2], p[3], u)];
    blossom2(&a, v, w)
}

impl Seg {
    fn at(&self, t: f64) -> P {
        match self {
            Seg::Line(p) => {
                if t == 1.0 {
                    p[1]
                } else {
                    lerp(p[0], p[1], t)
                }
            }
            Seg::Quad(p) => blossom2(p, t, t),
            Seg::Cubic(p) => blossom3(p, t, t, t),
        }
    }

    /// The piece from t0 to t1, after the path's current point.
    fn piece_to(&self, t0: f64, t1: f64, pb: &mut PathBuilder) {
        if t0 == t1 {
            // a zero-length "on" dash: a zero-length line, which caps draw
            if let Some(q) = pb.last_point() {
                pb.line_to(q.x, q.y);
            }
            return;
        }
        let f = |q: P| (q.0 as f32, q.1 as f32);
        match self {
            Seg::Line(_) => {
                let (x, y) = f(self.at(t1));
                pb.line_to(x, y);
            }
            Seg::Quad(p) => {
                let ((x1, y1), (x, y)) = (f(blossom2(p, t0, t1)), f(blossom2(p, t1, t1)));
                pb.quad_to(x1, y1, x, y);
            }
            Seg::Cubic(p) => {
                let (x1, y1) = f(blossom3(p, t0, t0, t1));
                let (x2, y2) = f(blossom3(p, t0, t1, t1));
                let (x, y) = f(blossom3(p, t1, t1, t1));
                pb.cubic_to(x1, y1, x2, y2, x, y);
            }
        }
    }

    /// Whether the piece from t0 to t1 is flat to within tol, by the test
    /// tiny-skia measures with (so the dashes fall where its did), in the
    /// largest coordinate difference: a quadratic's midpoint against its
    /// chord's; a cubic's two inner control points against the chord's
    /// thirds.
    fn flat(&self, t0: f64, t1: f64, tol: f64) -> bool {
        let far = |p: P, q: P| (p.0 - q.0).abs().max((p.1 - q.1).abs()) > tol;
        match self {
            Seg::Line(_) => true,
            Seg::Quad(p) => {
                let (a, b) = (blossom2(p, t0, t0), blossom2(p, t1, t1));
                !far(blossom2(p, t0, t1).mid_with(a, b), lerp(a, b, 0.5))
            }
            Seg::Cubic(p) => {
                let (a, b) = (blossom3(p, t0, t0, t0), blossom3(p, t1, t1, t1));
                !far(blossom3(p, t0, t0, t1), lerp(a, b, 1.0 / 3.0)) && !far(blossom3(p, t0, t1, t1), lerp(a, b, 2.0 / 3.0))
            }
        }
    }
}

/// A measured contour: its segments, and in `marks` the distance along it at
/// the end of each piece measured (segment, t at the piece's end, distance).
struct Contour {
    segs: Vec<Seg>,
    marks: Vec<(usize, f64, f64)>,
    length: f64,
    closed: bool,
}

/// A piece of a curve is split until it is flat or its span in t is below
/// 2^-20, the resolution tiny-skia measures curves to (its t is 30 bits and
/// a span stops being split below 2^10 of them).  A numerical floor, not a
/// limit on the drawing: each curve is at most 2^20 pieces.
const MIN_SPAN: f64 = 1.0 / (1u32 << 20) as f64;

impl Contour {
    fn measure(segs: Vec<Seg>, closed: bool, tol: f64) -> Contour {
        let mut marks = vec![];
        let mut d = 0.0f64;
        let mut stack: Vec<(f64, f64)> = vec![];
        for (i, s) in segs.iter().enumerate() {
            stack.push((0.0, 1.0));
            while let Some((t0, t1)) = stack.pop() {
                if t1 - t0 > MIN_SPAN && !s.flat(t0, t1, tol) {
                    let tm = (t0 + t1) / 2.0;
                    // the right half after the left: a stack, so pushed first
                    stack.push((tm, t1));
                    stack.push((t0, tm));
                    continue;
                }
                let step = s.at(t0).dist(s.at(t1));
                if d + step > d {
                    d += step;
                    marks.push((i, t1, d));
                }
            }
        }
        Contour { segs, marks, length: d, closed }
    }

    /// The segment and t at distance d along the contour (0 <= d <= length).
    fn locate(&self, d: f64) -> (usize, f64) {
        // the first mark at or past d
        let k = self.marks.partition_point(|m| m.2 < d).min(self.marks.len() - 1);
        let (seg, t1, d1) = self.marks[k];
        let (t0, d0) = match k.checked_sub(1).map(|j| self.marks[j]) {
            Some((s, t, dd)) if s == seg => (t, dd),
            Some((_, _, dd)) => (0.0, dd),
            None => (0.0, 0.0),
        };
        let t = if d1 > d0 { t0 + (t1 - t0) * ((d - d0) / (d1 - d0)) } else { t1 };
        (seg, t.clamp(0.0, 1.0))
    }

    /// The contour from distance a to b, after a move to its start if move_to.
    fn piece(&self, a: f64, b: f64, move_to: bool, pb: &mut PathBuilder) {
        let (a, b) = (a.max(0.0), b.min(self.length));
        if !(a <= b) || self.marks.is_empty() {
            return;
        }
        let (sa, ta) = self.locate(a);
        let (sb, tb) = self.locate(b);
        if move_to {
            let p = self.segs[sa].at(ta);
            pb.move_to(p.0 as f32, p.1 as f32);
        }
        if sa == sb {
            self.segs[sa].piece_to(ta, tb, pb);
            return;
        }
        self.segs[sa].piece_to(ta, 1.0, pb);
        for s in &self.segs[sa + 1..sb] {
            s.piece_to(0.0, 1.0, pb);
        }
        self.segs[sb].piece_to(0.0, tb, pb);
    }
}

/// The path's contours, each as its segments of nonzero length (a close
/// adds the line back to the contour's start).
fn contours(path: &Path) -> Vec<(Vec<Seg>, bool)> {
    let mut out = vec![];
    let (mut segs, mut closed) = (vec![], false);
    let (mut start, mut last) = (P(0.0, 0.0), P(0.0, 0.0));
    let push = |segs: &mut Vec<Seg>, s: Seg, a: P, b: P| {
        // (a curve whose ends meet may still have length: kept unless all
        // its points are one)
        let all_one = match s {
            Seg::Line(_) => a == b,
            Seg::Quad(p) => p.iter().all(|q| *q == a),
            Seg::Cubic(p) => p.iter().all(|q| *q == a),
        };
        if !all_one || a != b {
            segs.push(s);
        }
    };
    for seg in path.segments() {
        match seg {
            PathSegment::MoveTo(p) => {
                if !segs.is_empty() || closed {
                    out.push((std::mem::take(&mut segs), closed));
                }
                closed = false;
                start = P::of(p);
                last = start;
            }
            PathSegment::LineTo(p) => {
                let p = P::of(p);
                push(&mut segs, Seg::Line([last, p]), last, p);
                last = p;
            }
            PathSegment::QuadTo(c, p) => {
                let (c, p) = (P::of(c), P::of(p));
                push(&mut segs, Seg::Quad([last, c, p]), last, p);
                last = p;
            }
            PathSegment::CubicTo(c1, c2, p) => {
                let (c1, c2, p) = (P::of(c1), P::of(c2), P::of(p));
                push(&mut segs, Seg::Cubic([last, c1, c2, p]), last, p);
                last = p;
            }
            PathSegment::Close => {
                push(&mut segs, Seg::Line([last, start]), last, start);
                last = start;
                closed = true;
            }
        }
    }
    if !segs.is_empty() || closed {
        out.push((segs, closed));
    }
    out
}

/// `path` dashed with `pat`, measured to the tolerance for res_scale
/// (tiny-skia's PathStroker::compute_resolution_scale of the transform the
/// stroke is drawn with); None when no dash has anything in it.
pub fn dash(path: &Path, pat: &Pattern, res_scale: f32) -> Result<Option<Path>, Fail> {
    let tol = 0.5 / (res_scale as f64).max(f64::MIN_POSITIVE);
    let mut pb = PathBuilder::new();
    for (segs, closed) in contours(path) {
        let c = Contour::measure(segs, closed, tol);
        if !c.length.is_finite() || c.marks.is_empty() {
            continue;
        }
        dash_contour(&c, pat, 0.0, &mut pb)?;
    }
    Ok(pb.finish())
}

/// One contour's dashes, the pattern starting at distance `from` (0; a
/// test starts it further on).
fn dash_contour(c: &Contour, pat: &Pattern, from: f64, pb: &mut PathBuilder) -> Result<(), Fail> {
    let n = pat.array.len();
    let mut skip_first = c.closed;
    let mut added = false;
    let mut index = pat.first_index;
    let mut len = pat.first_len;
    let mut distance = from;
    let mut cycle_start = f64::NAN;
    while distance < c.length {
        added = false;
        if index % 2 == 0 && !skip_first {
            added = true;
            c.piece(distance, distance + len, true, pb);
        }
        distance += len;
        skip_first = false;
        index += 1;
        if index == n {
            index = 0;
        }
        if index == pat.first_index {
            // a whole period: it must have moved the distance on, else
            // the dashes are below the precision of the contour's length
            if distance == cycle_start {
                return Err(Fail::Input(format!(
                    "a dash pattern of period {} on a path {} long: its dashes are below the precision of the path's length",
                    pat.array.iter().sum::<f64>(),
                    c.length
                )));
            }
            cycle_start = distance;
        }
        len = pat.array[index];
    }
    // a closed contour that ended inside a dash joins it to the first,
    // which was skipped at the start
    if c.closed && pat.first_index % 2 == 0 && pat.first_len >= 0.0 {
        c.piece(0.0, pat.first_len, !added, pb);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tiny_skia::{LineCap, Paint, Pixmap, Stroke, StrokeDash, Transform};

    fn polyline(points: &[(f32, f32)], close: bool) -> Path {
        let mut pb = PathBuilder::new();
        pb.move_to(points[0].0, points[0].1);
        for p in &points[1..] {
            pb.line_to(p.0, p.1);
        }
        if close {
            pb.close();
        }
        pb.finish().unwrap()
    }

    /// The stroke drawn with tiny-skia's dashing and with ours: the pictures
    /// and how many of their bytes differ, and by at most how much.
    fn compare(path: &Path, array: &[f32], offset: f32, width: f32, cap: LineCap, t: Transform, size: u32) -> (usize, u8) {
        let mut paint = Paint::default();
        paint.set_color_rgba8(0, 0, 0, 255);
        paint.anti_alias = true;
        let mut theirs = Pixmap::new(size, size).unwrap();
        let s = Stroke { width, line_cap: cap, dash: StrokeDash::new(array.to_vec(), offset), ..Stroke::default() };
        theirs.stroke_path(path, &paint, &s, t, None);
        let mut ours = Pixmap::new(size, size).unwrap();
        let pat = Pattern::new(array, offset).unwrap();
        let res = tiny_skia::PathStroker::compute_resolution_scale(&t);
        if let Some(d) = dash(path, &pat, res).unwrap() {
            let s = Stroke { width, line_cap: cap, ..Stroke::default() };
            ours.stroke_path(&d, &paint, &s, t, None);
        }
        let diffs: Vec<u8> = theirs.data().iter().zip(ours.data()).map(|(a, b)| a.abs_diff(*b)).filter(|d| *d > 0).collect();
        (diffs.len(), diffs.iter().copied().max().unwrap_or(0))
    }

    #[test]
    fn pattern_validation_is_tiny_skias() {
        assert!(Pattern::new(&[], 0.0).is_none());
        assert!(Pattern::new(&[1.0], 0.0).is_none());
        assert!(Pattern::new(&[1.0, 2.0, 3.0], 0.0).is_none());
        assert!(Pattern::new(&[1.0, -2.0], 0.0).is_none());
        assert!(Pattern::new(&[0.0, 0.0], 0.0).is_none());
        assert!(Pattern::new(&[1.0, 1.0], f32::INFINITY).is_none());
        assert!(Pattern::new(&[1.0, f32::INFINITY], 0.0).is_none());
        assert!(Pattern::new(&[1.0, 1.0], 0.0).is_some());
    }

    #[test]
    fn offsets_wrap_as_tiny_skias() {
        // (period 10: 3 on, 7 off) an offset of 4 starts 1 into the gap; -4
        // is 6, 3 into the gap; 13 is 3, the start of the gap
        let p = Pattern::new(&[3.0, 7.0], 4.0).unwrap();
        assert_eq!((p.first_index, p.first_len), (1, 6.0));
        let p = Pattern::new(&[3.0, 7.0], -4.0).unwrap();
        assert_eq!((p.first_index, p.first_len), (1, 4.0));
        let p = Pattern::new(&[3.0, 7.0], 13.0).unwrap();
        assert_eq!((p.first_index, p.first_len), (1, 7.0));
        let p = Pattern::new(&[3.0, 7.0], -10.0).unwrap();
        assert_eq!((p.first_index, p.first_len), (0, 3.0));
    }

    #[test]
    fn lines_match_tiny_skias_dashing() {
        // a plot's dashed polylines: the same pixels, or within one level
        // at a handful (f64 distances where tiny-skia's are f32)
        let path = polyline(&[(5.0, 5.0), (120.0, 30.0), (60.0, 100.0), (110.0, 120.0)], false);
        for (array, offset, cap) in [
            (&[6.0f32, 4.5][..], 0.0f32, LineCap::Butt),
            (&[3.7, 1.6, 0.0, 1.6][..], 2.5, LineCap::Round),
            (&[1.0, 1.0][..], -0.3, LineCap::Square),
            (&[10.0, 2.0, 1.0, 2.0][..], 7.0, LineCap::Butt),
        ] {
            let (n, max) = compare(&path, array, offset, 1.5, cap, Transform::identity(), 128);
            assert!(n <= 8 && max <= 1, "{:?} {} {:?}: {} bytes differ, by up to {}", array, offset, cap, n, max);
        }
        // closed, starting inside a dash: the last joins the first
        let square = polyline(&[(10.0, 10.0), (100.0, 10.0), (100.0, 100.0), (10.0, 100.0)], true);
        let (n, max) = compare(&square, &[30.0, 7.0], 11.0, 3.0, LineCap::Butt, Transform::from_scale(1.2, 1.2), 128);
        assert!(n <= 8 && max <= 1, "closed: {} bytes differ, by up to {}", n, max);
    }

    #[test]
    fn curves_match_tiny_skias_dashing_closely() {
        // circles and cubics: measured by subdivision as tiny-skia does (its
        // flatness test, to its tolerance), in f64 where it has f32: the
        // dashes' ends can move by a fraction of a pixel, so a few edge
        // pixels' coverage differs
        let mut pb = PathBuilder::new();
        pb.push_circle(64.0, 64.0, 50.0);
        pb.move_to(10.0, 120.0);
        pb.cubic_to(40.0, 0.0, 90.0, 140.0, 120.0, 10.0);
        pb.move_to(5.0, 60.0);
        pb.quad_to(64.0, -20.0, 123.0, 60.0);
        let path = pb.finish().unwrap();
        for (array, offset) in [(&[5.0f32, 3.0][..], 0.0f32), (&[2.0, 2.0, 8.0, 2.0][..], 1.0)] {
            let (n, max) = compare(&path, array, offset, 2.0, LineCap::Round, Transform::identity(), 128);
            assert!(n <= 4 && max <= 32, "{:?}: {} bytes differ, by up to {}", array, n, max);
        }
    }

    #[test]
    fn more_dashes_than_tiny_skia_allows_are_drawn() {
        // 2,000,000 dashes on one line: tiny-skia's dash gives None (its
        // painter would draw nothing); ours makes all of them
        let path = polyline(&[(0.0, 0.0), (2_000_000.0, 0.0)], false);
        assert!(path.dash(&StrokeDash::new(vec![0.5, 0.5], 0.0).unwrap(), 1.0).is_none());
        let d = dash(&path, &Pattern::new(&[0.5, 0.5], 0.0).unwrap(), 1.0).unwrap().unwrap();
        let moves = d.segments().filter(|s| matches!(s, PathSegment::MoveTo(_))).count();
        assert_eq!(moves, 2_000_000);
    }

    #[test]
    fn many_pairs_in_one_period() {
        // the same period as 1, 3 and 10 pairs: the "on" length is what
        // matters, never the number of pairs
        let path = polyline(&[(0.0, 0.0), (1000.0, 0.0)], false);
        let on = |array: &[f32]| {
            let d = dash(&path, &Pattern::new(array, 0.0).unwrap(), 1.0).unwrap().unwrap();
            let (mut total, mut at) = (0.0f32, (0.0f32, 0.0f32));
            for s in d.segments() {
                match s {
                    PathSegment::MoveTo(p) => at = (p.x, p.y),
                    PathSegment::LineTo(p) => {
                        total += (p.x - at.0).abs();
                        at = (p.x, p.y)
                    }
                    _ => panic!("a line's dashes are lines"),
                }
            }
            total
        };
        assert!((on(&[5.0, 5.0]) - 500.0).abs() < 1e-3);
        assert!((on(&[1.0, 1.0, 2.0, 2.0, 2.0, 2.0]) - 500.0).abs() < 1e-3);
        let ten: Vec<f32> = (0..20).map(|_| 0.5).collect();
        assert!((on(&ten) - 500.0).abs() < 1e-3);
    }

    #[test]
    fn zero_length_dashes_are_zero_length_lines() {
        // dots: each an empty line, which a round cap draws
        let path = polyline(&[(0.0, 0.0), (10.0, 0.0)], false);
        let d = dash(&path, &Pattern::new(&[0.0, 2.0], 0.0).unwrap(), 1.0).unwrap().unwrap();
        let lines: Vec<_> = d.segments().filter_map(|s| if let PathSegment::LineTo(p) = s { Some(p) } else { None }).collect();
        assert_eq!(lines.len(), 5);
        let (n, max) = compare(&path, &[0.0, 2.0], 0.0, 1.0, LineCap::Round, Transform::from_translate(2.0, 5.0), 16);
        assert!(n == 0 || max <= 1, "{} {}", n, max);
    }

    #[test]
    fn zero_length_contours_and_extreme_ratios() {
        // a contour of no length draws nothing; a tiny dash and a huge gap,
        // and a huge dash on a short line, are each one dash
        let mut pb = PathBuilder::new();
        pb.move_to(5.0, 5.0);
        pb.line_to(5.0, 5.0);
        let dot = pb.finish().unwrap();
        assert!(dash(&dot, &Pattern::new(&[1.0, 1.0], 0.0).unwrap(), 1.0).unwrap().is_none());
        let moves = |path: &Path, array: &[f32]| {
            let d = dash(path, &Pattern::new(array, 0.0).unwrap(), 1.0).unwrap().unwrap();
            d.segments().filter(|s| matches!(s, PathSegment::MoveTo(_))).count()
        };
        let long = polyline(&[(0.0, 0.0), (1.0e6, 0.0)], false);
        assert_eq!(moves(&long, &[1.0e-12, 1.0e12]), 1);
        assert_eq!(moves(&polyline(&[(0.0, 0.0), (1.0, 0.0)], false), &[1.0e12, 1.0e-12]), 1);
        // a period that a whole cycle can no longer add to the distance is
        // refused, not looped on: the pattern started where it stalls (from
        // 0 it would first make some 10^28 dashes, the call's memory refusal
        // long before)
        let c = Contour::measure(vec![Seg::Line([P(0.0, 0.0), P(1.0e30, 0.0)])], false, 0.5);
        assert_eq!(c.length, 1.0e30);
        let mut pb = PathBuilder::new();
        let e = dash_contour(&c, &Pattern::new(&[1.0e-12, 1.0e-12], 0.0).unwrap(), 1.0e17, &mut pb);
        assert!(matches!(e, Err(Fail::Input(_))));
    }
}
