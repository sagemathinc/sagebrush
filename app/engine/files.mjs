// The engine's own files (app/engine/thread.mjs): a URL an interpreter asks
// for (its modules, the library's chunks, the packages) as a file under the
// engine's root folder, its links followed; anything else is refused: another
// scheme, a path outside the root (by .. or by a link), a file not there.
import { realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { sep } from "node:path";

/** The root's real path, and the URL relative requests resolve against (its worker's). */
export function engineRoot(dir) {
  const root = realpathSync(dir);
  return { root, base: pathToFileURL(root + sep + "sagebrush-worker.js").href };
}

/** The file `u` names under `root` (resolved against `base`), or an error. */
export function localFile({ root, base }, u) {
  const url = new URL(String(u), base);
  if (url.protocol !== "file:") throw new Error(`the engine reads only its own files, not ${url.protocol} URLs`);
  url.search = "";
  url.hash = "";
  let p;
  try {
    p = realpathSync(fileURLToPath(url));
  } catch {
    throw new Error(`no such file in the engine: ${url.pathname.split("/").pop()}`);
  }
  if (!p.startsWith(root + sep)) throw new Error("the engine reads only its own files");
  return p;
}
