// "Push project to GitHub" (Stage A MVP r1 §1, DEV only): the lazy chunk sagebrush-gitpush-panel.js, opened from the
// Storage panel when this browser has the flag (localStorage "sagebrush.gitpush" = the push proxy's address).
//   The folder's current files are read here (only read: nothing in the workspace is written), projected by
//   rules.ts (notebooks without outputs; .sagebrush and git-unsafe names never; data files over 50 MB listed), and
//   handed to the git worker (git-worker.ts), which holds the token, commits and pushes to sagebrush/<name>.
import type { Entry, Workspace } from "../workspace/api";
import type { BoardDoc } from "../board/doc";
import { Images } from "../board/images";
import { boardFileText, notebookFileText } from "../workspace/file-bytes";
import { AUTO_MS, MAX_FILE, branchFor, excluded, parseRepo, signature, stripOutputs } from "./rules";

export type GitpushHost = {
  say(m: string): void;
  fail(e: unknown): void;
  /** the git worker's address (sagebrush-gitpush-worker.js, beside this chunk) */
  workerUrl: string;
  /** the push proxy's address (the flag's value) */
  proxy: string;
  /** this tab's open documents saved, before their files are read */
  saveOpen?: () => Promise<void>;
  trash: string;
  isMissing(err: unknown): boolean;
};
export type Skip = { path: string; why: string };

