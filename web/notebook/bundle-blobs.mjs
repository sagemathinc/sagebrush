// Which files' bytes a portable bundle (.sbreplay, index.html makeBundle) carries: only those its sessions' code
// read.  A session is given every file in the browser as it starts (its "session" record lists them all, so that a
// resume has the same files: web/replay-page.js), and the page's changes while it runs are "file" records; but a
// bundle goes to someone else, so it carries a file's bytes only if a run of that session read that file's own bytes
// (the run record's `reads`: the page's paths of those files, web/shims/fs.ts origins, kept through a rename and an
// append, not after Python writes the file over).  William's B-feedback, Nov 1 2026: a bundle of one small notebook
// had every file in the browser in it.  A journal from before `reads` were kept carries none: resuming one of its runs
// that read a file says so ("the file ... is not in this browser", web/replay-page.js).

const norm = (p) => "/" + String(p).replace(/^\/+/, "");

/** The hashes of the files whose bytes go in the bundle: of `sessions` ("session" records), `runs` ("run" records,
 *  foreign ones too: a resume reruns them) and `files` ("file" records), those a run of the same session read. */
export function bundleHashes(sessions, runs, files) {
  const read = new Map(); // session id -> the paths its runs read
  for (const r of runs) {
    if (!Array.isArray(r?.reads) || typeof r.sid !== "string") continue;
    let s = read.get(r.sid);
    if (!s) read.set(r.sid, (s = new Set()));
    for (const p of r.reads) if (typeof p === "string") s.add(norm(p));
  }
  const out = new Set();
  for (const s of sessions) for (const [p, h] of s?.files ?? []) if (h && read.get(s.id)?.has(norm(p))) out.add(h);
  for (const f of files) if (f?.hash && read.get(f.sid)?.has(norm(f.path))) out.add(f.hash);
  return out;
}
