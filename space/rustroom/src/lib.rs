//! A Rust file's outline, for the whitespace's rooms (space/src/rsroom.js): its items (functions, impl blocks with
//! their methods, types, traits, modules, uses), each with its lines, its doc comment's first paragraph, and what
//! it refers to (the paths it calls, the methods it calls, the names it mentions), as JSON.  Parsed by syn, Rust's
//! own parser.  The host gives the source with `alloc` and `outline`, and frees what it gets back with `dealloc`.
use std::collections::BTreeSet;
use syn::spanned::Spanned;
use syn::visit::{self, Visit};

#[no_mangle]
pub extern "C" fn alloc(n: usize) -> *mut u8 {
    let mut v = Vec::<u8>::with_capacity(n.max(1));
    let p = v.as_mut_ptr();
    std::mem::forget(v);
    p
}

/// # Safety
/// `p` must come from `alloc(n)` (or from `outline`, with `n` its whole length, the 4 bytes before the JSON included).
#[no_mangle]
pub unsafe extern "C" fn dealloc(p: *mut u8, n: usize) {
    drop(Vec::from_raw_parts(p, 0, n.max(1)));
}

/// The outline of the `n` bytes at `p` (UTF-8 source, which this frees): a pointer to 4 bytes of length (little
/// endian) and then that many bytes of JSON.
///
/// # Safety
/// `p` must come from `alloc(n)`.
#[no_mangle]
pub unsafe extern "C" fn outline(p: *mut u8, n: usize) -> *mut u8 {
    let src = String::from_utf8_lossy(std::slice::from_raw_parts(p, n)).into_owned();
    dealloc(p, n);
    let json = run(&src);
    let mut out = Vec::with_capacity(json.len() + 4);
    out.extend_from_slice(&(json.len() as u32).to_le_bytes());
    out.extend_from_slice(json.as_bytes());
    let mut b = out.into_boxed_slice();
    let q = b.as_mut_ptr();
    std::mem::forget(b);
    q
}

fn js(s: &str) -> String {
    let mut o = String::with_capacity(s.len() + 2);
    o.push('"');
    for c in s.chars() {
        match c {
            '"' => o.push_str("\\\""),
            '\\' => o.push_str("\\\\"),
            '\n' => o.push_str("\\n"),
            '\r' => o.push_str("\\r"),
            '\t' => o.push_str("\\t"),
            c if (c as u32) < 0x20 => o.push_str(&format!("\\u{:04x}", c as u32)),
            c => o.push(c),
        }
    }
    o.push('"');
    o
}
fn list(v: &BTreeSet<String>) -> String {
    format!("[{}]", v.iter().map(|s| js(s)).collect::<Vec<_>>().join(","))
}

pub fn run(src: &str) -> String {
    match syn::parse_file(src) {
        Err(e) => format!("{{\"error\":{},\"line\":{}}}", js(&e.to_string()), e.span().start().line),
        Ok(f) => format!("{{\"doc\":{},\"items\":[{}]}}", js(&doc(&f.attrs)), items(&f.items).join(",")),
    }
}

// (a doc comment's first paragraph)
fn doc(attrs: &[syn::Attribute]) -> String {
    let mut lines = Vec::new();
    for a in attrs {
        if !a.path().is_ident("doc") {
            continue;
        }
        if let syn::Meta::NameValue(nv) = &a.meta {
            if let syn::Expr::Lit(syn::ExprLit { lit: syn::Lit::Str(s), .. }) = &nv.value {
                lines.push(s.value());
            }
        }
    }
    let text = lines.join("\n");
    let para = text.trim().split("\n\n").next().unwrap_or("").split_whitespace().collect::<Vec<_>>().join(" ");
    para
}

fn lines_of<T: Spanned>(t: &T) -> (usize, usize) {
    let s = t.span();
    (s.start().line, s.end().line.max(s.start().line))
}

fn path_str(p: &syn::Path) -> String {
    p.segments.iter().map(|s| s.ident.to_string()).collect::<Vec<_>>().join("::")
}
fn type_name(t: &syn::Type) -> String {
    match t {
        syn::Type::Path(tp) => tp.path.segments.last().map(|s| s.ident.to_string()).unwrap_or_default(),
        syn::Type::Reference(r) => type_name(&r.elem),
        _ => "?".into(),
    }
}

