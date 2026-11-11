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
  // (--spx: one pixel of a plot as a share of the slide's width, in cqw (a plot's SVG is 100 px to the inch, figsize's
  //  unit): a plot in a slide is as wide, relative to the slide, as in the PDF, in the preview and in Present alike
  //  (William's L1, Nov 10; style.ts, page.ts))
  return "aspect-ratio:" + w + "/" + h + ";--sfs:" + (size * 0.3528 / w * 100).toFixed(3) + ";--spx:" + (25.4 / 100 / w * 100).toFixed(4);
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
      // (its number as the furniture shows it: beamer's frame counter, which [noframenumbering] doesn't step (daybreak3,
      //  FURN644-FRAME-NO-1); the frame's index, data-frame, stays the DOM's)
      const num = /\bnoframenumbering\b/.test(fopts) ? this.bnum ?? 0 : (this.bnum = (this.bnum ?? 0) + 1);
      (this.bfr ??= [])[n - 1] = { s: S.length - 1, u: S.length ? S[S.length - 1].subs.length - 1 : -1, num, plain };
      const va = /(^|,)\s*t\s*(,|$)/.test(fopts) ? " va-t" : /(^|,)\s*b\s*(,|$)/.test(fopts) ? " va-b" : "";
      const side = !plain && this.bth?.[0] === "sb" && !this.btpl?.["sidebar left"];
      const b = flow.open("section", ' class="slide' + va + (side ? " sbar" : "") + '" data-frame="' + n + '" id="frame-' + n + '" style="' + slideStyle(this.clsOpt) + '"', "\u0001Bs" + n + "\u0002\u0001Bh" + n + "\u0002" + head);
      b.tail = "\u0001Bf" + n + "\u0002";   // (filled from furnishShown's, none for a plain frame)
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
    // from the short title, author, institute and date, the sections and the frame's number; none where the document
    // sets that template itself (a footline of [frame number] or [page number]: TeX's numbers). Nothing is built for a part
    // the theme doesn't draw; over the budget (furnBudget), a short form. used gets the fields it shows whole (their
    // SageTeX shown); a field cut in the short form is its text only
    furnishPart(w, n, used) {
      const [hl, fl] = this.bth ?? [], tpl = this.btpl ?? {};
      if (w === "s" ? hl !== "sb" || tpl["sidebar left"] : w === "h" ? !hl || hl === "sb" || tpl.headline : !(tpl.footline ? /number/.test(tpl.footline) : fl)) return "";
      const fr = this.bfr[n - 1];
      // (a footline of [frame number]: TeX's "n/N", beamer's counter; of [page number]: the page among all of them, each
      //  overlay step a page, as the PDF's: on a frame of several steps, one number for each, an overlay of that step, so
      //  Present and each step's picture show its own (daybreak3, PAGE644-OVERLAY-1); the pages counted once a render)
      if (w === "f" && tpl.footline) {
        if (/frame/.test(tpl.footline)) return '<div class="slide-foot"><div class="fno">' + fr.num + "/" + (this.bnum ?? 0) + "</div></div>";
        const P = (this.bpages ??= this.frameList.reduce((a, x) => (a.start.push(a.total + 1), a.total += x.steps || 1, a), { start: [], total: 0 }));
        const k0 = P.start[n - 1], st = this.frameList[n - 1].steps || 1;
        return '<div class="slide-foot"><div class="fno">' + (st === 1 ? k0 + "/" + P.total : Array.from({ length: st }, (_, q) => '<span class="ov" data-ov="' + (q + 1) + '" data-ovm="only">' + (k0 + q) + "/" + P.total + "</span>").join(" ")) + "</div></div>";
      }
      const z = this.bz === undefined ? (this.bz = this.furnBudget()) : this.bz, S = this.bsec ?? [], cur = S[fr.s];
      // (in the short form: names and fields as their text, cut to z characters)
      const cut = (h) => { if (!z) return h; const t = h.replace(/<[^>]*>/g, "").replace(/&(amp|lt|gt|quot|#39);/g, (_, e) => ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" })[e]); return t.length > z ? esc(t.slice(0, z - 1) + "\u2026") : h; };
      const sh = (k) => { const h = this.bshort?.[k] ?? this.meta[k] ?? "", c = cut(h); if (c === h) used.add(k); return c; }, now = cut(cur?.subs[fr.u] ?? "");
      const span = (t, on) => "<span" + (on ? ' class="cur"' : "") + ">" + t + "</span>", cells = (...c) => c.map((x) => "<div>" + x + "</div>").join("");
      // (the names spaced, not only apart: a reader, a copy, the page's text read them as words; in the short form, the
      //  frame's own section and subsection only)
      const list = (xs, k0) => (z ? xs.filter((x, k) => k === k0) : xs).map((x, k) => span(cut(x), z || k === k0)).join(" ");
      const secs = () => list(S.map((x) => x.t), fr.s), subs = () => (cur ? list(cur.subs, fr.u) : "");
      if (w === "s") return '<div class="slide-side">' + cells(span(sh("title"), 1), sh("author")) + (z ? cells(span(cut(cur?.t ?? ""), 1)) + cells(now) : S.map((x, k) => cells(span(x.t, k === fr.s)) + cells(x.subs.map((y, q) => span(y, k === fr.s && q === fr.u)).join(" "))).join("")) + "</div>";
      if (w === "h") {
        const c = hl === "s" ? [secs()] : hl === "ss" ? [secs(), now] : hl === "sp" ? [secs(), subs()] : hl === "il" ? [cut(cur?.t ?? ""), now] : [sh("title"), cut(cur?.t ?? ""), now];
        return '<div class="slide-head' + (hl === "ss" || hl === "tr" ? " rows" : "") + '">' + cells(...c) + "</div>";
      }
      const a = sh("author"), t = sh("title"), i = sh("institute");
      const c = { il: [a + (i ? " (" + i + ")" : ""), t, sh("date") + ' <span class="fno">' + fr.num + " / " + (this.bnum ?? 0) + "</span>"], ai: [a + " " + i, t], a: [a, t], ti: [t + " " + i] }[fl];
      return '<div class="slide-foot">' + cells(...c) + "</div>";
    },
    // (the furniture's size before any is built (astra, BEAMER644-FURN-1): per frame, every section and subsection name
    //  and the fields, times the frames; within FURN_MAX, null (the furniture as the theme draws it); over it, the short
    //  form's cut, 80, and a problem says so)
    furnBudget() {
      const S = this.bsec ?? [], frames = this.bfr.length;
      const per = 400 + S.reduce((t, x) => t + x.t.length + 32 + x.subs.reduce((u, y) => u + y.length + 32, 0), 0)
        + ["title", "author", "institute", "date"].reduce((t, k) => t + String(this.bshort?.[k] ?? this.meta[k] ?? "").length, 0);
      if (fitsFurniture(per, frames)) return null;
      this.problems.push({ kind: "furniture", name: "the theme's headline, footline and sidebar shortened to each frame's own section (" + frames + " frames, " + S.length + " sections)", at: -1 });
      return 80;
    },
    // every frame's furniture, built before the core's SageTeX check (it calls this), within one budget for all of it,
    // the HTML as built (astra, BEAMER644-FURN-1: the short form's escaping too): past FURN_MAX, the furniture of the
    // frames after is left out, and one problem says so. The fields shown whole have their SageTeX items shown; one cut,
    // or left out, keeps them hidden (daybreak3, FURN644-SAGE-1, -SAGE-CUT-1)
    furnishShown() {
      this.bcache = new Map();
      let total = 0;
      for (let n = 1; n <= (this.bfr?.length ?? 0) && !this.bover; n++) for (const w of "shf") {
        if (this.bfr[n - 1].plain) break;
        const used = new Set(), h = this.furnishPart(w, n, used);
        if (!h) continue;
        if (total + h.length > FURN_MAX) {
          this.bover = true;
          this.problems.push({ kind: "furniture", name: "the theme's headline, footline and sidebar left out from frame " + n + " on: over the budget for them", at: -1 });
          break;
        }
        total += h.length; this.bcache.set(w + n, h);
        for (const k of used) for (const x of this.bshort?.[k] !== undefined ? this.bshortSage[k] : this.metaSage[k]) this.sageShown.add(x);
      }
    },
    furnish(w, n) { return this.bcache?.get(w + n) ?? ""; },
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
      if (o) [(this.bshort ??= {})[k], (this.bshortSage ??= {})[k]] = this.captured(() => this.inline(o, ctx));
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
// The furniture's budget: its HTML for every frame within FURN_MAX bytes (about), or the short form (furnBudget)
export const FURN_MAX = 1 << 20;
export const fitsFurniture = (perFrame, frames) => perFrame * frames <= FURN_MAX;
const OUTER = { infolines: ["il", "il"], miniframes: ["ss"], smoothbars: ["ss"], split: ["sp", "a"], shadow: ["sp", "a"], tree: ["tr"], smoothtree: ["tr"], sidebar: ["sb"], default: [] };
