// The page's book capability (plan-myst-notebooks-p2 r2 §2, §11.1, §11.6): what the MyST asset (web/myst/book.ts) is
// given to read a book's _toc.yml and chapters, and to open another chapter, for a MyST notebook copy whose folder is
// a jupyter-book.  Read-only but for one confirmed copy (convertCopy's, never overwriting); confined to the
// notebook's folder; bound to the workspace, the notebook (its ref and folder) and the page's document generation it
// was made for, all checked before each step and again after each wait, so a capability kept past a switch does
// nothing.  Every name passes, in order: the chapter-name rule (D2, with its reason code), the extension (once),
// normPath (D3), the folder's containment (D4), the entry's kind (D5); each refusal names which.
import type { Workspace, Entry } from "./api";
import { join, nameOf, parentOf } from "./paths";
import { resolveIn } from "./book-names";
import { isMystHead, HEAD_BYTES, TEXT } from "../notebook/myst-head.js";
import { convertCopy, findCopy, sha256Hex } from "./upload";

/** What the page tells the capability (index.html): its current document, and how to switch to another. */
export type BookHost = {
  /** the page's document now: its generation (raised at every open, close or switch), its workspace, its notebook */
  now(): { gen: number; ws: Workspace | null; ref: string | null };
  /** whether the current document is a MyST notebook copy (metadata.sagebrush.myst) */
  isMyst(): boolean;
  confirm(text: string): boolean;
  /** save the current notebook (before a switch) */
  save(): Promise<void>;
  /** open a workspace notebook by its ref (a switch: raises the generation) */
  openRef(ref: string): Promise<boolean>;
  /** a status line, after the switch */
  said(text: string): void;
  /** the MyST reader (web/notebook/myst.js fromMyst), for a copy made */
  myst(name: string, text: string, newId: () => string): any;
  maxBytes: number;
};

// (a test's hold on a step (test-myst.mjs: the stale-work rows hold one, switch documents, release it); unset in use)
const hold = (phase: string) => (globalThis as any).__sbBookHold?.(phase);

type Binding = { gen: number; ws: Workspace; ref: string; root: string; self: string };
type Pending = { gen: number; ref: string; target: { label?: string; cell?: string; back?: { name: string; cell: string; number: number } } };

/** The book access of a page: `mystBook()` (createNotebook's opts.mystBook) gives, for the document open now, a promise
 * of its capability, or of null: not a workspace notebook, not a MyST copy, or its folder has no _toc.yml (found by
 * the folder's listing: no file's contents read).  Discovery starts the first time the asset asks (only a MyST
 * notebook loads it), once per document. */
