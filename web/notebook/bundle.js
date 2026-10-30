// The portable bundle (.sbreplay, gzipped JSON) read back: the notebook, its
// TimeTravel history (the patches, with the execution journal) and the bytes
// of the files its sessions read.  index.html makes it (makeBundle); both
// pages read it (the notebook's openBundle, and Upload… on either page,
// design/workspace-files.md §3), so a .sbreplay becomes a notebook with its
// history wherever it is uploaded.
import { bytesHash, putBlob, docIdProblem } from "./stores.js";
import { askMerge } from "../journal/rows.js";

export const BUNDLE = "sagebrush-notebook-history";
/** What a bundle may hold, checked before anything of it is kept (daybreak2's LIMIT-4B3-1): its
 * JSON unpacked, as it is unpacked (a small gzip can unpack to anything); its history's
 * envelopes; its files, how many, each, and all of them, decoded. */
export const BUNDLE_LIMITS = { unpacked: 256 * 2 ** 20, history: 200_000, blobs: 10_000, blobBytes: 200 * 2 ** 20, blobsBytes: 256 * 2 ** 20 };
const dec64 = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

// (unpacked as it comes, stopped as soon as it passes `max`: never all of it first)
async function unpack(bytes, max) {
  const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip")).getReader();
  const parts = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > max) {
      await reader.cancel().catch(() => {});
      throw new Error(`a notebook with history is at most ${max / 2 ** 20} MiB unpacked`);
    }
    parts.push(value);
  }
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

/** The bundle's contents, checked to be one, within BUNDLE_LIMITS: {notebook (without its id, rev or trust), history, blobs}. */
export async function readBundle(bytes, limits = BUNDLE_LIMITS) {
  const raw = await unpack(bytes, limits.unpacked);
  const b = JSON.parse(new TextDecoder().decode(raw));
  if (b?.format !== BUNDLE || !Array.isArray(b.history) || !b.notebook) throw new Error("not a Sagebrush notebook with history");
  if (b.history.length > limits.history) throw new Error(`a notebook with history has at most ${limits.history} changes in it`);
  const blobs = b.blobs ?? {};
  if (!blobs || typeof blobs !== "object" || Array.isArray(blobs)) throw new Error("not a Sagebrush notebook with history: its files aren't a map");
  let count = 0, total = 0;
  for (const h of Object.keys(blobs)) {
    const v = blobs[h];
    if (typeof v !== "string") throw new Error("not a Sagebrush notebook with history: a file isn't text");
    if (++count > limits.blobs) throw new Error(`a notebook with history has at most ${limits.blobs} files`);
    // (base64's decoded size, from its length: 3 bytes for 4 characters)
    const decoded = Math.floor((v.length * 3) / 4);
    if (decoded > limits.blobBytes) throw new Error(`a file in a notebook with history is at most ${limits.blobBytes / 2 ** 20} MiB`);
    if ((total += decoded) > limits.blobsBytes) throw new Error(`the files in a notebook with history are at most ${limits.blobsBytes / 2 ** 20} MiB in all`);
  }
  // (never written here, whatever it says: notebook.js remotePictures)
  const { id: _i, rev: _r, updated: _u, here: _h, ...notebook } = b.notebook;
  return { notebook, history: b.history, blobs };
}

/** Its history kept as notebook `id`'s (the cells keep their ids: the journal
 * refers to them), and the files' bytes, each checked against its hash. */
export async function keepBundle(b, id, { hdb, bdb }) {
  // (an id sync's reserved keys could take is refused before anything is kept: F1's admission)
  const why = docIdProblem(id);
  if (why) throw new TypeError(`bundle: ${why}`);
  if (bdb) for (const [h, data64] of Object.entries(b.blobs)) {
    const data = dec64(data64);
    if ((await bytesHash(data)) === h || h.startsWith("c53:")) await putBlob(bdb, data);
  }
  // (the history and, in the same transaction, the merge mode its synced history will ask for: legacy, the mode the
  // restored patches were written with, so its server document is made legacy and nothing restored is read another
  // way (plan-merge-align r3.2 §9); either both are kept or neither)
  if (hdb) await new Promise((ok, no) => {
    const tx = hdb.transaction("history", "readwrite"), st = tx.objectStore("history");
    let failed = null;
    for (const env of b.history) if (env?.time) st.put({ nb: id, time: env.time, env });
    askMerge(st, id, "legacy").catch((e) => { failed = e; try { tx.abort(); } catch {} });
    tx.oncomplete = () => ok();
    tx.onerror = tx.onabort = () => no(failed ?? tx.error ?? new Error("bundle: its history wasn't kept"));
  });
}
