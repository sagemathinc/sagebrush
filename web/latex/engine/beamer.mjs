// Beamer's slides and overlays for the renderer (render.mjs), as a lazy chunk of the worker's own
// (dist/sagebrush-latex-beamer.js, web/build.ts), fetched only by a document that needs it (the class beamer, or an
// overlay command): a document without slides never pays for it. The CLI and the tests install it at once.
// It imports nothing, so the chunk has no copy of the renderer: what it needs of render.mjs comes in install()'s
// arguments, the Renderer's prototype, its command table and {esc, OV_STEPS_MAX}.
// a beamer slide's box (style.ts .slide): the class's aspectratio (beamer's paper sizes, in mm) and its type size as a share
// of the slide's width (--sfs, in cqw: the slide is a size container); 11pt and 4:3 (128 x 96 mm) unless given
const ASPECTS = { "1610": [160, 100], "169": [160, 90], "149": [140, 90], "141": [148.5, 105], "54": [125, 100], "43": [128, 96], "32": [135, 90] };
function slideStyle(opt) {
  const m = /aspectratio\s*=\s*(\d+)/.exec(opt || ""), [w, h] = ASPECTS[m && Object.hasOwn(ASPECTS, m[1]) ? m[1] : "43"];
  const pt = /(^|,)\s*(8|9|10|11|12|14|17|20)pt\s*(,|$)/.exec(opt || ""), size = pt ? +pt[2] : 11;
  return "aspect-ratio:" + w + "/" + h + ";--sfs:" + (size * 0.3528 / w * 100).toFixed(3);
}
let esc, OV_STEPS_MAX;
export function install(proto, CMDS, deps) {
  ({ esc, OV_STEPS_MAX } = deps);
  Object.assign(proto, {
    // a beamer frame as a slide: \begin{frame}<spec>[options]<spec>{title}{subtitle}, or \frametitle / \framesubtitle
    // at its top level. Its overlays are all shown (every step at once). The slide's size is the class's aspectratio
    // (4:3 unless given); its type scales with its width (style.ts)
    frame(kids, ctx, flow) {
      let j = this.spec(kids, -1), o;
      [o, j] = this.opt(kids, j); const fopts = o ? this.str(o) : "";
      j = this.spec(kids, j);
      const grp = (i) => { let k = i + 1; while (k < kids.length && this.isSp(kids[k])) k++; return kids[k] && kids[k].t === "g" ? k : -1; };
      let title = null, sub = null, g = grp(j);
      if (g >= 0) { title = kids[g].kids; j = g; g = grp(j); if (g >= 0) { sub = kids[g].kids; j = g; } }
      const body = [], rest = kids.slice(j + 1);
      for (let i = 0; i < rest.length; i++) {
        const nm = this.csName(rest[i]);
        if (nm === "frametitle" || nm === "framesubtitle") {
          const k0 = this.spec(rest, i); const [, k1] = this.opt(rest, k0); const [a, k2] = this.arg(rest, k1);
          if (nm === "frametitle") title = a; else sub = a;
          i = k2; continue;
        }
        body.push(rest[i]);
      }
      const n = this.frameList.length + 1;
      this.frameList.push({ n, title: title ? this.str(title).replace(/\s+/g, " ").trim() : "", at: this.lastPos });
      const plain = /\bplain\b/.test(fopts), S = this.bsec ?? [];
      const head = title && !plain ? '<header class="slide-title">' + this.inline(title, ctx) + (sub ? '<div class="slide-subtitle">' + this.inline(sub, ctx) + "</div>" : "") + "</header>" : "";
      // (the theme's furniture: placeholders furnish() fills; the frame's section and subsection, as the headline marks)
      (this.bfr ??= [])[n - 1] = { s: S.length - 1, u: S.length ? S[S.length - 1].subs.length - 1 : -1 };
      const va = /(^|,)\s*t\s*(,|$)/.test(fopts) ? " va-t" : /(^|,)\s*b\s*(,|$)/.test(fopts) ? " va-b" : "";
      const side = !plain && this.bth?.[0] === "sb" && !this.btpl?.["sidebar left"];
      const b = flow.open("section", ' class="slide' + va + (side ? " sbar" : "") + '" data-frame="' + n + '" id="frame-' + n + '" style="' + slideStyle(this.clsOpt) + '"', (plain ? "" : "\u0001Bs" + n + "\u0002\u0001Bh" + n + "\u0002") + head);
      if (!plain) b.tail = "\u0001Bf" + n + "\u0002";
      const inner = flow.open("div", ' class="slide-body"');
      // (the frame's overlays: its specs' and pauses' highest step, and beamer's beamerpauses counter less one (plus), which
      //  + advances and uses and \pause advances: what follows a \pause is shown from plus + 1 on)
      const saved = this.ov; this.ov = { max: 1, plus: 0 };
      this.walk(body, Object.assign({}, ctx, { st: Object.assign({}, ctx.st) }), flow);
      const steps = Math.min(OV_STEPS_MAX, Math.max(1, this.ov.max));
      this.ov = saved;
      b.attrs += ' data-steps="' + steps + '"';
      this.frameList[n - 1].steps = steps;
      flow.close(inner); flow.close(b);
    },
    // a frame's content shown on some steps only: mode only (no room otherwise), uncover (its room kept), invisible (hidden
    // on those steps), onlynot (shown on the others); a block's content in a div, an inline one in a span
    ovWrap(a, spec, mode, ctx, flow) {
      if (!spec) { if (mode === "invisible") flow.html('<span class="invisible">' + this.inline(a, ctx) + "</span>", ctx.st); else if (mode !== "onlynot") this.walk(a, ctx, flow); return; }
      const attrs = ' class="ov" data-ov="' + esc(spec) + '" data-ovm="' + mode + '"';
      if (a.some((x) => x.t === "e" || this.csName(x) === "par" || x.t === "V")) { const b = flow.open("div", attrs); this.walk(a, ctx, flow); flow.close(b); }
      else flow.html("<span" + attrs + ">" + this.inline(a, ctx) + "</span>", ctx.st);
    },
    // an overlay command's argument (after its <spec>): shown, as every step is; \invisible's takes its room, unseen
    overlayArg(nodes, i, ctx, flow, mode) {
      const [j0, spec] = this.ovSpec(nodes, i); const [a, j] = this.arg(nodes, j0);
      this.ovWrap(a, spec, mode, ctx, flow);
      return j;
    },
    // beamer's block, alertblock and exampleblock: {title}, then the body
    bblock(n, ctx, flow) {
      const j0 = this.spec(n.kids, -1); const [t, j] = this.arg(n.kids, j0);
      const b = flow.open("div", ' class="bblock ' + n.env + '"', '<div class="bblock-title">' + this.inline(t, ctx) + "</div>");
      const inner = flow.open("div", ' class="bblock-body"');
      this.walk(n.kids.slice(j + 1), ctx, flow); flow.close(inner); flow.close(b);
    },
    // the furniture of frame n: its sidebar (w "s"), headline ("h") or footline ("f"), as the theme draws it (THEMES),
    // from the short title, author, institute and date, the sections and the frame number; none where the document
    // sets that template itself (a footline of [frame number] or [page number]: the number)
    furnish(w, n) {
      const [hl, fl] = this.bth ?? [], tpl = this.btpl ?? {}, fr = this.bfr[n - 1], S = this.bsec ?? [], cur = S[fr.s];
      const sh = (k) => this.bshort?.[k] ?? this.meta[k] ?? "", now = cur?.subs[fr.u] ?? "";
      const span = (t, on) => "<span" + (on ? ' class="cur"' : "") + ">" + t + "</span>", cells = (...c) => c.map((x) => "<div>" + x + "</div>").join("");
      // (the names spaced, not only apart: a reader, a copy, the page's text read them as words)
      const secs = S.map((x, k) => span(x.t, k === fr.s)).join(" "), subs = cur ? cur.subs.map((x, k) => span(x, k === fr.u)).join(" ") : "";
      if (w === "s") return hl !== "sb" || tpl["sidebar left"] ? "" : '<div class="slide-side">' + cells(span(sh("title"), 1), sh("author")) + S.map((x, k) => cells(span(x.t, k === fr.s)) + cells(x.subs.map((y, q) => span(y, k === fr.s && q === fr.u)).join(" "))).join("") + "</div>";
      if (w === "h") {
        if (tpl.headline || !hl || hl === "sb") return "";
        const c = { s: [secs], ss: [secs, now], sp: [secs, subs], il: [cur?.t ?? "", now], tr: [sh("title"), cur?.t ?? "", now] }[hl];
        return '<div class="slide-head' + (hl === "ss" || hl === "tr" ? " rows" : "") + '">' + cells(...c) + "</div>";
      }
      if (tpl.footline) return /number/.test(tpl.footline) ? '<div class="slide-foot"><div class="fno">' + n + "</div></div>" : "";
      const a = sh("author"), t = sh("title"), i = sh("institute");
      const c = { il: [a + (i ? " (" + i + ")" : ""), t, sh("date") + ' <span class="fno">' + n + " / " + this.frameList.length + "</span>"], ai: [a + " " + i, t], a: [a, t], ti: [t + " " + i] }[fl];
      return c ? '<div class="slide-foot">' + cells(...c) + "</div>" : "";
    },
  });
  Object.assign(CMDS, {
    // (beamer's overlays: every step is shown, so \only, \uncover, \visible and \onslide show their content; \alt its first)
    only: function (nodes, i, ctx, flow) { return this.overlayArg(nodes, i, ctx, flow, "only"); },
    uncover: function (nodes, i, ctx, flow) { return this.overlayArg(nodes, i, ctx, flow, "uncover"); },
    visible: function (nodes, i, ctx, flow) { return this.overlayArg(nodes, i, ctx, flow, "uncover"); },
    invisible: function (nodes, i, ctx, flow) { return this.overlayArg(nodes, i, ctx, flow, "invisible"); },
    // (\pause: what follows in the frame is shown from the next step on: a marker the presenter hides after, overlay.ts)
    pause: function (nodes, i, ctx, flow) {
      if (!this.ov) return i;
      const k = Math.min(OV_STEPS_MAX - 1, ++this.ov.plus); this.ov.max = Math.max(this.ov.max, k + 1);
      flow.html('<span class="ovpause" data-pause="' + k + '"></span>', ctx.st); return this.opt(nodes, i)[1];
    },
    onslide: function (nodes, i) { return this.spec(nodes, i); },
    alt: function (nodes, i, ctx, flow) { const [j0, spec] = this.ovSpec(nodes, i); const [a, j] = this.arg(nodes, j0); const [b, j2] = this.arg(nodes, j); if (spec) { this.ovWrap(a, spec, "only", ctx, flow); this.ovWrap(b, spec, "onlynot", ctx, flow); } else this.walk(a, ctx, flow); return j2; },
  });
  // the sections and subsections, for beamer's headlines (starred ones too: beamer leaves them out of the contents only),
  // their short forms if given
  const sec = proto.sec;
  proto.sec = function (n, ctx, flow) {
    if (n.cmd === "section" || n.cmd === "subsection") {
      const S = (this.bsec ??= []), t = esc(String(n.short ?? this.str(n.kids)).replace(/\\[a-zA-Z@]+\*?\s*|[{}]/g, "").trim());
      if (n.cmd === "section") S.push({ t, subs: [] }); else if (S.length) S[S.length - 1].subs.push(t);
    }
    return sec.call(this, n, ctx, flow);
  };
  // \usetheme, \useoutertheme: the furniture they draw; \setbeamertemplate{headline|footline|sidebar left}: the
  // document's own (none of ours). In any class, their arguments as before (read and dropped)
  const theme = (table) => function (nodes, i) {
    const [, j0] = this.opt(nodes, i), [a, j] = this.arg(nodes, j0);
    for (const t of this.str(a).split(",")) if (Object.hasOwn(table, t.trim())) this.bth = table[t.trim()];
    return j;
  };
  CMDS.usetheme = theme(THEMES); CMDS.useoutertheme = theme(OUTER);
  CMDS.setbeamertemplate = function (nodes, i) {
    const [a, j0] = this.arg(nodes, i), nm = this.str(a).trim();
    let [o, j] = this.opt(nodes, j0); if (!o) [, j] = this.arg(nodes, j0);
    if (nm === "headline" || nm === "footline" || nm === "sidebar left") (this.btpl ??= {})[nm] = o ? this.str(o) : "own";
    return j;
  };
  // \title, \author, \institute and \date in beamer: a [short] form first, for the furniture; the long one as before
  for (const k of ["title", "author", "institute", "date"]) {
    const core = CMDS[k];
    CMDS[k] = function (nodes, i, ctx, flow) {
      if (this.cls !== "beamer") return core.call(this, nodes, i, ctx, flow);
      const [o, j] = this.opt(nodes, i);
      if (o) (this.bshort ??= {})[k] = this.captured(() => this.inline(o, ctx))[0];
      return core.call(this, nodes, j, ctx, flow);
    };
  }
}
// The furniture each theme draws (TeX Live's beamer, probed per theme, 2026-11-04): [headline, footline].
// Headline: s, every section (the frame's marked); ss, and its subsection under; sp, the sections | the section's
// subsections; il, section | subsection; tr, title / section / subsection; sb, a sidebar (title, author, the sections,
// each with its subsections). Footline: il, author (institute) | title | date n / N; ai, author institute | title;
// a, author | title; ti, title institute. Not here (default, Pittsburgh, Rochester, Bergen, ...): none.
const THEMES = { Madrid: [0, "il"], Boadilla: [0, "il"], AnnArbor: ["il", "il"], CambridgeUS: ["il", "il"], Antibes: ["tr"], JuanLesPins: ["tr"],
  Montpellier: ["tr"], Berkeley: ["sb"], PaloAlto: ["sb"], Goettingen: ["sb"], Marburg: ["sb"], Hannover: ["sb"], Berlin: ["ss", "ai"],
  Dresden: ["ss", "ai"], Ilmenau: ["ss", "ai"], Darmstadt: ["ss"], Szeged: ["ss", "ti"], Frankfurt: ["s"], Singapore: ["s"],
  Copenhagen: ["sp", "a"], Luebeck: ["sp", "a"], Malmoe: ["sp", "a"], Warsaw: ["sp", "a"], default: [] };
const OUTER = { infolines: ["il", "il"], miniframes: ["ss"], smoothbars: ["ss"], split: ["sp", "a"], shadow: ["sp", "a"], tree: ["tr"], smoothtree: ["tr"], sidebar: ["sb"], default: [] };
