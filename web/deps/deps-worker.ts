// The Share dialog's analysis worker (share-ux-plan r2 §3): fileDeps
// (file-deps.ts) off the page's thread, so that a long parse never blocks the
// dialog, and the page can stop it at any moment with terminate().  It asks
// the page for one .py file at a time ({need: path}) and is given its text
// ({file: {path, bytes}}, the buffer transferred, decoded here), so nothing is
// cloned; it reports each finding as it goes.  Built as its own chunk (web/build.ts), loaded only when Share opens.
import { fileDeps } from "./file-deps";

const waiting = new Map<string, { ok: (t: string) => void; no: (e: Error) => void }>();

self.onmessage = (ev: MessageEvent) => {
  const m = ev.data;
  if (m?.file) {
    const w = waiting.get(m.file.path);
    waiting.delete(m.file.path);
    if (m.file.bytes instanceof ArrayBuffer) w?.ok(new TextDecoder().decode(m.file.bytes));
    else w?.no(new Error("unreadable"));
    return;
  }
  if (m?.start) void run(m.start);
};

async function run(s: any) {
  const gen = s.gen;
  const post = (x: object) => (self as any).postMessage({ gen, ...x });
  try {
    const r = await fileDeps({
      cells: s.cells,
      files: new Map(s.files),
      cwd: s.cwd,
      importPath: s.importPath,
      builtinModules: new Set(s.builtinModules),
      externalModules: new Set(s.externalModules),
      packageModules: new Set(s.packageModules),
      readFile: (path) =>
        new Promise((ok, no) => {
          waiting.set(path, { ok, no });
          post({ need: path });
        }),
      onDep: (path, reason) => post({ dep: path, reason }),
      onUnfollowed: (u) => post({ unfollowed: u }),
      onProgress: (p) => post({ progress: p }),
      signal: new AbortController().signal, // (the page stops it with terminate())
    });
    post({ done: true, complete: r.complete });
  } catch {
    post({ done: true, complete: false, failed: true });
  }
}
