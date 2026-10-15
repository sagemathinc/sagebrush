//! The SVG Sagebrush draws its plots with (lib/_graphics.py and the plots
//! built on it), drawn into a pixmap: svg, g, path, rect, circle, ellipse,
//! line, polyline, polygon, text and tspan, image (PNG data: URLs) and
//! clipPath; fill, stroke and their opacities, dashes, caps and joins,
//! transforms, group opacity, presentation attributes and style="...".
//! Anything else in a drawing is an error, not left out.

use crate::font;
use std::collections::HashMap;
use tiny_skia::{
    FillRule, FilterQuality, LineCap, LineJoin, Mask, Paint, PathBuilder, Pixmap, PixmapPaint, Rect, Stroke,
    StrokeDash, Transform,
};

// ------------------------------------------------------------------ XML

#[derive(Debug, Clone)]
pub struct Element {
    pub name: String,
    pub attrs: Vec<(String, String)>,
    pub children: Vec<Node>,
}

#[derive(Debug, Clone)]
pub enum Node {
    El(Element),
    Text(String),
}

impl Element {
    pub fn attr(&self, k: &str) -> Option<&str> {
        self.attrs.iter().find(|(a, _)| a == k).map(|(_, v)| v.as_str())
    }
}

fn decode_entities(s: &str) -> Result<String, String> {
    if !s.contains('&') {
        return Ok(s.to_string());
    }
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(i) = rest.find('&') {
        out.push_str(&rest[..i]);
        let j = rest[i..].find(';').ok_or("an & without a ;")? + i;
        let ent = &rest[i + 1..j];
        let c = match ent {
            "amp" => '&',
            "lt" => '<',
            "gt" => '>',
            "quot" => '"',
            "apos" => '\'',
            _ if ent.starts_with("#x") || ent.starts_with("#X") => {
                char::from_u32(u32::from_str_radix(&ent[2..], 16).map_err(|_| "a bad character reference")?)
                    .ok_or("a bad character reference")?
            }
            _ if ent.starts_with('#') => {
                char::from_u32(ent[1..].parse::<u32>().map_err(|_| "a bad character reference")?)
                    .ok_or("a bad character reference")?
            }
            _ => return Err(format!("the entity &{};", ent)),
        };
        out.push(c);
        rest = &rest[j + 1..];
    }
    out.push_str(rest);
    Ok(out)
}

pub fn parse(s: &str) -> Result<Element, String> {
    let b = s.as_bytes();
    let mut i = 0;
    let mut stack: Vec<Element> = vec![Element { name: String::new(), attrs: vec![], children: vec![] }];
    let mut depth_guard = 0usize;
    while i < b.len() {
        if b[i] != b'<' {
            let j = s[i..].find('<').map(|k| k + i).unwrap_or(b.len());
            let t = decode_entities(&s[i..j])?;
            if let Some(top) = stack.last_mut() {
                top.children.push(Node::Text(t));
            }
            i = j;
            continue;
        }
        if s[i..].starts_with("<!--") {
            i = s[i..].find("-->").ok_or("an unterminated comment")? + i + 3;
            continue;
        }
        if s[i..].starts_with("<![CDATA[") {
            let j = s[i..].find("]]>").ok_or("an unterminated CDATA section")? + i;
            let t = s[i + 9..j].to_string();
            stack.last_mut().unwrap().children.push(Node::Text(t));
            i = j + 3;
            continue;
        }
        if s[i..].starts_with("<?") || s[i..].starts_with("<!") {
            i = s[i..].find('>').ok_or("an unterminated declaration")? + i + 1;
            continue;
        }
        if s[i..].starts_with("</") {
            let j = s[i..].find('>').ok_or("an unterminated end tag")? + i;
            let name = s[i + 2..j].trim();
            let el = stack.pop().ok_or("an end tag without a start")?;
            if el.name != name || stack.is_empty() {
                return Err(format!("</{}> does not close <{}>", name, el.name));
            }
            stack.last_mut().unwrap().children.push(Node::El(el));
            i = j + 1;
            continue;
        }
        // a start tag
        i += 1;
        let start = i;
        while i < b.len() && !b[i].is_ascii_whitespace() && b[i] != b'>' && b[i] != b'/' {
            i += 1;
        }
        let name = s[start..i].to_string();
        let mut attrs = vec![];
        loop {
            while i < b.len() && b[i].is_ascii_whitespace() {
                i += 1;
            }
            if i >= b.len() {
                return Err("an unterminated tag".into());
            }
            if b[i] == b'>' {
                i += 1;
                depth_guard += 1;
                if depth_guard > 100_000 || stack.len() > 256 {
                    return Err("the drawing is nested too deeply".into());
                }
                stack.push(Element { name, attrs, children: vec![] });
                break;
            }
            if b[i] == b'/' {
                if b.get(i + 1) != Some(&b'>') {
                    return Err("a / in a tag".into());
                }
                i += 2;
                stack.last_mut().unwrap().children.push(Node::El(Element { name, attrs, children: vec![] }));
                break;
            }
            let k0 = i;
            while i < b.len() && b[i] != b'=' && !b[i].is_ascii_whitespace() && b[i] != b'>' {
                i += 1;
            }
            let key = s[k0..i].to_string();
            while i < b.len() && b[i].is_ascii_whitespace() {
                i += 1;
            }
            if b.get(i) != Some(&b'=') {
                return Err(format!("the attribute {} has no value", key));
            }
            i += 1;
            while i < b.len() && b[i].is_ascii_whitespace() {
                i += 1;
            }
            let q = *b.get(i).ok_or("an unterminated attribute")?;
            if q != b'"' && q != b'\'' {
                return Err(format!("the attribute {} is not quoted", key));
            }
            let j = s[i + 1..].find(q as char).ok_or("an unterminated attribute")? + i + 1;
            attrs.push((key, decode_entities(&s[i + 1..j])?));
            i = j + 1;
        }
    }
    if stack.len() != 1 {
        return Err(format!("<{}> is not closed", stack.last().unwrap().name));
    }
    let root = stack.pop().unwrap();
    root.children
        .into_iter()
        .find_map(|n| match n {
            Node::El(e) if e.name == "svg" => Some(e),
            _ => None,
        })
        .ok_or_else(|| "no <svg> element".to_string())
}

// ------------------------------------------------------------------ values

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rgba(pub f32, pub f32, pub f32, pub f32);

#[derive(Debug, Clone, Copy)]
enum Fill {
    None,
    Color(Rgba),
    Current,
}

fn hex(s: &str) -> Option<Rgba> {
    let h = |a: &str| u8::from_str_radix(a, 16).ok().map(|v| v as f32 / 255.0);
    let d = |c: char| c.to_digit(16).map(|v| (v * 17) as f32 / 255.0);
    let c: Vec<char> = s.chars().collect();
    match c.len() {
        3 => Some(Rgba(d(c[0])?, d(c[1])?, d(c[2])?, 1.0)),
        4 => Some(Rgba(d(c[0])?, d(c[1])?, d(c[2])?, d(c[3])?)),
        6 => Some(Rgba(h(&s[0..2])?, h(&s[2..4])?, h(&s[4..6])?, 1.0)),
        8 => Some(Rgba(h(&s[0..2])?, h(&s[2..4])?, h(&s[4..6])?, h(&s[6..8])?)),
        _ => None,
    }
}