const enc = new TextEncoder();
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...kids: (Node | string)[]) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };
const ago = (at: number) => { const m = Math.floor((Date.now() - at) / 60_000); return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.floor(m / 60)} h ago` : `${Math.floor(m / 1440)} days ago`; };

/** The git worker, one per page, answering requests by id. */
let worker: Worker | undefined;
let seq = 0;
const waiting = new Map<number, [(v: any) => void, (e: Error) => void]>();
export function call(url: string, op: string, args: unknown, transfer: Transferable[] = []): Promise<any> {
  if (!worker) {
    worker = new Worker(url, { type: "module", name: "sagebrush-gitpush" });
    worker.onmessage = (ev) => { const { id, ok, value, error } = ev.data; const w = waiting.get(id); if (!w) return; waiting.delete(id); ok ? w[0](value) : w[1](new Error(error)); };
  }
  const id = ++seq;
  return new Promise((resolve, reject) => { waiting.set(id, [resolve, reject]); worker!.postMessage({ id, op, args }, transfer); });
}

/** Every file under `folder` (outside Trash), in path order, page by page. */
async function* filesUnder(w: Workspace, folder: string, trash: string): AsyncGenerator<Entry> {
  const prefix = folder === "/" ? "/" : folder + "/";
  let after: string | null = null;
  for (;;) {
    const rows = await w.entriesPage(after, 100);
    if (!rows.length) return;
    after = rows[rows.length - 1].path;
    for (const e of rows) {
      if (e.kind === "folder" || !e.path.startsWith(prefix) || e.path === trash || e.path.startsWith(trash + "/")) continue;
      yield e;
    }
    if (rows.length < 100) return;
  }
}

/** One push of `folder`, one at a time across this browser's tabs (each tab has its own git worker, on the same local
 * repository): a person's push waits for one under way; the automatic push (`auto`) is skipped instead (busy). */
export async function pushFolder(w: Workspace, host: GitpushHost, o: { repo: string; folder: string; scope: string; auto?: boolean; onProgress?(n: number): void }): Promise<any> {
  const locks = (navigator as any).locks;
  if (!locks) return pushNow(w, host, o);
  return locks.request(`sagebrush-gitpush:${o.scope}`, { ifAvailable: !!o.auto }, (lock: unknown) => (lock ? pushNow(w, host, o) : { busy: true }));
}

/** Its files read and sent in batches, then the worker's commit and push. */
async function pushNow(w: Workspace, host: GitpushHost, o: { repo: string; folder: string; scope: string; auto?: boolean; onProgress?(n: number): void }) {
  const branch = branchFor(o.folder);
  // (a person's push saves the open documents first; the automatic one pushes what is saved)
  if (!o.auto) await host.saveOpen?.();
  const { sigs, run } = await call(host.workerUrl, "begin", { scope: o.scope, repo: o.repo, folder: o.folder, branch, proxy: host.proxy, author: { name: "Sagebrush", email: "noreply@sagebrush.space" } });
  const skipped: Skip[] = [];
  const prefix = o.folder === "/" ? "/" : o.folder + "/";
  let batch: { path: string; bytes: Uint8Array; sig?: string }[] = [], bytes = 0, keep: string[] = [], n = 0;
  const flush = async () => {
    if (keep.length) { await call(host.workerUrl, "keep", { run, paths: keep }); keep = []; }
    if (batch.length) { const b = batch; batch = []; bytes = 0; await call(host.workerUrl, "put", { run, files: b }, b.map((f) => f.bytes.buffer as ArrayBuffer)); }
  };
  // (the run let go if anything here fails: the worker refuses every other push until it ends or is let go)
  try {
    for await (const e of filesUnder(w, o.folder, host.trash)) {
      const rel = e.path.slice(prefix.length);
      const why = excluded(rel);
      if (why) { skipped.push({ path: e.path, why }); continue; }
      // (not here now, or too large now: what was pushed before stays)
      if (e.remote || e.missing) { skipped.push({ path: e.path, why: "not on this device yet" }); keep.push(rel); continue; }
      if (e.kind === "file" && (e.size ?? 0) > MAX_FILE) { skipped.push({ path: e.path, why: "larger than 50 MB" }); keep.push(rel); continue; }
      const sig = signature(e);
      if (sig && sigs[rel] === sig) { keep.push(rel); continue; }
      let content: any;
      try { content = (await w.read(e.path)).content; } catch (err) {
        if (!host.isMissing(err)) throw err;
        skipped.push({ path: e.path, why: "not on this device yet" }); keep.push(rel); continue;
      }
      let b: Uint8Array;
      if (e.kind === "notebook") b = enc.encode(notebookFileText(stripOutputs(content)));
      else if (e.kind === "board") { const images = new Images(); try { b = enc.encode(await boardFileText(content as BoardDoc, images)); } finally { images.dispose(); } }
      else if (content instanceof Uint8Array) b = content.slice();
      else if (content instanceof ArrayBuffer) b = new Uint8Array(content.slice(0));
      else if (ArrayBuffer.isView(content)) b = new Uint8Array(content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength));
      else { skipped.push({ path: e.path, why: "its bytes are in a form this can't push" }); keep.push(rel); continue; }
      if (b.length > MAX_FILE) { skipped.push({ path: e.path, why: "larger than 50 MB" }); keep.push(rel); continue; }
      batch.push({ path: rel, bytes: b, ...(sig ? { sig } : {}) });
      bytes += b.length;
      o.onProgress?.(++n);
      if (bytes >= 8 * 2 ** 20 || batch.length >= 200) await flush();
    }
    await flush();
  } catch (err) {
    await call(host.workerUrl, "abort", { run }).catch(() => {});
    throw err;
  }
  const done = await call(host.workerUrl, "end", { run });
  return { ...done, branch, skipped };
}

/** The automatic push (M3): this page's, at most one. `dirty` is set by every change the workspace tells this tab
 * (its own, other tabs', agents', and other devices' through sync); a push starts only when the folder was pushed by
 * hand once (its repository and folder are known) and the token is saved. A failure is kept, shown in the panel,
 * and tried again at the next turn. */
type Auto = { dirty: boolean; running: boolean; error?: string; at?: number };
let auto: Auto | undefined;
/** The open sections' redraws, told after each automatic push (a section may open before the automatic push starts). */
const autoListeners = new Set<() => void>();
const T = (): { autoMs?: number } => (globalThis as any).__SB_GITPUSH_TEST__ ?? {};

export function startAuto(w: Workspace, host: GitpushHost): void {
  if (auto) return;
  const a: Auto = (auto = { dirty: true, running: false });
  w.watch(() => { a.dirty = true; });
  const turn = async () => {
    try {
      if (!a.dirty || a.running) return;
      const scope = w.ws.name;
      const st = await call(host.workerUrl, "status", { scope });
      if (!st.repo || !st.folder || !st.hasToken) return;
      a.running = true;
      a.dirty = false;
      try {
        const r = await pushFolder(w, host, { repo: st.repo, folder: st.folder, scope, auto: true });
        if (r?.busy) a.dirty = true;
        else { a.error = undefined; a.at = Date.now(); }
      } catch (e: any) {
        a.dirty = true;
        a.error = e?.message ?? "The push failed.";
      } finally {
        a.running = false;
        for (const f of autoListeners) try { f(); } catch {}
      }
    } finally { setTimeout(turn, T().autoMs ?? AUTO_MS); }
  };
  void turn();
}

/** The section in the Storage panel. */
export async function openGitpush(w: Workspace, host: GitpushHost, box: HTMLElement): Promise<void> {
  const scope = w.ws.name;
  const st = await call(host.workerUrl, "status", { scope });
  const repo = el("input", { type: "url", placeholder: "https://github.com/you/repo", value: st.repo ?? "", size: 40 });
  const folder = el("input", { type: "text", value: st.folder ?? "/", size: 24 });
  const token = el("input", { type: "password", placeholder: "github_pat_…", autocomplete: "off", size: 30 });
  token.setAttribute("autocomplete", "off");
  token.spellcheck = false;
  const tokenLine = el("div");
  const status = el("p", { className: "note" });
  const skips = el("div");
  const go = el("button", { textContent: "Push now" });
  // (a push under way keeps Push now off, whatever the token line redraws meanwhile: M2-SEC-1)
  let pushing = false;
  const drawToken = async () => {
    const r = parseRepo(repo.value);
    const has = r ? (await call(host.workerUrl, "status", { scope, repo: r.url })).hasToken : false;
    tokenLine.replaceChildren();
    if (has) tokenLine.append("Token saved in this browser · ", el("button", { textContent: "Forget token", onclick: async () => { await call(host.workerUrl, "forgetToken", { scope, repo: r!.url }); host.say("Token forgotten"); void drawToken(); } }));
    else tokenLine.append(token, " ", el("button", { textContent: "Save token", onclick: async () => {
      const rr = parseRepo(repo.value);
      if (!rr) return host.say("Enter the repository's address first (https://github.com/owner/repo)");
      try { await call(host.workerUrl, "setToken", { scope, repo: rr.url, token: token.value.trim() }); token.value = ""; host.say("Token saved in this browser"); } catch (e: any) { host.say(e.message); }
      void drawToken();
    } }));
    go.disabled = !has || pushing;
  };
  repo.onchange = () => void drawToken();
  const autoLine = el("p", { className: "note" });
  const showLast = (last?: { at: number; commit: string; branch: string }) => {
    status.textContent = last ? `Pushed ${ago(last.at)} to ${last.branch} (${last.commit.slice(0, 7)})` : "Not pushed yet";
    autoLine.textContent = !last ? "After the first push, it pushes again by itself every 10 minutes when something changed, while Sagebrush is open in this browser."
      : auto?.error ? `The automatic push failed: ${auto.error} It tries again in 10 minutes.`
      : "Pushes by itself every 10 minutes when something changed, while Sagebrush is open in this browser.";
  };
  showLast(st.last);
  // (an automatic push meanwhile: the line redrawn while the section is shown)
  const redraw = async () => { if (!box.isConnected) { autoListeners.delete(redraw); return; } showLast((await call(host.workerUrl, "status", { scope })).last); };
  autoListeners.add(redraw);
  go.onclick = async () => {
    const r = parseRepo(repo.value);
    if (!r) return host.say("Enter the repository's address (https://github.com/owner/repo)");
    const f = folder.value.trim().replace(/\/+$/, "") || "/";
    if (pushing) return;
    pushing = true;
    go.disabled = true;
    status.textContent = "Pushing…";
    try {
      const res = await pushFolder(w, host, { repo: r.url, folder: f, scope, onProgress: (n) => { status.textContent = `Pushing… ${n} file${n === 1 ? "" : "s"} read`; } });
      if (res.nothing) status.textContent = "Nothing to push: the folder has no files";
      else showLast(res);
      skips.replaceChildren();
      if (res.skipped.length) {
        const d = el("details", {}, el("summary", { textContent: `Not pushed: ${res.skipped.length} file${res.skipped.length === 1 ? "" : "s"}` }));
        const ul = el("ul");
        for (const s of res.skipped.slice(0, 200)) ul.append(el("li", { textContent: `${s.path}: ${s.why}` }));
        if (res.skipped.length > 200) ul.append(el("li", { textContent: `and ${res.skipped.length - 200} more` }));
        d.append(ul);
        skips.append(d);
      }
    } catch (e: any) {
      status.textContent = e?.message ?? "The push failed.";
    } finally { pushing = false; void drawToken(); }
  };
  box.replaceChildren(
    el("p", {}, el("b", { textContent: "Push to GitHub" }), " (preview)"),
    el("div", {}, "Repository ", repo),
    el("div", {}, "Folder ", folder, el("span", { className: "note", textContent: " pushes to the branch sagebrush/<its name>; never main" })),
    tokenLine,
    el("p", { className: "note", textContent: "Use a fine-grained token for this one repository, with Contents: Read and write, expiring in 30 days or less. It stays in this browser: Sagebrush's servers never store it. Notebooks are pushed without their outputs." }),
    go, status, autoLine, skips,
  );
  await drawToken();
}
