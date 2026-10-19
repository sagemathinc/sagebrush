// The portable bundle (.sbreplay, gzipped JSON) read back: the notebook, its
// TimeTravel history (the patches, with the execution journal) and the bytes
// of the files its sessions read.  index.html makes it (makeBundle); both
// pages read it (the notebook's openBundle, and Upload… on either page,
// design/workspace-files.md §3), so a .sbreplay becomes a notebook with its
// history wherever it is uploaded.
import { bytesHash, putBlob, idb } from "./stores.js";

export const BUNDLE = "sagebrush-notebook-history";
const dec64 = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

/** The bundle's contents, checked to be one: {notebook (without its id, rev or trust), history, blobs}. */
export async function readBundle(bytes) {
  const raw = new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());
  const b = JSON.parse(new TextDecoder().decode(raw));
  if (b?.format !== BUNDLE || !Array.isArray(b.history) || !b.notebook) throw new Error("not a Sagebrush notebook with history");
  // (never written here, whatever it says: notebook.js remotePictures)
  const { id: _i, rev: _r, updated: _u, here: _h, ...notebook } = b.notebook;
  return { notebook, history: b.history, blobs: b.blobs ?? {} };
}

/** Its history kept as notebook `id`'s (the cells keep their ids: the journal
 * refers to them), and the files' bytes, each checked against its hash. */
export async function keepBundle(b, id, { hdb, bdb }) {
  if (bdb) for (const [h, data64] of Object.entries(b.blobs)) {
    const data = dec64(data64);
    if ((await bytesHash(data)) === h || h.startsWith("c53:")) await putBlob(bdb, data);
  }
  if (hdb) await idb(hdb, "history", "readwrite", (st) => { let r = null; for (const env of b.history) if (env?.time) r = st.put({ nb: id, time: env.time, env }); return r; });
}