const NAMED: &[(&str, u32)] = &[
    ("aliceblue", 0xf0f8ff), ("antiquewhite", 0xfaebd7), ("aqua", 0x00ffff), ("aquamarine", 0x7fffd4),
    ("azure", 0xf0ffff), ("beige", 0xf5f5dc), ("bisque", 0xffe4c4), ("black", 0x000000),
    ("blanchedalmond", 0xffebcd), ("blue", 0x0000ff), ("blueviolet", 0x8a2be2), ("brown", 0xa52a2a),
    ("burlywood", 0xdeb887), ("cadetblue", 0x5f9ea0), ("chartreuse", 0x7fff00), ("chocolate", 0xd2691e),
    ("coral", 0xff7f50), ("cornflowerblue", 0x6495ed), ("cornsilk", 0xfff8dc), ("crimson", 0xdc143c),
    ("cyan", 0x00ffff), ("darkblue", 0x00008b), ("darkcyan", 0x008b8b), ("darkgoldenrod", 0xb8860b),
    ("darkgray", 0xa9a9a9), ("darkgreen", 0x006400), ("darkgrey", 0xa9a9a9), ("darkkhaki", 0xbdb76b),
    ("darkmagenta", 0x8b008b), ("darkolivegreen", 0x556b2f), ("darkorange", 0xff8c00), ("darkorchid", 0x9932cc),
    ("darkred", 0x8b0000), ("darksalmon", 0xe9967a), ("darkseagreen", 0x8fbc8f), ("darkslateblue", 0x483d8b),
    ("darkslategray", 0x2f4f4f), ("darkslategrey", 0x2f4f4f), ("darkturquoise", 0x00ced1), ("darkviolet", 0x9400d3),
    ("deeppink", 0xff1493), ("deepskyblue", 0x00bfff), ("dimgray", 0x696969), ("dimgrey", 0x696969),
    ("dodgerblue", 0x1e90ff), ("firebrick", 0xb22222), ("floralwhite", 0xfffaf0), ("forestgreen", 0x228b22),
    ("fuchsia", 0xff00ff), ("gainsboro", 0xdcdcdc), ("ghostwhite", 0xf8f8ff), ("gold", 0xffd700),
    ("goldenrod", 0xdaa520), ("gray", 0x808080), ("green", 0x008000), ("greenyellow", 0xadff2f),
    ("grey", 0x808080), ("honeydew", 0xf0fff0), ("hotpink", 0xff69b4), ("indianred", 0xcd5c5c),
    ("indigo", 0x4b0082), ("ivory", 0xfffff0), ("khaki", 0xf0e68c), ("lavender", 0xe6e6fa),
    ("lavenderblush", 0xfff0f5), ("lawngreen", 0x7cfc00), ("lemonchiffon", 0xfffacd), ("lightblue", 0xadd8e6),
    ("lightcoral", 0xf08080), ("lightcyan", 0xe0ffff), ("lightgoldenrodyellow", 0xfafad2), ("lightgray", 0xd3d3d3),
    ("lightgreen", 0x90ee90), ("lightgrey", 0xd3d3d3), ("lightpink", 0xffb6c1), ("lightsalmon", 0xffa07a),
    ("lightseagreen", 0x20b2aa), ("lightskyblue", 0x87cefa), ("lightslategray", 0x778899), ("lightslategrey", 0x778899),
    ("lightsteelblue", 0xb0c4de), ("lightyellow", 0xffffe0), ("lime", 0x00ff00), ("limegreen", 0x32cd32),
    ("linen", 0xfaf0e6), ("magenta", 0xff00ff), ("maroon", 0x800000), ("mediumaquamarine", 0x66cdaa),
    ("mediumblue", 0x0000cd), ("mediumorchid", 0xba55d3), ("mediumpurple", 0x9370db), ("mediumseagreen", 0x3cb371),
    ("mediumslateblue", 0x7b68ee), ("mediumspringgreen", 0x00fa9a), ("mediumturquoise", 0x48d1cc),
    ("mediumvioletred", 0xc71585), ("midnightblue", 0x191970), ("mintcream", 0xf5fffa), ("mistyrose", 0xffe4e1),
    ("moccasin", 0xffe4b5), ("navajowhite", 0xffdead), ("navy", 0x000080), ("oldlace", 0xfdf5e6),
    ("olive", 0x808000), ("olivedrab", 0x6b8e23), ("orange", 0xffa500), ("orangered", 0xff4500),
    ("orchid", 0xda70d6), ("palegoldenrod", 0xeee8aa), ("palegreen", 0x98fb98), ("paleturquoise", 0xafeeee),
    ("palevioletred", 0xdb7093), ("papayawhip", 0xffefd5), ("peachpuff", 0xffdab9), ("peru", 0xcd853f),
    ("pink", 0xffc0cb), ("plum", 0xdda0dd), ("powderblue", 0xb0e0e6), ("purple", 0x800080),
    ("rebeccapurple", 0x663399), ("red", 0xff0000), ("rosybrown", 0xbc8f8f), ("royalblue", 0x4169e1),
    ("saddlebrown", 0x8b4513), ("salmon", 0xfa8072), ("sandybrown", 0xf4a460), ("seagreen", 0x2e8b57),
    ("seashell", 0xfff5ee), ("sienna", 0xa0522d), ("silver", 0xc0c0c0), ("skyblue", 0x87ceeb),
    ("slateblue", 0x6a5acd), ("slategray", 0x708090), ("slategrey", 0x708090), ("snow", 0xfffafa),
    ("springgreen", 0x00ff7f), ("steelblue", 0x4682b4), ("tan", 0xd2b48c), ("teal", 0x008080),
    ("thistle", 0xd8bfd8), ("tomato", 0xff6347), ("turquoise", 0x40e0d0), ("violet", 0xee82ee),
    ("wheat", 0xf5deb3), ("white", 0xffffff), ("whitesmoke", 0xf5f5f5), ("yellow", 0xffff00),
    ("yellowgreen", 0x9acd32),
];

fn component(s: &str) -> Option<f32> {
    let s = s.trim();
    if let Some(p) = s.strip_suffix('%') {
        return p.trim().parse::<f32>().ok().map(|v| (v / 100.0).clamp(0.0, 1.0));
    }
    s.parse::<f32>().ok().map(|v| (v / 255.0).clamp(0.0, 1.0))
}

