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
      const head = title && !/\bplain\b/.test(fopts) ? '<header class="slide-title">' + this.inline(title, ctx) + (sub ? '<div class="slide-subtitle">' + this.inline(sub, ctx) + "</div>" : "") + "</header>" : "";
      const va = /(^|,)\s*t\s*(,|$)/.test(fopts) ? " va-t" : /(^|,)\s*b\s*(,|$)/.test(fopts) ? " va-b" : "";
      const b = flow.open("section", ' class="slide' + va + '" data-frame="' + n + '" id="frame-' + n + '" style="' + slideStyle(this.clsOpt) + '"', head);
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
    }
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
}
