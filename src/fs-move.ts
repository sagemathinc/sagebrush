// A file moved to a new name in its folder, never over another file and never losing one (`sagebrush notebook`'s
// api/rename, src/notebook.ts; astra's LOCAL-RENAME-3 on #531):
//   1. the file at `from` is renamed to a hidden staging name beside it: whatever is at `from` at that instant, moved
//      atomically (an editor's atomic save of `from` after it makes a new `from`, which is left alone);
//   2. the staged file is linked at `to`: a link never replaces a name that exists (EEXIST), even one made meanwhile;
//   3. the staging name is removed (`to` holds the file).
// If step 2 fails, the staged file is linked back at `from` (again never over a file there now) and the staging name
// removed; if `from` was made again meanwhile, the staged file is left at its staging name, and said.
import { renameSync, linkSync, unlinkSync, lstatSync } from "fs";
import { basename, dirname, join } from "path";
import { randomBytes } from "crypto";

export class MoveError extends Error {
  constructor(public code: "exists" | "missing" | "kept" | "failed", message: string) { super(message); }
}

/** `from` moved to `to` (the same folder), never over a file at `to`. `between` is a test's way in between the steps. */
export function moveNoReplace(from: string, to: string, between?: (step: "staged" | "linked") => void): void {
  if (dirname(from) !== dirname(to)) throw new MoveError("failed", "only within its folder");
  const stage = join(dirname(from), `.${basename(from)}.sagebrush-rename-${randomBytes(6).toString("hex")}`);
  try { renameSync(from, stage); } catch (e: any) { throw e?.code === "ENOENT" ? new MoveError("missing", "it isn't there") : new MoveError("failed", String(e?.message ?? e)); }
  between?.("staged");
  try {
    linkSync(stage, to);
  } catch (e: any) {
    // (put back where it was, never over a file there now)
    try { linkSync(stage, from); unlinkSync(stage); } catch { throw new MoveError("kept", `${basename(to)} wasn't free, and ${basename(from)} was made again meanwhile: the file is kept as ${basename(stage)}`); }
    throw e?.code === "EEXIST" ? new MoveError("exists", "a file of that name is there") : new MoveError("failed", String(e?.message ?? e));
  }
  between?.("linked");
  unlinkSync(stage);
}

/** Whether `p` is a symbolic link (lstat: not followed). */
export const isLink = (p: string) => { try { return lstatSync(p).isSymbolicLink(); } catch { return false; } };