pub fn color(s: &str) -> Result<Option<Rgba>, String> {
    let s = s.trim();
    let lower = s.to_ascii_lowercase();
    if lower == "none" || lower == "transparent" {
        return Ok(None);
    }
    if let Some(h) = s.strip_prefix('#') {
        return hex(h).map(Some).ok_or_else(|| format!("the color {}", s));
    }
    for pre in ["rgba(", "rgb("] {
        if let Some(body) = lower.strip_prefix(pre).and_then(|b| b.strip_suffix(')')) {
            let parts: Vec<&str> = body.split(|c| c == ',' || c == '/').map(|p| p.trim()).filter(|p| !p.is_empty()).collect();
            // (rgb() takes an alpha too, as CSS Color 4 has it)
            if parts.len() < 3 || parts.len() > 4 {
                return Err(format!("the color {}", s));
            }
            let r = component(parts[0]).ok_or_else(|| format!("the color {}", s))?;
            let g = component(parts[1]).ok_or_else(|| format!("the color {}", s))?;
            let b = component(parts[2]).ok_or_else(|| format!("the color {}", s))?;
            let a = if parts.len() == 4 {
                let t = parts[3];
                if let Some(p) = t.strip_suffix('%') {
                    p.parse::<f32>().map_err(|_| format!("the color {}", s))? / 100.0
                } else {
                    t.parse::<f32>().map_err(|_| format!("the color {}", s))?
                }
            } else {
                1.0
            };
            return Ok(Some(Rgba(r, g, b, a.clamp(0.0, 1.0))));
        }
    }
    if let Some((_, v)) = NAMED.iter().find(|(n, _)| *n == lower) {
        let v = *v;
        return Ok(Some(Rgba(((v >> 16) & 255) as f32 / 255.0, ((v >> 8) & 255) as f32 / 255.0, (v & 255) as f32 / 255.0, 1.0)));
    }
    Err(format!("the color {}", s))
}

/// "var(--name, fallback)": the fallback (the drawing has no CSS variables)
fn unvar(v: &str) -> String {
    let t = v.trim();
    if let Some(inner) = t.strip_prefix("var(").and_then(|r| r.strip_suffix(')')) {
        if let Some(i) = inner.find(',') {
            return unvar(inner[i + 1..].trim());
        }
        return String::new();
    }
    t.to_string()
}

fn number(s: &str) -> Result<f32, String> {
    let t = s.trim().trim_end_matches("px");
    t.parse::<f32>().map_err(|_| format!("the number {:?}", s))
}

fn numbers(s: &str) -> Result<Vec<f32>, String> {
    s.split(|c: char| c == ',' || c.is_ascii_whitespace()).filter(|p| !p.is_empty()).map(number).collect()
}

// ------------------------------------------------------------------ paths

struct PathParser<'a> {
    s: &'a [u8],
    i: usize,
}

impl<'a> PathParser<'a> {
    fn skip(&mut self) {
        while self.i < self.s.len() && (self.s[self.i].is_ascii_whitespace() || self.s[self.i] == b',') {
            self.i += 1;
        }
    }
    fn num(&mut self) -> Result<f32, String> {
        self.skip();
        let st = self.i;
        if self.i < self.s.len() && (self.s[self.i] == b'-' || self.s[self.i] == b'+') {
            self.i += 1;
        }
        let mut dot = false;
        while self.i < self.s.len() && (self.s[self.i].is_ascii_digit() || (!dot && self.s[self.i] == b'.')) {
            dot |= self.s[self.i] == b'.';
            self.i += 1;
        }
        if self.i < self.s.len() && (self.s[self.i] == b'e' || self.s[self.i] == b'E') {
            self.i += 1;
            if self.i < self.s.len() && (self.s[self.i] == b'-' || self.s[self.i] == b'+') {
                self.i += 1;
            }
            while self.i < self.s.len() && self.s[self.i].is_ascii_digit() {
                self.i += 1;
            }
        }
        std::str::from_utf8(&self.s[st..self.i]).unwrap().parse::<f32>().map_err(|_| "a path's data".to_string())
    }
    fn flag(&mut self) -> Result<bool, String> {
        self.skip();
        match self.s.get(self.i) {
            Some(b'0') => { self.i += 1; Ok(false) }
            Some(b'1') => { self.i += 1; Ok(true) }
            _ => Err("a path's arc flag".into()),
        }
    }
    fn more(&mut self) -> bool {
        self.skip();
        self.i < self.s.len() && !self.s[self.i].is_ascii_alphabetic()
    }
}

/// An SVG arc as cubic Béziers (the SVG specification's appendix on arcs:
/// endpoint to center parameterization).
fn arc_to(pb: &mut PathBuilder, x1: f32, y1: f32, mut rx: f32, mut ry: f32, phi: f32, large: bool, sweep: bool, x2: f32, y2: f32) {
    if (x1 == x2 && y1 == y2) || rx == 0.0 || ry == 0.0 {
        pb.line_to(x2, y2);
        return;
    }
    rx = rx.abs();
    ry = ry.abs();
    let (s, c) = phi.to_radians().sin_cos();
    let dx = (x1 - x2) / 2.0;
    let dy = (y1 - y2) / 2.0;
    let x1p = c * dx + s * dy;
    let y1p = -s * dx + c * dy;
    let lam = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
    if lam > 1.0 {
        rx *= lam.sqrt();
        ry *= lam.sqrt();
    }
    let num = (rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p).max(0.0);
    let den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
    let mut co = (num / den).sqrt();
    if large == sweep {
        co = -co;
    }
    let cxp = co * rx * y1p / ry;
    let cyp = -co * ry * x1p / rx;
    let cx = c * cxp - s * cyp + (x1 + x2) / 2.0;
    let cy = s * cxp + c * cyp + (y1 + y2) / 2.0;
    let ang = |ux: f32, uy: f32, vx: f32, vy: f32| {
        let a = (ux * vy - uy * vx).atan2(ux * vx + uy * vy);
        a
    };
    let t1 = ang(1.0, 0.0, (x1p - cxp) / rx, (y1p - cyp) / ry);
    let mut dt = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
    if !sweep && dt > 0.0 {
        dt -= 2.0 * std::f32::consts::PI;
    } else if sweep && dt < 0.0 {
        dt += 2.0 * std::f32::consts::PI;
    }
    let n = (dt.abs() / (std::f32::consts::PI / 2.0)).ceil().max(1.0) as usize;
    let d = dt / n as f32;
    let k = 4.0 / 3.0 * (d / 4.0).tan();
    let pt = |t: f32| {
        let (st, ct) = t.sin_cos();
        (cx + rx * ct * c - ry * st * s, cy + rx * ct * s + ry * st * c)
    };
    let der = |t: f32| {
        let (st, ct) = t.sin_cos();
        (-rx * st * c - ry * ct * s, -rx * st * s + ry * ct * c)
    };
    let mut t = t1;
    for _ in 0..n {
        let (p0x, p0y) = pt(t);
        let (d0x, d0y) = der(t);
        let (p3x, p3y) = pt(t + d);
        let (d3x, d3y) = der(t + d);
        pb.cubic_to(p0x + k * d0x, p0y + k * d0y, p3x - k * d3x, p3y - k * d3y, p3x, p3y);
        t += d;
    }
}

