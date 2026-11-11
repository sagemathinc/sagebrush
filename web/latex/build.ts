// An agent's build of a .tex (workspace.latex_build, chat plan PR 4b; packet r3 §8): the LaTeX engine worker driven
// directly, in a box off the screen, on the text, images and \input files of the run's snapshot: nothing is read
// here but the snapshot the run gives (`files`), and no editor is involved. In the agent tools' chunk
// (/sagebrush-latex-tools.js), out of the page module every .tex open fetches; the input and image rules and the
// page's styles it uses are the page module's own, handed to it (`deps`, page.ts buildDeps), never bundled again here
// (daybreak2's Q1 ruling: no raise of the LaTeX group's cap, no copy of shared code).
// daybreak3's Q4 (and its refinement):
//   - one worker of its own for the whole build, terminated exactly once, by end();
//   - one request at a time, each reply taken only for the request it answers (its rev) and only while the build goes;
//   - a phase is rounds on the same frozen text: each reply's \input and image names are looked up in the snapshot,
//     all of a round's new ones at once, and asked again, until a reply asks nothing new (its closure); only that reply
//     is the phase's result. Only included files that are read count against INPUT_BOUNDS; the rounds are bounded and
//     a phase that doesn't settle within them fails;
//   - the second phase (the code's results) sends the first's closure with the results: one request, unless the code
//     changed a file the closure holds (its admitted writes, `overlay`): those entries are dropped and the rounds run
//     again on the snapshot with the code's writes over it (daybreak3's N3), never on the live workspace.
// A name not in the snapshot is "not found" whether it is absent or unreadable to the agent (READ-2): the snapshot
// holds only what the agent may read, and nothing else is looked at.
import type { Known } from "./inputs";
import type * as Images from "./images";
import type * as Inputs from "./inputs";

/** What a build uses of the page module (page.ts buildDeps), in this order: its styles, and its image and input rules. */
export type BuildDeps = readonly [css: string, imageCandidates: typeof Images.imageCandidates, graphicsPathOf: typeof Images.graphicsPathOf, notFoundWhy: typeof Images.notFoundWhy,
  sniffImage: typeof Images.sniffImage, admitImageBytes: typeof Images.admitImageBytes, IMAGE_BOUNDS: typeof Images.IMAGE_BOUNDS, engineInputs: typeof Inputs.engineInputs, admitInput: typeof Inputs.admitInput];

export type BuildReply = { ok: boolean; error?: string; check: any };
/** The run's admitted writes, by view path: the bytes written, null for removed, or "over" (past the overlay's cap). */
export type Overlay = ReadonlyMap<string, Uint8Array | null | "over">;
const OVER = "changed by the run, and too large to show here";

/** A phase's rounds at most: past them it fails (each round before the last adds at least one name's state). */
// (each \input name has at most two candidates (images.ts texCandidates: name.tex, then name), each learned in a round
//  of its own, and a file read can name the next only in the round after: so a chain of the most files that may be
//  included, 64 (inputs.ts INPUT_BOUNDS.files, not imported: it would bundle inputs.ts here; test-run-verbs.mjs checks
//  the two agree), and the main file takes at most 2 rounds a level, plus one for images and the last that asks
//  nothing new (daybreak3's review))
export const BUILD_ROUNDS = 2 * (64 + 1) + 2;
const DOC = 1;