// what a stretch of code refers to
#[derive(Default)]
struct Refs {
    calls: BTreeSet<String>,
    methods: BTreeSet<String>,
    names: BTreeSet<String>,
}
impl<'a> Visit<'a> for Refs {
    fn visit_expr_call(&mut self, e: &'a syn::ExprCall) {
        if let syn::Expr::Path(p) = &*e.func {
            self.calls.insert(path_str(&p.path));
        }
        visit::visit_expr_call(self, e);
    }
    fn visit_expr_method_call(&mut self, e: &'a syn::ExprMethodCall) {
        let recv = matches!(&*e.receiver, syn::Expr::Path(p) if p.path.is_ident("self"));
        self.methods.insert(if recv { format!("self.{}", e.method) } else { e.method.to_string() });
        visit::visit_expr_method_call(self, e);
    }
    fn visit_path(&mut self, p: &'a syn::Path) {
        for s in &p.segments {
            self.names.insert(s.ident.to_string());
        }
        visit::visit_path(self, p);
    }
    fn visit_macro(&mut self, m: &'a syn::Macro) {
        // (a macro's arguments are tokens: the names in them are read as words)
        self.names.insert(format!("{}!", path_str(&m.path)));
        for t in m.tokens.clone() {
            collect_idents(t, &mut self.names);
        }
        visit::visit_macro(self, m);
    }
}
fn collect_idents(t: proc_macro2::TokenTree, out: &mut BTreeSet<String>) {
    match t {
        proc_macro2::TokenTree::Ident(i) => {
            out.insert(i.to_string());
        }
        proc_macro2::TokenTree::Group(g) => {
            for t in g.stream() {
                collect_idents(t, out);
            }
        }
        _ => {}
    }
}
fn refs_json<F: FnOnce(&mut Refs)>(f: F) -> String {
    let mut r = Refs::default();
    f(&mut r);
    format!("{{\"calls\":{},\"methods\":{},\"names\":{}}}", list(&r.calls), list(&r.methods), list(&r.names))
}

fn sig(s: &syn::Signature) -> String {
    let args: Vec<String> = s
        .inputs
        .iter()
        .map(|a| match a {
            syn::FnArg::Receiver(r) => format!("{}{}self", if r.reference.is_some() { "&" } else { "" }, if r.mutability.is_some() { "mut " } else { "" }),
            syn::FnArg::Typed(t) => match &*t.pat {
                syn::Pat::Ident(i) => i.ident.to_string(),
                _ => "_".into(),
            },
        })
        .collect();
    format!("{}({})", s.ident, args.join(", "))
}

fn func(name: &str, sg: &syn::Signature, attrs: &[syn::Attribute], whole: (usize, usize), block: &syn::Block, vis_pub: bool) -> String {
    let refs = refs_json(|r| {
        r.visit_signature(sg);
        r.visit_block(block);
    });
    // (its own parameters aren't the file's names: listed, so the host can leave them out)
    let mut params = BTreeSet::new();
    for a in &sg.inputs {
        if let syn::FnArg::Typed(t) = a {
            if let syn::Pat::Ident(i) = &*t.pat {
                params.insert(i.ident.to_string());
            }
        }
    }
    format!(
        "{{\"k\":\"fn\",\"name\":{},\"sig\":{},\"start\":{},\"end\":{},\"doc\":{},\"pub\":{},\"params\":{},\"refs\":{}}}",
        js(name),
        js(&sig(sg)),
        whole.0,
        whole.1,
        js(&doc(attrs)),
        vis_pub,
        list(&params),
        refs
    )
}
fn is_pub(v: &syn::Visibility) -> bool {
    !matches!(v, syn::Visibility::Inherited)
}

fn simple(what: &str, name: &str, attrs: &[syn::Attribute], whole: (usize, usize), refs: String) -> String {
    format!("{{\"k\":\"type\",\"what\":{},\"name\":{},\"start\":{},\"end\":{},\"doc\":{},\"refs\":{}}}", js(what), js(name), whole.0, whole.1, js(&doc(attrs)), refs)
}

fn use_paths(t: &syn::UseTree, prefix: String, out: &mut Vec<(String, String)>) {
    let join = |p: &str, s: &str| if p.is_empty() { s.to_string() } else { format!("{p}::{s}") };
    match t {
        syn::UseTree::Path(p) => use_paths(&p.tree, join(&prefix, &p.ident.to_string()), out),
        // (`use a::b::{self, X}`: self is b itself, bound as b)
        syn::UseTree::Name(n) if n.ident == "self" => out.push((prefix.clone(), prefix.rsplit("::").next().unwrap_or("").to_string())),
        syn::UseTree::Name(n) => out.push((join(&prefix, &n.ident.to_string()), n.ident.to_string())),
        syn::UseTree::Rename(r) => out.push((join(&prefix, &r.ident.to_string()), r.rename.to_string())),
        syn::UseTree::Glob(_) => out.push((join(&prefix, "*"), "*".into())),
        syn::UseTree::Group(g) => {
            for t in &g.items {
                use_paths(t, prefix.clone(), out);
            }
        }
    }
}