pub fn path_data(d: &str) -> Result<Option<tiny_skia::Path>, String> {
    let mut p = PathParser { s: d.as_bytes(), i: 0 };
    let mut pb = PathBuilder::new();
    let (mut cx, mut cy, mut sx, mut sy) = (0f32, 0f32, 0f32, 0f32);
    let (mut lcx, mut lcy) = (0f32, 0f32); // last control point (for S and T)
    let mut last = b' ';
    let mut started = false;
    loop {
        p.skip();
        if p.i >= p.s.len() {
            break;
        }
        let cmd = p.s[p.i];
        if !cmd.is_ascii_alphabetic() {
            return Err(format!("a path's data at {}", p.i));
        }
        p.i += 1;
        let rel = cmd.is_ascii_lowercase();
        let up = cmd.to_ascii_uppercase();
        let mut first = true;
        loop {
            if !first && (up == b'Z' || !p.more()) {
                break;
            }
            let (ox, oy) = if rel { (cx, cy) } else { (0.0, 0.0) };
            match up {
                b'M' => {
                    let x = p.num()? + ox;
                    let y = p.num()? + oy;
                    if first {
                        pb.move_to(x, y);
                        sx = x;
                        sy = y;
                        started = true;
                    } else {
                        pb.line_to(x, y);
                    }
                    cx = x;
                    cy = y;
                }
                b'L' => {
                    let x = p.num()? + ox;
                    let y = p.num()? + oy;
                    pb.line_to(x, y);
                    cx = x;
                    cy = y;
                }
                b'H' => {
                    let x = p.num()? + ox;
                    pb.line_to(x, cy);
                    cx = x;
                }
                b'V' => {
                    let y = p.num()? + oy;
                    pb.line_to(cx, y);
                    cy = y;
                }
                b'C' => {
                    let (x1, y1) = (p.num()? + ox, p.num()? + oy);
                    let (x2, y2) = (p.num()? + ox, p.num()? + oy);
                    let (x, y) = (p.num()? + ox, p.num()? + oy);
                    pb.cubic_to(x1, y1, x2, y2, x, y);
                    lcx = x2;
                    lcy = y2;
                    cx = x;
                    cy = y;
                }
                b'S' => {
                    let (x1, y1) = if matches!(last, b'C' | b'S') { (2.0 * cx - lcx, 2.0 * cy - lcy) } else { (cx, cy) };
                    let (x2, y2) = (p.num()? + ox, p.num()? + oy);
                    let (x, y) = (p.num()? + ox, p.num()? + oy);
                    pb.cubic_to(x1, y1, x2, y2, x, y);
                    lcx = x2;
                    lcy = y2;
                    cx = x;
                    cy = y;
                }
                b'Q' => {
                    let (x1, y1) = (p.num()? + ox, p.num()? + oy);
                    let (x, y) = (p.num()? + ox, p.num()? + oy);
                    pb.quad_to(x1, y1, x, y);
                    lcx = x1;
                    lcy = y1;
                    cx = x;
                    cy = y;
                }
                b'T' => {
                    let (x1, y1) = if matches!(last, b'Q' | b'T') { (2.0 * cx - lcx, 2.0 * cy - lcy) } else { (cx, cy) };
                    let (x, y) = (p.num()? + ox, p.num()? + oy);
                    pb.quad_to(x1, y1, x, y);
                    lcx = x1;
                    lcy = y1;
                    cx = x;
                    cy = y;
                }
                b'A' => {
                    let rx = p.num()?;
                    let ry = p.num()?;
                    let phi = p.num()?;
                    let large = p.flag()?;
                    let sweep = p.flag()?;
                    let (x, y) = (p.num()? + ox, p.num()? + oy);
                    arc_to(&mut pb, cx, cy, rx, ry, phi, large, sweep, x, y);
                    cx = x;
                    cy = y;
                }
                b'Z' => {
                    pb.close();
                    cx = sx;
                    cy = sy;
                }
                _ => return Err(format!("the path command {}", cmd as char)),
            }
            if !started {
                return Err("a path that does not start with M".into());
            }
            last = up;
            first = false;
        }
    }
    Ok(pb.finish())
}

// ------------------------------------------------------------------ transforms

pub fn transform(s: &str) -> Result<Transform, String> {
    let mut t = Transform::identity();
    let mut rest = s.trim();
    while !rest.is_empty() {
        let open = rest.find('(').ok_or_else(|| format!("the transform {}", s))?;
        let close = rest.find(')').ok_or_else(|| format!("the transform {}", s))?;
        let name = rest[..open].trim().trim_start_matches(',').trim();
        let a = numbers(&rest[open + 1..close])?;
        let m = match (name, a.len()) {
            ("matrix", 6) => Transform::from_row(a[0], a[1], a[2], a[3], a[4], a[5]),
            ("translate", 1) => Transform::from_translate(a[0], 0.0),
            ("translate", 2) => Transform::from_translate(a[0], a[1]),
            ("scale", 1) => Transform::from_scale(a[0], a[0]),
            ("scale", 2) => Transform::from_scale(a[0], a[1]),
            ("rotate", 1) => Transform::from_rotate(a[0]),
            ("rotate", 3) => Transform::from_rotate_at(a[0], a[1], a[2]),
            ("skewX", 1) => Transform::from_row(1.0, 0.0, a[0].to_radians().tan(), 1.0, 0.0, 0.0),
            ("skewY", 1) => Transform::from_row(1.0, a[0].to_radians().tan(), 0.0, 1.0, 0.0, 0.0),
            _ => return Err(format!("the transform {}", s)),
        };
        t = t.pre_concat(m);
        rest = rest[close + 1..].trim();
    }
    Ok(t)
}

// ------------------------------------------------------------------ styles

#[derive(Clone, Copy, PartialEq)]
enum Anchor {
    Start,
    Middle,
    End,
}

#[derive(Clone)]
struct Style {
    fill: Fill,
    stroke: Fill,
    stroke_width: f32,
    fill_opacity: f32,
    stroke_opacity: f32,
    color: Rgba,
    font_size: f32,
    bold: bool,
    italic: bool,
    anchor: Anchor,
    baseline: String,
    dash: Option<Vec<f32>>,
    dash_offset: f32,
    cap: LineCap,
    join: LineJoin,
    miter: f32,
    fill_rule: FillRule,
    visible: bool,
    pixelated: bool,
}

impl Style {
    fn root() -> Style {
        Style {
            fill: Fill::Color(Rgba(0.0, 0.0, 0.0, 1.0)),
            stroke: Fill::None,
            stroke_width: 1.0,
            fill_opacity: 1.0,
            stroke_opacity: 1.0,
            color: Rgba(0.0, 0.0, 0.0, 1.0),
            font_size: 16.0,
            bold: false,
            italic: false,
            anchor: Anchor::Start,
            baseline: "auto".into(),
            dash: None,
            dash_offset: 0.0,
            cap: LineCap::Butt,
            join: LineJoin::Miter,
            miter: 4.0,
            fill_rule: FillRule::Winding,
            visible: true,
            pixelated: false,
        }
    }
}