export function bookAccess(host: BookHost) {
  let pending: Pending | null = null;
  let current: { gen: number; myst: boolean; p: Promise<ReturnType<typeof makeCap> | null> } | null = null;
  const live = (b: Binding) => {
    const n = host.now();
    return n.gen === b.gen && n.ws === b.ws && n.ref === b.ref;
  };

  async function discover(gen: number, w: Workspace | null, ref: string | null) {
    if (!w || !ref || !host.isMyst()) return null;
    const path = await w.pathOf("notebook", ref).catch(() => undefined);
    const b0 = { gen, ws: w, ref, root: "", self: "" };
    if (!path || !live(b0)) return null;
    const root = parentOf(path);
    const listed = await w.list(root).catch(() => [] as Entry[]);
    if (!live(b0)) return null;
    if (!listed.some((e) => e.path === join(root, "_toc.yml") && e.kind === "file")) return null;
    return makeCap({ gen, ws: w, ref, root, self: nameOf(path) });
  }

  function makeCap(b: Binding) {
    // a name's entry, if the capability is live and the name passes every check: else the reason
    const entryOf = async (name: string, open: boolean): Promise<{ entry: Entry } | { refused: string }> => {
      if (!live(b)) return { refused: "stale" };
      const r = resolveIn(b.root, name, open);
      if ("refused" in r) return r;
      const e = await b.ws.stat(r.path).catch(() => undefined);
      if (!live(b)) return { refused: "stale" };
      if (!e) return { refused: "missing" };
      if (e.kind !== "file") return { refused: "kind" };
      return { entry: e };
    };
    return {
      book: b.root,
      self: b.self,
      live: () => live(b),
      async has(name: string): Promise<boolean> {
        const r = await entryOf(name, false);
        return "entry" in r;
      },
      async read(name: string, max: number): Promise<{ bytes?: Uint8Array; refused?: string }> {
        const r = await entryOf(name, false);
        if ("refused" in r) return r;
        try {
          const got = await b.ws.readUpTo(r.entry.path, max);
          if (!live(b)) return { refused: "stale" };
          return { bytes: got.content };
        } catch (err: any) { return { refused: err?.code === "limit" || /larger than/.test(String(err?.message)) ? "large" : "unreadable" }; }
      },
      async open(name: string, target: { label?: string; cell?: string; number?: number; title?: string; back?: { name: string; cell: string; number: number } }): Promise<"opened" | "cancelled" | { refused: string }> {
        const r = await entryOf(name, true);
        if ("refused" in r) return { refused: r.refused === "stale" ? "stale" : `"${name}" can't be opened from this book (${r.refused})` };
        const e = r.entry, file = nameOf(e.path);
        // (its bytes: is it MyST, and which copy of it is there)
        let content: Uint8Array;
        try { content = (await b.ws.readUpTo(e.path, host.maxBytes)).content; } catch { return { refused: `"${file}" couldn't be read` }; }
        if (!live(b)) return { refused: "stale" };
        if (!isMystHead(new TextDecoder(TEXT.encoding, TEXT).decode(content.subarray(0, HEAD_BYTES)))) return { refused: `${file} is not a Jupytext MyST notebook` };
        const found = await findCopy(b.ws, e.path, await sha256Hex(content));
        if (!live(b)) return { refused: "stale" };
        let ref = found.copy?.ref ?? null, said = "";
        if (!ref) {
          const base = file.replace(/\.md$/i, "");
          const what = target.number ? `chapter ${target.number}${target.title ? `, "${target.title}"` : ""} (${file}),` : target.title ? `"${target.title}" (${file}),` : `"${file}"`;
          if (!host.confirm(`Open ${what} as a notebook?\n\nA converted copy, "${base}.ipynb", is made beside it; "${file}" stays as it is.`)) return "cancelled";
          if (!live(b)) return { refused: "stale" };
          try { ref = (await convertCopy(b.ws, e, "notebook", { maxBytes: host.maxBytes, mode: "python", myst: host.myst, said: (m) => { said = m; } })).ref; }
          catch (err: any) { return { refused: `"${file}" couldn't be opened as a notebook: ${err?.message ?? err}` }; }
          if (!live(b)) return { refused: "stale" };
        }
        if (!ref) return { refused: `"${file}" couldn't be opened` };
        try { await host.save(); } catch { return { refused: "the notebook couldn't be saved, so this chapter isn't opened" }; }
        await hold("before-switch");
        if (!live(b)) return { refused: "stale" };
        // (what the opened chapter shows: for the document opened for it, once)
        pending = { gen: b.gen, ref, target: { label: target.label, cell: target.cell, back: target.back } };
        const ok = await host.openRef(ref);
        if (!ok) { pending = null; return { refused: `"${file}" couldn't be opened` }; }
        if (said) host.said(said);
        return "opened";
      },
      take() {
        const p = pending;
        // (only the document opened for it, right after: the next generation, that notebook)
        if (!p || !live(b) || p.ref !== b.ref || b.gen !== p.gen + 1) return null;
        pending = null;
        return p.target;
      },
    };
  }

  return {
    /** the current document's capability, as a promise (the same one until the document changes, or until whether it is
     * a MyST copy does: the page raises the generation before the new notebook's metadata is read, so an answer asked
     * meanwhile, from the last notebook's, is never kept for the new one (test-myst's C, "never came: the book
     * capability for /bad", #830 #921 #922 #984)) */
    mystBook() {
      const n = host.now(), myst = host.isMyst();
      if (current?.gen !== n.gen || current.myst !== myst) current = { gen: n.gen, myst, p: discover(n.gen, n.ws, n.ref) };
      return current.p;
    },
  };
}