/** A build of `text`, the .tex at `docPath` (a view path) in `files` (the snapshot, by view path), in `root`. */
export function latexBuild(root: HTMLElement, o: { text: string; docPath: string; files: ReadonlyMap<string, Uint8Array> }, deps: BuildDeps, workerUrl = new URL("sagebrush-latex-worker.js", import.meta.url)) {
  const [, imageCandidates, graphicsPathOf, notFoundWhy, sniffImage, admitImageBytes, IMAGE_BOUNDS, engineInputs, admitInput] = deps;
  const box = document.createElement("div");
  box.className = "tex-page sb-build";
  box.style.cssText = "position:fixed;left:-30000px;top:0;width:900px";
  const preview = document.createElement("div");
  preview.className = "page tex-preview";
  box.appendChild(preview); root.appendChild(box);
  const worker = new Worker(workerUrl, { type: "module", name: "sagebrush-latex-build" });
  let rev = 0, requests = 0, ended = false;
  let waiting: ((r: any) => void) | null = null;
  const take = (r: any) => { const w = waiting; waiting = null; w?.(r); };
  worker.onmessage = (m) => { const r = m.data; if (!ended && waiting && r?.doc === DOC && r?.rev === rev) take(r); };
  worker.onerror = () => { if (!ended) take({ ok: false, error: "the engine stopped" }); };

  // ---- the closure: what the engine asked for, as found in the snapshot (frozen with it)
  const known = new Map<string, Known>(), images: Record<string, string | { why: string }> = {}, blobs = new Map<string, string>();
  // (each image name's candidate paths, as looked at: one the code changed drops it)
  const looked = new Map<string, string[]>();
  let overlay: Overlay = new Map();
  /** a path's bytes now: the code's write over the snapshot's (undefined: neither has it) */
  const bytesAt = (p: string): Uint8Array | "over" | undefined => { if (overlay.has(p)) { const v = overlay.get(p); return v === null ? undefined : v; } return o.files.get(p); };
  let inputBytes = 0, inputTexts = 0, imageBytes = 0, version = 0, inputsSent = -1;
  const sizes = new Map<string, number>(), inputSizes = new Map<string, number>();
  const dirs = graphicsPathOf(o.text);
  const notFound = (searched: string[], name: string) => notFoundWhy(o.docPath, searched, [], false, name);
  /** the round's names looked up: whether anything new is known */
  const give = (imageRefs: string[], inputRefs: string[]) => {
    let more = false;
    for (const p of engineInputs(o.docPath, known).wanted(inputRefs)) {
      if (known.has(p)) continue;
      const u = bytesAt(p);
      let k: Known = { absent: true };
      if (u === "over") k = { why: OVER };
      else if (u) { k = admitInput(u, inputBytes, inputTexts); if ("text" in k) { inputBytes += u.length; inputTexts++; inputSizes.set(p, u.length); } }
      known.set(p, k); more = true;
    }
    if (more) version++;
    for (const name of imageRefs) {
      if (Object.hasOwn(images, name)) continue;
      more = true;
      if (Object.keys(images).length >= IMAGE_BOUNDS.perDocument) { images[name] = { why: "too many images" }; continue; }
      const c = imageCandidates(name, o.docPath, dirs);
      if (!c.ok) { images[name] = { why: c.why }; continue; }
      looked.set(name, c.paths);
      const p = c.paths.find((x) => bytesAt(x) !== undefined);
      if (!p) { images[name] = { why: notFound(c.searched, name) }; continue; }
      const u = bytesAt(p)!;
      if (u === "over") { images[name] = { why: OVER }; continue; }
      const why = admitImageBytes(u.length, u.length, imageBytes);
      if (why) { images[name] = { why }; continue; }
      const sn = sniffImage(u);
      if (!sn.ok) { images[name] = { why: sn.why }; continue; }
      if (sn.pixels !== null && sn.pixels > IMAGE_BOUNDS.megapixels * 1e6) { images[name] = { why: "too large" }; continue; }
      imageBytes += u.length; sizes.set(name, u.length);
      const url = URL.createObjectURL(new Blob([u as BlobPart], { type: sn.mime }));
      blobs.set(name, url); images[name] = url;
    }
    return more;
  };

  // ---- one request, its reply laid out as the editor lays it out (editor.ts): one wrapper per group, a box per piece
  const install = (items: { g: number; h: string }[], ng: number) => {
    preview.textContent = "";
    const ws = Array.from({ length: Math.max(0, ng | 0) }, () => { const w = document.createElement("div"); w.className = "ch"; preview.appendChild(w); return w; });
    for (const it of items) { const w = ws[it.g]; if (!w) continue; const p = document.createElement("div"); p.className = "pc"; p.innerHTML = it.h; w.appendChild(p); }
  };
  const request = (sage?: { wrapper: string | null; saved: unknown[] }) => new Promise<any>((res) => {
    if (ended) return res({ ok: false, error: "ended" });
    rev++; requests++;
    const inputs = version !== inputsSent ? { docPath: o.docPath, known: [...known], version } : undefined;
    inputsSent = version;
    waiting = res;
    worker.postMessage({ doc: DOC, rev, text: o.text, images, ...(inputs ? { inputs } : {}), ...(sage?.saved.length ? { sage: { wrapper: sage.wrapper, saved: sage.saved } } : {}) });
  });
  const result = (r: any): BuildReply => {
    if (!r?.ok) return { ok: false, error: String(r?.error ?? "the preview failed").slice(0, 200), check: null };
    install(Array.isArray(r.items) ? r.items : [], r.groups);
    return { ok: true, check: r.check ?? null };
  };
  let closed = false;
  return {
    preview,
    /** the images as the engine was given them (the report's, check.ts) */
    images,
    /** the first phase: rounds until the engine asks nothing new of the snapshot */
    async first(): Promise<BuildReply> {
      if (closed) throw new Error("the first phase is done");
      closed = true;
      for (let round = 0; round < BUILD_ROUNDS; round++) {
        const r = await request();
        if (!r?.ok) return result(r);
        if (!give(Array.isArray(r.imageRefs) ? r.imageRefs : [], Array.isArray(r.inputRefs) ? r.inputRefs : [])) return result(r);
      }
      return { ok: false, error: "the document's \\input files and images didn't settle", check: null };
    },
    /** the second phase: the first's closure, with the code's results (run-core.mjs statesOf), and over the snapshot the
     *  code's admitted writes (`changes`): what they changed of the closure dropped, then rounds as in the first */
    async second(sage: { wrapper: string | null; saved: unknown[] }, changes: Overlay = new Map()): Promise<BuildReply> {
      overlay = changes;
      for (const p of changes.keys()) {
        const k = known.get(p);
        if (k === undefined) continue;
        // (the bytes it was charged, as read: its text may differ (CRLF read as LF; daybreak3's review))
        if ("text" in k) { inputBytes -= inputSizes.get(p) ?? 0; inputTexts--; inputSizes.delete(p); }
        known.delete(p); version++;
      }
      for (const [name, paths] of looked) {
        if (!paths.some((p) => changes.has(p))) continue;
        const u = blobs.get(name);
        if (u) { URL.revokeObjectURL(u); blobs.delete(name); imageBytes -= sizes.get(name) ?? 0; }
        delete images[name]; looked.delete(name);
      }
      for (let round = 0; round < BUILD_ROUNDS; round++) {
        const r = await request(sage);
        if (!r?.ok) return result(r);
        if (!give(Array.isArray(r.imageRefs) ? r.imageRefs : [], Array.isArray(r.inputRefs) ? r.inputRefs : [])) return result(r);
      }
      return { ok: false, error: "the document's \\input files and images didn't settle", check: null };
    },
    /** how many requests this build sent (the tests' count of rounds) */
    requests: () => requests,
    end() {
      if (ended) return;
      ended = true;
      worker.terminate();
      take({ ok: false, error: "ended" });
      for (const u of blobs.values()) URL.revokeObjectURL(u);
      box.remove();
    },
  };
}