/// The element's properties: presentation attributes, then style="..."
/// (which wins), as (name, value).
fn properties(el: &Element) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = el.attrs.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
    if let Some(st) = el.attr("style") {
        for decl in st.split(';') {
            if let Some(i) = decl.find(':') {
                out.push((decl[..i].trim().to_string(), unvar(&decl[i + 1..])));
            }
        }
    }
    out
}

fn paint_value(v: &str) -> Result<Fill, String> {
    let v = v.trim();
    if v.eq_ignore_ascii_case("currentColor") {
        return Ok(Fill::Current);
    }
    Ok(match color(v)? {
        None => Fill::None,
        Some(c) => Fill::Color(c),
    })
}

// properties that are only drawing's, which the plots do not use: an error
// rather than a drawing that leaves them out
const UNSUPPORTED: &[&str] = &[
    "filter", "mask", "marker-start", "marker-mid", "marker-end", "mix-blend-mode", "stroke-dasharray-units",
    "paint-order", "vector-effect", "text-decoration", "writing-mode", "letter-spacing", "word-spacing",
    "textLength", "lengthAdjust", "rotate",
];

fn apply(style: &mut Style, el: &Element, parent_font: f32) -> Result<f32, String> {
    let mut opacity = 1.0f32;
    for (k, v) in properties(el) {
        let v = v.trim().to_string();
        match k.as_str() {
            "fill" => style.fill = paint_value(&v)?,
            "stroke" => style.stroke = paint_value(&v)?,
            "color" => {
                if let Some(c) = color(&v)? {
                    style.color = c
                }
            }
            "stroke-width" => style.stroke_width = number(&v)?,
            "fill-opacity" => style.fill_opacity = number(&v)?.clamp(0.0, 1.0),
            "stroke-opacity" => style.stroke_opacity = number(&v)?.clamp(0.0, 1.0),
            "opacity" => opacity = number(&v)?.clamp(0.0, 1.0),
            "font-size" => {
                style.font_size = if let Some(p) = v.strip_suffix('%') {
                    number(p)? / 100.0 * parent_font
                } else if let Some(e) = v.strip_suffix("em") {
                    number(e)? * parent_font
                } else {
                    number(&v)?
                }
            }
            "font-weight" => style.bold = v == "bold" || v == "bolder" || v.parse::<u32>().map(|w| w >= 600).unwrap_or(false),
            "font-style" => style.italic = v == "italic" || v == "oblique",
            "text-anchor" => {
                style.anchor = match v.as_str() {
                    "middle" => Anchor::Middle,
                    "end" => Anchor::End,
                    _ => Anchor::Start,
                }
            }
            "dominant-baseline" | "alignment-baseline" => style.baseline = v.clone(),
            "stroke-dasharray" => {
                style.dash = if v == "none" {
                    None
                } else {
                    let d = numbers(&v)?;
                    if d.iter().all(|x| *x == 0.0) || d.is_empty() {
                        None
                    } else {
                        Some(if d.len() % 2 == 1 { [d.clone(), d].concat() } else { d })
                    }
                }
            }
            "stroke-dashoffset" => style.dash_offset = number(&v)?,
            "stroke-linecap" => {
                style.cap = match v.as_str() {
                    "round" => LineCap::Round,
                    "square" => LineCap::Square,
                    _ => LineCap::Butt,
                }
            }
            "stroke-linejoin" => {
                style.join = match v.as_str() {
                    "round" => LineJoin::Round,
                    "bevel" => LineJoin::Bevel,
                    _ => LineJoin::Miter,
                }
            }
            "stroke-miterlimit" => style.miter = number(&v)?,
            "fill-rule" | "clip-rule" => style.fill_rule = if v == "evenodd" { FillRule::EvenOdd } else { FillRule::Winding },
            "visibility" => style.visible = !(v == "hidden" || v == "collapse"),
            "display" => {
                if v == "none" {
                    style.visible = false
                }
            }
            "image-rendering" => style.pixelated = v == "pixelated" || v == "optimizeSpeed" || v == "crisp-edges",
            k if UNSUPPORTED.contains(&k) && v != "none" && !v.is_empty() => {
                return Err(format!("the SVG property {}", k));
            }
            _ => {}
        }
    }
    Ok(opacity)
}

fn solid(c: Rgba, opacity: f32) -> Paint<'static> {
    let mut p = Paint::default();
    p.set_color_rgba8(
        (c.0 * 255.0).round() as u8,
        (c.1 * 255.0).round() as u8,
        (c.2 * 255.0).round() as u8,
        (c.3 * opacity * 255.0).round().clamp(0.0, 255.0) as u8,
    );
    p.anti_alias = true;
    p
}

// ------------------------------------------------------------------ drawing

pub struct Out {
    pub missing: Vec<char>,
}

struct Ctx<'a> {
    clips: HashMap<String, &'a Element>,
    w: u32,
    h: u32,
    out: Out,
    frame_drawn: bool,
    // the rasters alive at once: the picture, and the layers of the opacity
    // groups and the masks of the clip paths being drawn, nested (bytes, and
    // how many layers and masks)
    live: u64,
    nested: u32,
}

/// Opacity groups and clip paths nested deeper than this are refused: each
/// keeps a raster the size of the picture while its content is drawn.
pub const MAX_NESTED_RASTERS: u32 = 16;
/// The bytes the picture, its layers and its masks may take at once.
pub const MAX_LIVE_RASTER_BYTES: u64 = 256 << 20;

impl Ctx<'_> {
    /// Accounts for a layer or mask of `bytes` before it is allocated, or
    /// refuses it.
    fn reserve(&mut self, bytes: u64) -> Result<(), String> {
        if self.nested >= MAX_NESTED_RASTERS {
            return Err(format!("opacity groups and clip paths nested more than {} deep", MAX_NESTED_RASTERS));
        }
        if self.live + bytes > MAX_LIVE_RASTER_BYTES {
            return Err(format!(
                "a drawing of {} x {} pixels whose nested opacity groups and clip paths need more than {} MB at once",
                self.w, self.h, MAX_LIVE_RASTER_BYTES >> 20
            ));
        }
        self.live += bytes;
        self.nested += 1;
        Ok(())
    }

    fn release(&mut self, bytes: u64) {
        self.live -= bytes;
        self.nested -= 1;
    }

    fn area(&self) -> u64 {
        self.w as u64 * self.h as u64
    }
}

fn length(el: &Element, k: &str, default: f32) -> Result<f32, String> {
    match el.attr(k) {
        Some(v) => number(v),
        None => Ok(default),
    }
}

fn collect_clips<'a>(el: &'a Element, map: &mut HashMap<String, &'a Element>) {
    if el.name == "clipPath" {
        if let Some(id) = el.attr("id") {
            map.insert(id.to_string(), el);
        }
    }
    for c in &el.children {
        if let Node::El(e) = c {
            collect_clips(e, map);
        }
    }
}

