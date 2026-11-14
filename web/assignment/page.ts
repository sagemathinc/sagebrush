// The notebook page's assignment mode (/#assignment=<key>), wired: runAssignment's steps (assignment.ts) given this
// page's workspace, its sync owner and the sync calls the page already has (passed in as `lib`, so this chunk carries
// none of them: one copy of the sync modules, the page's), sign-in's address, and the handout fetched from the course's
// tool.  A lazy chunk (sagebrush-assignment.js): only a page opened with #assignment= loads it.
import { runAssignment, type CopyFile, type Deps } from "./assignment";
import { loadLti } from "../share-client/lti";
import type { Handover } from "../share-client/handover";
import type { CopyResult, EnableResult, Workspace, SyncOwner } from "../workspace";

export interface PageLib {
  w: Workspace;
  owner: SyncOwner;
  ui: HTMLElement;
  key: string;
  /** the language a handout's .ipynb opens in when it names none */
  mode: string;
  shareStatus(): Promise<{ enabled: false } | { enabled: true; me: { email?: string; name?: string } | null }>;
  askStatus(f: typeof fetch, signal: AbortSignal): Promise<{ ok: true; status: { available: boolean; reason?: string } } | { ok: false; why: string; code?: number }>;
  signInUrl(back: string): string;
  syncOnHere(owner: SyncOwner): Promise<boolean>;
  enableSync(w: Workspace, owner: SyncOwner, o: { signal?: AbortSignal }): Promise<EnableResult>;
  localUsage(w: Workspace): Promise<{ files: { count: number; bytes: number } }>;
  startAssignmentCopy(owner: SyncOwner, w: Workspace, o: { copyId: string; revision: string; title: string; files: CopyFile[]; signal?: AbortSignal }): Promise<CopyResult>;
  fromFile(name: string, text: string, mode: string): unknown;
  /** opens the workspace's notebook at `path` (the file browser's open) */
  openPath(path: string): Promise<void>;
  /** the page's address without #assignment= */
  leave(): void;
}

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
// (the tool's own fetches: no cookies, no redirects, no referrer, as the share page loads them)
const TOOL: RequestInit = { credentials: "omit", redirect: "error", referrerPolicy: "no-referrer" };

/** The handout's files: the tool's list for this hand-over, of the same revision, and each file's bytes checked
 * against the list's SHA-256.  An .ipynb is its notebook document; anything else its bytes. */
export async function handoutFiles(h: Handover, o: { site: string; mode: string; fetch: typeof fetch; fromFile: PageLib["fromFile"]; signal?: AbortSignal }): Promise<CopyFile[]> {
  const got = await loadLti("#lti=" + encodeURIComponent(h.manifest), o.site, o.fetch);
  if (typeof got === "string") throw new Error(got);
  // (another revision than the one the student pressed Start on, or another copy: not this hand-over's)
  if (got.version !== h.revision || got.handover?.copy !== h.copy) throw new Error("the assignment changed: open it again from your course");
  const out: CopyFile[] = [];
  for (const f of got.manifest.files) {
    const r = await o.fetch(got.fileUrl(f), { ...TOOL, signal: o.signal });
    const bytes = await r.arrayBuffer();
    if (!r.ok || bytes.byteLength !== f.size || hex(await crypto.subtle.digest("SHA-256", bytes)) !== f.sha256) throw new Error(`${f.path} could not be loaded`);
    const name = f.path.slice(f.path.lastIndexOf("/") + 1);
    if (/\.ipynb$/i.test(name)) out.push({ path: f.path, kind: "notebook", content: o.fromFile(name, new TextDecoder().decode(bytes), o.mode) });
    else out.push({ path: f.path, kind: "file", content: new Uint8Array(bytes) });
  }
  return out;
}

/** The tool told the copy was started: the hand-over's capability, nothing in the body (no account, no content). */
export async function tellStarted(h: Handover, f: typeof fetch): Promise<void> {
  const url = h.manifest.replace(/\/manifest$/, "/started");
  if (url === h.manifest) return;
  await f(url, { ...TOOL, method: "POST" });
}

export function startAssignment(lib: PageLib): Promise<string> {
  const f = globalThis.fetch.bind(globalThis);
  const d: Deps = {
    key: lib.key,
    ui: lib.ui,
    async status(signal) {
      const s = await lib.shareStatus();
      if (!s.enabled) throw new Error("no account service here");
      if (!s.me) return { signedIn: false };
      const a = await lib.askStatus(f, signal);
      if (a.ok === false) {
        if (a.why === "http" && a.code === 401) return { signedIn: false };
        throw new Error(a.why);
      }
      return { signedIn: true, account: s.me.email || s.me.name || "your account", available: !!a.status.available, reason: a.status.reason, on: await lib.syncOnHere(lib.owner) };
    },
    signInUrl: lib.signInUrl,
    navigate: (url) => location.assign(url),
    localUsage: () => lib.localUsage(lib.w),
    enableSync: (signal) => lib.enableSync(lib.w, lib.owner, { signal }),
    handout: (h, signal) => handoutFiles(h, { site: location.origin, mode: lib.mode, fetch: f, fromFile: lib.fromFile, signal }),
    startCopy: (a) => lib.startAssignmentCopy(lib.owner, lib.w, a),
    // (a copy arriving from another device: said; opened from the Files list once it is here.  sync-client's
    // onCopyReady opens it by itself when it lands)
    onCopyReady: () => () => {},
    openNotebook: lib.openPath,
    // (the tool is told only once the server has acknowledged the notebook and its data files: sync-client's
    // all-acknowledged barrier.  Until it is in, never told; a relaunch, which finds the copy, tells it then)
    settled: async () => false,
    started: (h) => tellStarted(h, f),
    left: lib.leave,
  };
  return runAssignment(d);
}