fn items(list_: &[syn::Item]) -> Vec<String> {
    let mut out = Vec::new();
    for it in list_ {
        let whole = lines_of(it);
        match it {
            syn::Item::Fn(f) => out.push(func(&f.sig.ident.to_string(), &f.sig, &f.attrs, whole, &f.block, is_pub(&f.vis))),
            syn::Item::Impl(i) => {
                let mut fns = Vec::new();
                for ii in &i.items {
                    if let syn::ImplItem::Fn(m) = ii {
                        fns.push(func(&m.sig.ident.to_string(), &m.sig, &m.attrs, lines_of(ii), &m.block, is_pub(&m.vis)));
                    }
                }
                let tr = i.trait_.as_ref().map(|(_, p, _)| path_str(p)).unwrap_or_default();
                let refs = refs_json(|r| {
                    r.visit_type(&i.self_ty);
                    if let Some((_, p, _)) = &i.trait_ {
                        r.visit_path(p);
                    }
                });
                out.push(format!(
                    "{{\"k\":\"impl\",\"name\":{},\"trait\":{},\"start\":{},\"end\":{},\"doc\":{},\"items\":[{}],\"refs\":{}}}",
                    js(&type_name(&i.self_ty)),
                    js(&tr),
                    whole.0,
                    whole.1,
                    js(&doc(&i.attrs)),
                    fns.join(","),
                    refs
                ));
            }
            syn::Item::Struct(s) => out.push(simple("struct", &s.ident.to_string(), &s.attrs, whole, refs_json(|r| r.visit_fields(&s.fields)))),
            syn::Item::Enum(e) => out.push(simple("enum", &e.ident.to_string(), &e.attrs, whole, refs_json(|r| r.visit_item_enum(e)))),
            syn::Item::Union(u) => out.push(simple("union", &u.ident.to_string(), &u.attrs, whole, refs_json(|r| r.visit_fields_named(&u.fields)))),
            syn::Item::Type(t) => out.push(simple("type", &t.ident.to_string(), &t.attrs, whole, refs_json(|r| r.visit_type(&t.ty)))),
            syn::Item::Const(c) => out.push(simple("const", &c.ident.to_string(), &c.attrs, whole, refs_json(|r| r.visit_expr(&c.expr)))),
            syn::Item::Static(s) => out.push(simple("static", &s.ident.to_string(), &s.attrs, whole, refs_json(|r| r.visit_expr(&s.expr)))),
            syn::Item::Trait(t) => {
                let mut fns = Vec::new();
                for ti in &t.items {
                    if let syn::TraitItem::Fn(m) = ti {
                        match &m.default {
                            Some(b) => fns.push(func(&m.sig.ident.to_string(), &m.sig, &m.attrs, lines_of(ti), b, true)),
                            None => {
                                let (a, z) = lines_of(ti);
                                fns.push(format!("{{\"k\":\"fn\",\"name\":{},\"sig\":{},\"start\":{a},\"end\":{z},\"doc\":{},\"pub\":true,\"params\":[],\"refs\":{{\"calls\":[],\"methods\":[],\"names\":[]}},\"required\":true}}", js(&m.sig.ident.to_string()), js(&sig(&m.sig)), js(&doc(&m.attrs))));
                            }
                        }
                    }
                }
                out.push(format!(
                    "{{\"k\":\"trait\",\"name\":{},\"start\":{},\"end\":{},\"doc\":{},\"items\":[{}],\"refs\":{{\"calls\":[],\"methods\":[],\"names\":[]}}}}",
                    js(&t.ident.to_string()),
                    whole.0,
                    whole.1,
                    js(&doc(&t.attrs)),
                    fns.join(",")
                ));
            }
            syn::Item::Mod(m) => {
                let inner = m.content.as_ref().map(|(_, its)| items(its)).unwrap_or_default();
                out.push(format!(
                    "{{\"k\":\"mod\",\"name\":{},\"inline\":{},\"start\":{},\"end\":{},\"doc\":{},\"items\":[{}]}}",
                    js(&m.ident.to_string()),
                    m.content.is_some(),
                    whole.0,
                    whole.1,
                    js(&doc(&m.attrs)),
                    inner.join(",")
                ));
            }
            syn::Item::Use(u) => {
                let mut ps = Vec::new();
                use_paths(&u.tree, String::new(), &mut ps);
                let body = ps.iter().map(|(p, n)| format!("[{},{}]", js(p), js(n))).collect::<Vec<_>>().join(",");
                out.push(format!("{{\"k\":\"use\",\"paths\":[{}],\"start\":{},\"end\":{}}}", body, whole.0, whole.1));
            }
            syn::Item::Macro(m) => {
                // (macro_rules! name, or an item made by a macro: lazy_static! { … })
                match &m.ident {
                    Some(i) => out.push(simple("macro_rules", &i.to_string(), &m.attrs, whole, refs_json(|r| r.visit_macro(&m.mac)))),
                    None => out.push(simple("invocation", &format!("{}!", path_str(&m.mac.path)), &m.attrs, whole, refs_json(|r| r.visit_macro(&m.mac)))),
                }
            }
            _ => {}
        }
    }
    out
}