fn shape_path(el: &Element) -> Result<Option<tiny_skia::Path>, String> {
    Ok(match el.name.as_str() {
        "path" => match el.attr("d") {
            Some(d) => path_data(d)?,
            None => None,
        },
        "rect" => {
            let (x, y) = (length(el, "x", 0.0)?, length(el, "y", 0.0)?);
            let (w, h) = (length(el, "width", 0.0)?, length(el, "height", 0.0)?);
            if w <= 0.0 || h <= 0.0 {
                return Ok(None);
            }
            let mut rx = el.attr("rx").map(number).transpose()?;
            let mut ry = el.attr("ry").map(number).transpose()?;
            if rx.is_none() {
                rx = ry;
            }
            if ry.is_none() {
                ry = rx;
            }
            let (rx, ry) = (rx.unwrap_or(0.0).min(w / 2.0).max(0.0), ry.unwrap_or(0.0).min(h / 2.0).max(0.0));
            if rx == 0.0 || ry == 0.0 {
                Some(PathBuilder::from_rect(Rect::from_xywh(x, y, w, h).ok_or("a rect")?))
            } else {
                let k = 0.5522847498;
                let mut pb = PathBuilder::new();
                pb.move_to(x + rx, y);
                pb.line_to(x + w - rx, y);
                pb.cubic_to(x + w - rx + k * rx, y, x + w, y + ry - k * ry, x + w, y + ry);
                pb.line_to(x + w, y + h - ry);
                pb.cubic_to(x + w, y + h - ry + k * ry, x + w - rx + k * rx, y + h, x + w - rx, y + h);
                pb.line_to(x + rx, y + h);
                pb.cubic_to(x + rx - k * rx, y + h, x, y + h - ry + k * ry, x, y + h - ry);
                pb.line_to(x, y + ry);
                pb.cubic_to(x, y + ry - k * ry, x + rx - k * rx, y, x + rx, y);
                pb.close();
                pb.finish()
            }
        }
        "circle" => {
            let r = length(el, "r", 0.0)?;
            if r <= 0.0 {
                return Ok(None);
            }
            PathBuilder::from_circle(length(el, "cx", 0.0)?, length(el, "cy", 0.0)?, r)
        }
        "ellipse" => {
            let (rx, ry) = (length(el, "rx", 0.0)?, length(el, "ry", 0.0)?);
            if rx <= 0.0 || ry <= 0.0 {
                return Ok(None);
            }
            let (cx, cy) = (length(el, "cx", 0.0)?, length(el, "cy", 0.0)?);
            PathBuilder::from_oval(Rect::from_xywh(cx - rx, cy - ry, 2.0 * rx, 2.0 * ry).ok_or("an ellipse")?)
        }
        "line" => {
            let mut pb = PathBuilder::new();
            pb.move_to(length(el, "x1", 0.0)?, length(el, "y1", 0.0)?);
            pb.line_to(length(el, "x2", 0.0)?, length(el, "y2", 0.0)?);
            pb.finish()
        }
        "polyline" | "polygon" => {
            let pts = numbers(el.attr("points").unwrap_or(""))?;
            if pts.len() < 4 {
                return Ok(None);
            }
            let mut pb = PathBuilder::new();
            pb.move_to(pts[0], pts[1]);
            for c in pts[2..].chunks(2) {
                if c.len() == 2 {
                    pb.line_to(c[0], c[1]);
                }
            }
            if el.name == "polygon" {
                pb.close();
            }
            pb.finish()
        }
        _ => None,
    })
}

fn draw_path(pix: &mut Pixmap, path: &tiny_skia::Path, st: &Style, t: Transform, mask: Option<&Mask>, fill: bool, stroke: bool) {
    if fill {
        let c = match st.fill {
            Fill::None => None,
            Fill::Color(c) => Some(c),
            Fill::Current => Some(st.color),
        };
        if let Some(c) = c {
            pix.fill_path(path, &solid(c, st.fill_opacity), st.fill_rule, t, mask);
        }
    }
    if stroke {
        let c = match st.stroke {
            Fill::None => None,
            Fill::Color(c) => Some(c),
            Fill::Current => Some(st.color),
        };
        if let (Some(c), true) = (c, st.stroke_width > 0.0) {
            let mut s = Stroke { width: st.stroke_width, line_cap: st.cap, line_join: st.join, miter_limit: st.miter, ..Stroke::default() };
            if let Some(d) = &st.dash {
                s.dash = StrokeDash::new(d.clone(), st.dash_offset);
            }
            pix.stroke_path(path, &solid(c, st.stroke_opacity), &s, t, mask);
        }
    }
}

/// The mask of el's clip-path (accounted for in ctx: the caller releases it).
fn clip_mask<'a>(ctx: &mut Ctx<'a>, el: &Element, t: Transform, parent: Option<&Mask>) -> Result<Option<Mask>, String> {
    let Some(v) = properties(el).into_iter().rev().find(|(k, _)| k == "clip-path").map(|(_, v)| v) else {
        return Ok(None);
    };
    let v = v.trim();
    if v == "none" {
        return Ok(None);
    }
    let id = v.strip_prefix("url(#").and_then(|r| r.strip_suffix(')')).ok_or_else(|| format!("the clip-path {}", v))?;
    let cp: &'a Element = *ctx.clips.get(id).ok_or_else(|| format!("no clipPath {}", id))?;
    if cp.attr("clipPathUnits").map(|u| u != "userSpaceOnUse").unwrap_or(false) {
        return Err("a clipPath in objectBoundingBox units".into());
    }
    let ct = match cp.attr("transform") {
        Some(s) => t.pre_concat(transform(s)?),
        None => t,
    };
    ctx.reserve(ctx.area())?;
    let mut m = Mask::new(ctx.w, ctx.h).ok_or("a clip mask")?;
    for c in &cp.children {
        if let Node::El(e) = c {
            if let Some(p) = shape_path(e)? {
                let et = match e.attr("transform") {
                    Some(s) => ct.pre_concat(transform(s)?),
                    None => ct,
                };
                let rule = if e.attr("clip-rule") == Some("evenodd") { FillRule::EvenOdd } else { FillRule::Winding };
                m.fill_path(&p, rule, true, et);
            } else if !matches!(e.name.as_str(), "title" | "desc") {
                return Err(format!("a <{}> in a clipPath", e.name));
            }
        }
    }
    if let Some(pm) = parent {
        for (a, b) in m.data_mut().iter_mut().zip(pm.data()) {
            *a = ((*a as u32 * *b as u32 + 127) / 255) as u8;
        }
    }
    Ok(Some(m))
}

/// A <text>'s characters with their style, as runs; whitespace collapsed as
/// SVG does (xml:space default).
struct Run {
    text: String,
    style: Style,
    dx: f32,
    dy: f32,
}

