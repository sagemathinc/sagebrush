// The address of a workspace entry's own page, as the File menu and the file browser open it: a notebook on the
// notebook page (/?nb=<ref>), a board on the board page (/board/?doc=local:<ref>), a .tex file in the LaTeX editor
// (/?tex=<fid>), a code or text file on its page (/?code=<fid>, web/code/url.ts).  Null for an entry with no page of its
// own (a folder, a data file), and for one without the id its page needs.
import { codeUrl } from "../code/url";
import { langOf } from "../code/langs";

// (the fields it reads, not api.ts's Entry: the agent pairing (agent-pair.ts) uses it without the workspace's module)
export function entryUrl(e: { kind: string; path: string; ref?: string | null; fid?: string | null }): string | null {
  if (e.kind === "notebook") return e.ref ? "/?nb=" + encodeURIComponent(e.ref) : null;
  if (e.kind === "board") return e.ref ? "/board/?doc=local:" + encodeURIComponent(e.ref) : null;
  if (e.kind !== "file" || !e.fid) return null;
  if (/\.tex$/i.test(e.path)) return "/?tex=" + e.fid;
  return langOf(e.path) ? codeUrl(e.fid) : null;
}
