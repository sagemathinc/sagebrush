// Which files' bytes a portable bundle (.sbreplay, index.html makeBundle) carries: only the versions its sessions'
// code read.  A session is given every file in the browser as it starts (its "session" record lists them all, so that
// a resume has the same files: web/replay-page.js), and the page's changes while it runs are "file" records; but a
// bundle goes to someone else, so it carries a version's bytes only if a run of that session read that version's own
// bytes.  A run record's `reads` names the versions (web/shims/fs.ts origins): "s:<path>" for a file its session
// started with, else the token of the page's put, which the "file" record keeps as `tok`.  A version is followed
// through a rename and an append, and is no longer read once Python writes the file over or the page puts another
// version.  William's B-feedback, Nov 1 2026: a bundle of one small notebook had every file in the browser in it; and
// astra's R1 on #445: reads bound to paths, not versions, exported a version that was never read.  A journal from
// before `reads` were kept carries none, nor does a file record without a `tok`; resuming one of their runs that read
// a file says so ("the file ... is not in this browser", web/replay-page.js).

/** The hashes of the files whose bytes go in the bundle: of `sessions` ("session" records), `runs` ("run" records,
 *  foreign ones too: a resume reruns them) and `files` ("file" records), the versions a run of the same session read. */
export function bundleHashes(sessions, runs, files) {
  const read = new Map(); // session id -> the versions its runs read
  for (const r of runs) {
    if (!Array.isArray(r?.reads) || typeof r.sid !== "string") continue;
    let s = read.get(r.sid);
    if (!s) read.set(r.sid, (s = new Set()));
    for (const v of r.reads) if (typeof v === "string") s.add(v);
  }
  const out = new Set();
  for (const s of sessions) for (const [p, h] of s?.files ?? []) if (h && read.get(s.id)?.has("s:" + p)) out.add(h);
  for (const f of files) if (f?.hash && typeof f.tok === "string" && read.get(f.sid)?.has(f.tok)) out.add(f.hash);
  return out;
}