fn text_runs(el: &Element, st: &Style, out: &mut Vec<Run>) -> Result<(), String> {
    for c in &el.children {
        match c {
            Node::Text(t) => out.push(Run { text: t.clone(), style: st.clone(), dx: 0.0, dy: 0.0 }),
            Node::El(e) if e.name == "tspan" => {
                let mut s = st.clone();
                apply(&mut s, e, st.font_size)?;
                if e.attr("x").is_some() || e.attr("y").is_some() || e.attr("transform").is_some() {
                    return Err("a tspan with x, y or a transform".into());
                }
                let em = |v: &str| -> Result<f32, String> {
                    if let Some(n) = v.strip_suffix("em") {
                        Ok(number(n)? * s.font_size)
                    } else {
                        number(v)
                    }
                };
                let dx = e.attr("dx").map(em).transpose()?.unwrap_or(0.0);
                let dy = e.attr("dy").map(em).transpose()?.unwrap_or(0.0);
                let mut sub = vec![];
                text_runs(e, &s, &mut sub)?;
                if let Some(first) = sub.first_mut() {
                    first.dx += dx;
                    first.dy += dy;
                } else if dx != 0.0 || dy != 0.0 {
                    out.push(Run { text: String::new(), style: s.clone(), dx, dy });
                }
                out.extend(sub);
            }
            Node::El(e) if matches!(e.name.as_str(), "title" | "desc") => {}
            Node::El(e) => return Err(format!("a <{}> in a <text>", e.name)),
        }
    }
    Ok(())
}

fn draw_text(ctx: &mut Ctx, pix: &mut Pixmap, el: &Element, st: &Style, t: Transform, mask: Option<&Mask>) -> Result<(), String> {
    let mut runs = vec![];
    text_runs(el, st, &mut runs)?;
    // whitespace: newlines and tabs are spaces, runs of spaces one, none at either end
    let mut prev_space = true;
    for r in runs.iter_mut() {
        let mut s = String::with_capacity(r.text.len());
        for ch in r.text.chars() {
            let ch = if ch == '\n' || ch == '\t' || ch == '\r' { ' ' } else { ch };
            if ch == ' ' {
                if prev_space {
                    continue;
                }
                prev_space = true;
            } else {
                prev_space = false;
            }
            s.push(ch);
        }
        r.text = s;
    }
    if let Some(last) = runs.iter_mut().rev().find(|r| !r.text.is_empty()) {
        while last.text.ends_with(' ') {
            last.text.pop();
        }
    }
    let x0 = el.attr("x").map(|v| numbers(v)).transpose()?.and_then(|v| v.first().copied()).unwrap_or(0.0);
    let y0 = el.attr("y").map(|v| numbers(v)).transpose()?.and_then(|v| v.first().copied()).unwrap_or(0.0);
    // the layout: each character's pen position
    let mut placed: Vec<(char, f32, f32, f32, usize)> = vec![]; // (char, x, y, scale, run)
    let (mut x, mut y) = (0.0f32, 0.0f32);
    let mut prev: Option<(char, usize)> = None;
    for (ri, r) in runs.iter().enumerate() {
        x += r.dx;
        y += r.dy;
        let face = font::face(r.style.bold);
        let scale = r.style.font_size / face.units_per_em;
        for ch in r.text.chars() {
            if let Some((p, pr)) = prev {
                if runs[pr].style.bold == r.style.bold && runs[pr].style.font_size == r.style.font_size {
                    x += face.kerning(p, ch) * scale;
                }
            }
            if !face.has(ch) && ch != '\u{200b}' && !ctx.out.missing.contains(&ch) {
                ctx.out.missing.push(ch);
            }
            placed.push((ch, x, y, scale, ri));
            x += face.advance(ch) * scale;
            prev = Some((ch, ri));
        }
    }
    let width = x;
    let shift_x = match st.anchor {
        Anchor::Start => 0.0,
        Anchor::Middle => -width / 2.0,
        Anchor::End => -width,
    };
    let face = font::face(st.bold);
    let em = st.font_size;
    let (asc, desc) = (face.ascender / face.units_per_em, face.descender / face.units_per_em);
    // the baseline, from the text element's font (CSS dominant-baseline)
    let shift_y = match st.baseline.as_str() {
        "middle" => 0.5 * 0.547 * em,
        "central" => (asc + desc) / 2.0 * em,
        "hanging" => 0.8 * asc * em,
        "text-before-edge" | "text-top" | "before-edge" => asc * em,
        "text-after-edge" | "text-bottom" | "after-edge" | "ideographic" => desc * em,
        "mathematical" => 0.5 * asc * em,
        _ => 0.0,
    };
    let tt = t.pre_translate(x0 + shift_x, y0 + shift_y);
    for (ri, r) in runs.iter().enumerate() {
        let mut pb = PathBuilder::new();
        let face = font::face(r.style.bold);
        let skew = if r.style.italic { 0.2126 } else { 0.0 };
        for (ch, px, py, scale, _) in placed.iter().filter(|p| p.4 == ri) {
            face.outline(&mut pb, *ch, *px, *py, *scale, skew);
        }
        if let Some(path) = pb.finish() {
            draw_path(pix, &path, &r.style, tt, mask, true, true);
        }
    }
    Ok(())
}

fn data_png(href: &str) -> Result<Vec<u8>, String> {
    let rest = href.strip_prefix("data:image/png").ok_or("an <image> that is not a PNG data: URL")?;
    let comma = rest.find(',').ok_or("a data: URL without data")?;
    if !rest[..comma].ends_with(";base64") {
        return Err("a data: URL that is not base64".into());
    }
    crate::base64(&rest[comma + 1..])
}

fn draw_image(pix: &mut Pixmap, el: &Element, st: &Style, t: Transform, mask: Option<&Mask>) -> Result<(), String> {
    let href = el.attr("href").or_else(|| el.attr("xlink:href")).ok_or("an <image> without href")?;
    if let Some(p) = el.attr("preserveAspectRatio") {
        if p.trim() != "none" {
            return Err("an <image> whose preserveAspectRatio is not none".into());
        }
    } else {
        return Err("an <image> without preserveAspectRatio=\"none\"".into());
    }
    let bytes = data_png(href)?;
    let img = crate::pngio::decode(&bytes, crate::MAX_AXIS, crate::MAX_PIXELS)?;
    let src = crate::pngio::to_pixmap(&img)?;
    let (x, y) = (length(el, "x", 0.0)?, length(el, "y", 0.0)?);
    let (w, h) = (length(el, "width", 0.0)?, length(el, "height", 0.0)?);
    if w <= 0.0 || h <= 0.0 {
        return Ok(());
    }
    let it = t.pre_translate(x, y).pre_scale(w / src.width() as f32, h / src.height() as f32);
    let paint = PixmapPaint {
        quality: if st.pixelated { FilterQuality::Nearest } else { FilterQuality::Bilinear },
        ..PixmapPaint::default()
    };
    pix.draw_pixmap(0, 0, src.as_ref(), &paint, it, mask);
    Ok(())
}

