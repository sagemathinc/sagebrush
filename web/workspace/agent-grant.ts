// What a paired agent may touch (design/workspace-agent-protocol.md §2.2, §3): the person's grant, kept by the
// page.  The server treats a grant as opaque (§2.3, 7), so these rules are the only guard on an agent's folders
// and write access, and every verb passes them before it reaches the workspace.
//
// - A path counts only as normPath makes it (paths.ts: no "." or "..", no empty names, no control characters,
//   within the bounds), and only if it is one of the granted folders or inside one (`within`: "/A" never covers
//   "/AB").  A path normPath refuses is refused.
// - Each verb's paths are all checked: rename's from and to, duplicate's path and to (or, without to, the folder
//   the copy goes in).  list is of a granted folder only.
// - Reading (list, stat, read, history, version) needs the grant; changing anything (write, create, mkdir,
//   rename, duplicate, remove, restore) needs it with write.
// - The granted folders themselves stay: an agent may change what's in them, never remove or move them.
// - Trash: an entry in Trash is reached only through "/" (everything), except restore, which is checked against
//   where the entry came from (its `trashed.from`): that folder, the one it goes back into (under another name if
//   that one is taken), must be granted, with write.
// - An expired grant, or one with no folders, allows nothing.

import { TRASH, normPath, parentOf, within } from "./paths";

export type Grant = {
  agent: string; // the agent's name, as it says
  client: string; // "claude-code", "codex", …, as it says
  folders: string[]; // normalized, "/" for everything
  write: boolean;
  run: false; // (running code comes later: board.run, notebook.run)
  expires: number | null; // ms since the epoch; null: until this page closes
  created: number;
  lastUsed: number;
};

const READ = new Set(["workspace.list", "workspace.stat", "workspace.read", "workspace.history", "workspace.version"]);
const CHANGE = new Set(["workspace.write", "workspace.create", "workspace.mkdir", "workspace.rename", "workspace.duplicate", "workspace.remove", "workspace.restore"]);

/** A path as normPath makes it, or null if it isn't one. */
export function norm(p: unknown): string | null {
  try { return normPath(p); } catch { return null; }
}

/** The folders as a grant keeps them: each normalized, Trash and anything in it refused, duplicates and folders
 * inside another granted folder dropped.  Throws on a folder that isn't a path or is in Trash. */
export function grantFolders(folders: unknown): string[] {
  if (!Array.isArray(folders) || folders.length === 0) throw new Error("a grant names at least one folder");
  const out: string[] = [];
  for (const f of folders) {
    const p = norm(f);
    if (p === null) throw new Error(`not a folder path: ${JSON.stringify(String(f)).slice(0, 80)}`);
    if (p !== "/" && within(p, TRASH)) throw new Error("Trash isn't granted on its own");
    out.push(p);
  }
  return out.filter((p, i) => !out.some((q, j) => (j !== i && q !== p && within(p, q)) || (j < i && q === p)));
}

/** Whether the grant allows anything at all now: why not, or null. */
export function grantProblem(g: Grant | null, now: number): string | null {
  if (!g) return "no grant: the person hasn't allowed this agent anything";
  if (!Array.isArray(g.folders) || g.folders.length === 0) return "the grant names no folders";
  if (g.expires !== null && !(now < g.expires)) return "the grant has expired";
  return null;
}

/** Whether `p` (as normPath makes it) is one of `folders` or inside one, and outside Trash unless "/" is granted. */
export function inGrant(p: string | null, folders: string[]): boolean {
  if (p === null) return false;
  if (within(p, TRASH) && !folders.includes("/")) return false;
  return folders.some((f) => within(p, f));
}

/** Whether `p` is itself one of the granted folders (which an agent may not remove or move). */
const isGrantRoot = (p: string | null, folders: string[]) => p !== null && folders.includes(p);

/** An entry in Trash, as the workspace's stat gives it: `trashed.from` is where it was removed from. */
export type TrashEntry = { trashed?: { from: string } } & Record<string, unknown>;

/** Why the call isn't allowed under `g` at `now`, or null.  `trashEntry(p)` gives the entry at `p` (restore's
 * check: where it came from), or null.  For restore, `out.expect` is set to that very entry: the restore must be
 * of it and no other (Workspace.restore's `expect`, checked holding its lock), so an entry put in its place in
 * the meantime is never restored on this authorization. */
export async function authorize(method: string, params: any, g: Grant | null, now: number, trashEntry: (p: string) => Promise<TrashEntry | null | undefined>, outArg: { expect?: TrashEntry } = {}): Promise<string | null> {
  const no = grantProblem(g, now);
  if (no) return no;
  const folders = g!.folders;
  const read = READ.has(method), change = CHANGE.has(method);
  if (!read && !change) return `not a verb an agent may call: ${method}`;
  if (change && !g!.write) return "the grant is read only";
  const out = (p: unknown) => `outside the folders this agent may ${change ? "change" : "read"}: ${JSON.stringify(String(p)).slice(0, 120)}`;
  switch (method) {
    case "workspace.list": {
      const f = norm(params.folder);
      return inGrant(f, folders) ? null : out(params.folder);
    }
    case "workspace.rename": {
      const from = norm(params.from), to = norm(params.to);
      if (!inGrant(from, folders)) return out(params.from);
      if (!inGrant(to, folders)) return out(params.to);
      if (isGrantRoot(from, folders)) return "a granted folder itself can't be moved by the agent";
      return null;
    }
    case "workspace.duplicate": {
      const p = norm(params.path);
      if (!inGrant(p, folders)) return out(params.path);
      if (params.to !== undefined) return inGrant(norm(params.to), folders) ? null : out(params.to);
      // (without to, the copy goes beside it: in its folder)
      return inGrant(parentOf(p!), folders) ? null : out(params.path);
    }
    case "workspace.remove": {
      const p = norm(params.path);
      if (!inGrant(p, folders)) return out(params.path);
      return isGrantRoot(p, folders) ? "a granted folder itself can't be removed by the agent" : null;
    }
    case "workspace.restore": {
      const p = norm(params.path);
      if (p === null || !within(p, TRASH) || p === TRASH) return "restore takes an entry in Trash";
      const e = await trashEntry(p);
      const from = norm(e?.trashed?.from);
      if (!e || from === null) return "no such entry in Trash";
      if (!inGrant(from, folders)) return out(from);
      // (it goes back into the folder it came from, under another name if that one is taken (Workspace.restore):
      // so that folder must be in the grant, whatever name it ends up with, now or by the time it runs)
      if (!inGrant(parentOf(from), folders)) return `restoring ${JSON.stringify(from)} would put it in ${JSON.stringify(parentOf(from))}, outside the folders this agent may change`;
      outArg.expect = e;
      return null;
    }
    default: {
      // stat, read, history, version, write, create, mkdir: one path
      const p = norm(params.path);
      return inGrant(p, folders) ? null : out(params.path);
    }
  }
}