fn draw(ctx: &mut Ctx, pix: &mut Pixmap, el: &Element, parent: &Style, pt: Transform, pmask: Option<&Mask>) -> Result<(), String> {
    match el.name.as_str() {
        "defs" | "clipPath" | "title" | "desc" | "style" | "metadata" => return Ok(()),
        _ => {}
    }
    // an animation's frames (lib/_graphics.py): the first one
    if el.attr("class").map(|c| c.split_whitespace().any(|w| w == "sb-frame")).unwrap_or(false) {
        if ctx.frame_drawn {
            return Ok(());
        }
        ctx.frame_drawn = true;
    }
    let mut st = parent.clone();
    let opacity = apply(&mut st, el, parent.font_size)?;
    if !st.visible {
        return Ok(());
    }
    let t = match el.attr("transform") {
        Some(s) => pt.pre_concat(transform(s)?),
        None => pt,
    };
    let own_mask = clip_mask(ctx, el, t, pmask)?;
    let mask = own_mask.as_ref().or(pmask);
    if opacity < 1.0 {
        // a group's opacity: drawn apart, then composited
        ctx.reserve(4 * ctx.area())?;
        let mut layer = Pixmap::new(ctx.w, ctx.h).ok_or("a layer")?;
        draw_content(ctx, &mut layer, el, &st, t, mask)?;
        let paint = PixmapPaint { opacity, ..PixmapPaint::default() };
        pix.draw_pixmap(0, 0, layer.as_ref(), &paint, Transform::identity(), None);
        ctx.release(4 * ctx.area());
    } else {
        draw_content(ctx, pix, el, &st, t, mask)?;
    }
    if own_mask.is_some() {
        ctx.release(ctx.area());
    }
    Ok(())
}

fn draw_content(ctx: &mut Ctx, pix: &mut Pixmap, el: &Element, st: &Style, t: Transform, mask: Option<&Mask>) -> Result<(), String> {
    match el.name.as_str() {
        "svg" | "g" | "a" | "switch" => {
            for c in &el.children {
                if let Node::El(e) = c {
                    draw(ctx, pix, e, st, t, mask)?;
                }
            }
            Ok(())
        }
        "path" | "rect" | "circle" | "ellipse" | "line" | "polyline" | "polygon" => {
            if let Some(p) = shape_path(el)? {
                let fill = !matches!(el.name.as_str(), "line" | "polyline") || !matches!(st.fill, Fill::None);
                draw_path(pix, &p, st, t, mask, fill && el.name != "line", true);
            }
            Ok(())
        }
        "text" => draw_text(ctx, pix, el, st, t, mask),
        "image" => draw_image(pix, el, st, t, mask),
        other => Err(format!("the SVG element <{}>", other)),
    }
}

/// The drawing at `scale` pixels per SVG unit, on `background` (None:
/// transparent), in a picture of `size` pixels (None: the drawing's size,
/// rounded), the drawing's top left at the picture's.
pub fn render(svg: &str, scale: f32, size: Option<(u32, u32)>, background: Option<Rgba>) -> Result<(Pixmap, Out), String> {
    let root = parse(svg)?;
    let (mut vx, mut vy, mut vw, mut vh) = (0.0f32, 0.0f32, 0.0f32, 0.0f32);
    if let Some(vb) = root.attr("viewBox") {
        let v = numbers(vb)?;
        if v.len() != 4 {
            return Err("the viewBox".into());
        }
        (vx, vy, vw, vh) = (v[0], v[1], v[2], v[3]);
    }
    let w = root.attr("width").map(number).transpose()?.unwrap_or(vw);
    let h = root.attr("height").map(number).transpose()?.unwrap_or(vh);
    if vw == 0.0 || vh == 0.0 {
        (vw, vh) = (w, h);
    }
    if !(w > 0.0 && h > 0.0 && scale > 0.0 && scale.is_finite()) {
        return Err("a drawing with no size".into());
    }
    let (pw, ph) = match size {
        Some((a, b)) => (a as f32, b as f32),
        None => ((w * scale).round(), (h * scale).round()),
    };
    if pw < 1.0 || ph < 1.0 || pw > crate::MAX_AXIS as f32 || ph > crate::MAX_AXIS as f32 || pw * ph > crate::MAX_PIXELS as f32 {
        return Err(format!(
            "a picture of {} x {} pixels: at most {} on a side and {} in all",
            pw, ph, crate::MAX_AXIS, crate::MAX_PIXELS
        ));
    }
    let (pw, ph) = (pw as u32, ph as u32);
    let mut pix = Pixmap::new(pw, ph).ok_or("a picture of that size")?;
    if let Some(bg) = background {
        pix.fill(tiny_skia::Color::from_rgba(bg.0, bg.1, bg.2, bg.3).ok_or("the background")?);
    }
    let mut clips = HashMap::new();
    collect_clips(&root, &mut clips);
    let mut ctx = Ctx { clips, w: pw, h: ph, out: Out { missing: vec![] }, frame_drawn: false, live: 4 * pw as u64 * ph as u64, nested: 0 };
    let t = Transform::from_scale(scale * w / vw, scale * h / vh).pre_translate(-vx, -vy);
    draw(&mut ctx, &mut pix, &root, &Style::root(), t, None)?;
    Ok((pix, ctx.out))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn nested(depth: usize, size: u32, attr: &str) -> String {
        let mut s = format!(
            r#"<svg xmlns="http://www.w3.org/2000/svg" width="{0}" height="{0}"><defs><clipPath id="c"><rect x="0" y="0" width="{0}" height="{0}"/></clipPath></defs>"#,
            size
        );
        for _ in 0..depth {
            s += &format!("<g {}>", attr);
        }
        s += r#"<rect x="0" y="0" width="1" height="1" fill="red"/>"#;
        for _ in 0..depth {
            s += "</g>";
        }
        s + "</svg>"
    }

    #[test]
    fn nested_layers_and_masks_are_limited_before_they_are_allocated() {
        // (HARD-6BC-1) 16 nested opacity groups or clip paths are drawn, 17 refused
        for attr in [r#"opacity="0.5""#, r#"clip-path="url(#c)""#] {
            assert!(render(&nested(16, 8, attr), 1.0, None, None).is_ok(), "{}", attr);
            let e = render(&nested(17, 8, attr), 1.0, None, None).err().unwrap();
            assert_eq!(e, "opacity groups and clip paths nested more than 16 deep");
        }
        // at 4096 x 4096 (64 MB the picture and a layer, 16 MB a mask), the
        // 256 MB budget allows 3 nested layers, not 4 (refused before the
        // fourth is allocated)
        let e = render(&nested(4, 4096, r#"opacity="0.5""#), 1.0, None, None).err().unwrap();
        assert_eq!(e, "a drawing of 4096 x 4096 pixels whose nested opacity groups and clip paths need more than 256 MB at once");
        let mut ctx = Ctx { clips: HashMap::new(), w: 4096, h: 4096, out: Out { missing: vec![] }, frame_drawn: false, live: 64 << 20, nested: 0 };
        ctx.reserve(64 << 20).unwrap();
        ctx.reserve(16 << 20).unwrap();
        ctx.reserve(64 << 20).unwrap();
        assert!(ctx.reserve(64 << 20).is_err());
        ctx.release(64 << 20);
        ctx.release(16 << 20);
        assert_eq!((ctx.live, ctx.nested), ((64 + 64) << 20, 1));
    }
}
