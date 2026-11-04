// Git for a workspace (a PROTOTYPE for William, Nov 3 2026; branch git-proto, not for merge).
//
// One git repository per browser, in IndexedDB (isomorphic-git on lightning-fs, as web/gitpush does). Commits are
// made only when someone asks: the person commits `main` from their files; an agent commits its own branch from its
// worktree. TimeTravel stays the local insurance; git is what's shared.
//
//   main              the person's files: everything in the workspace except /Branches, /Trash, /Proposals
//   agent/<name>      an agent's branch; its worktree is the folder /Branches/<name>/ (a real folder, so the agent
//                     edits and runs things there with the workspace tools it already has)
//
// What goes into a commit is each document in a canonical text form, so diffs and merges work by line:
//   a notebook:  {cells: [{cell_type, source}], metadata}   outputs and counts are never committed
//   a board:     its JSON, pretty-printed
//   a file:      its bytes
//
// No worktree on disk is needed: blobs, trees and commits are written directly (writeBlob / writeTree / writeCommit).

import "../gitpush/buffer-global";
import git from "isomorphic-git";
import FS from "@isomorphic-git/lightning-fs";
import type { Workspace, Entry } from "../workspace/api";

export const BRANCHES = "/Branches";
export const SKIP = ["/Branches", "/Trash", "/Proposals"];
const fs = new FS("sagebrush-git");
const dir = "/repo";
const enc = new TextEncoder(), dec = new TextDecoder();

export type Files = Map<string, Uint8Array>; // relative path -> canonical bytes
export type Who = { name: string; email?: string };
/** One file's decision at the person's last review: accepted into main, or rejected, with the person's reason. */
export type FileDecision = { decision: "accepted" | "rejected"; reason?: string };
export type BranchState = { name: string; status: "open" | "review" | "accepted" | "partly-accepted" | "rejected"; base: string; title?: string; note?: string; files?: Record<string, FileDecision>; decided?: number; updated: number };

let ready: Promise<void> | undefined;
export function init(): Promise<void> {
  return (ready ??= (async () => {
    try { await fs.promises.stat(dir + "/.git"); } catch { await fs.promises.mkdir(dir).catch(() => {}); await git.init({ fs, dir, defaultBranch: "main" }); }
  })());
}

// ---- canonical forms -------------------------------------------------------------------------------------------

export function canonical(kind: Entry["kind"], content: unknown): Uint8Array {
  if (kind === "notebook") {
    const d: any = content ?? {};
    const cells = (Array.isArray(d.cells) ? d.cells : []).map((c: any) => ({ cell_type: c?.cell_type ?? "code", source: Array.isArray(c?.source) ? c.source.join("") : String(c?.source ?? "") }));
    const md: any = {};
    if (d.metadata?.kernelspec) md.kernelspec = d.metadata.kernelspec;
    if (d.metadata?.language_info?.name) md.language_info = { name: d.metadata.language_info.name };
    return enc.encode(JSON.stringify({ cells, metadata: md, nbformat: 4, nbformat_minor: 5 }, null, 1) + "\n");
  }
  if (kind === "board") {
    const d: any = { ...(content as any) };
    for (const k of ["rev", "j", "hash", "unjournaled", "stampOf", "baseRev", "updated"]) delete d[k];
    return enc.encode(JSON.stringify(d, null, 1) + "\n");
  }
  if (typeof content === "string") return enc.encode(content);
  if (content instanceof Uint8Array) return content;
  if (content instanceof ArrayBuffer) return new Uint8Array(content);
  return enc.encode(JSON.stringify(content));
}

export const kindOf = (path: string): Entry["kind"] => (/\.ipynb$/i.test(path) ? "notebook" : /\.board\.json$/i.test(path) ? "board" : "file");

/** A canonical file as the workspace takes it back (a notebook's or board's document, or bytes/text). */
export function document(path: string, bytes: Uint8Array): unknown {
  const k = kindOf(path);
  if (k === "notebook" || k === "board") return JSON.parse(dec.decode(bytes));
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return bytes; }
}
export const text = (b: Uint8Array | undefined) => (b === undefined ? null : dec.decode(b));

// ---- the workspace side ------------------------------------------------------------------------------------------

const skipped = (p: string) => SKIP.some((s) => p === s || p.startsWith(s + "/"));

/** Every document under `root` (relative paths), in canonical form. For `/`, the skipped folders are left out. */
export async function snapshot(ws: Workspace, root: string): Promise<Files> {
  const out: Files = new Map();
  const base = root === "/" ? "" : root.replace(/\/$/, "");
  for (const e of await ws.list(root, { recursive: true })) {
    if (e.kind === "folder" || (root === "/" && skipped(e.path))) continue;
    const rel = e.path.slice(base.length + 1);
    if (!rel || rel.split("/").some((s) => s.startsWith("."))) continue;
    const r = await ws.read(e.path);
    out.set(rel, canonical(e.kind, r.content));
  }
  return out;
}

async function ensureDir(ws: Workspace, p: string) {
  const parts = p.split("/").filter(Boolean);
  let at = "";
  for (const s of parts) { at += "/" + s; if (!(await ws.stat(at).catch(() => undefined))) await ws.mkdir(at); }
}

/** Put one canonical file at `path` in the workspace (created, or written over its current revision). */
export async function put(ws: Workspace, path: string, bytes: Uint8Array) {
  const doc = document(path, bytes);
  const cur = await ws.stat(path).catch(() => undefined);
  if (!cur) { await ensureDir(ws, path.slice(0, path.lastIndexOf("/"))); await ws.create(path, { content: doc }); return; }
  const r = await ws.read(path);
  await ws.write(path, doc, { base: r.rev });
}

// ---- the git side ---------------------------------------------------------------------------------------------------

type Node = { [name: string]: Node | string }; // a folder, or a blob's oid
async function writeTree(node: Node): Promise<string> {
  const entries = [];
  for (const [path, v] of Object.entries(node).sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (typeof v === "string") entries.push({ mode: "100644", path, oid: v, type: "blob" as const });
    else entries.push({ mode: "040000", path, oid: await writeTree(v), type: "tree" as const });
  }
  return git.writeTree({ fs, dir, tree: entries });
}

export async function head(ref: string): Promise<string | null> {
  await init();
  try { return await git.resolveRef({ fs, dir, ref: "refs/heads/" + ref }); } catch { return null; }
}

/** A commit of `files` on branch `ref` (its parent the branch's head, or `parent` for a new branch); null if nothing changed. */
export async function commit(ref: string, files: Files, message: string, who: Who, parent?: string | null): Promise<string | null> {
  await init();
  const root: Node = {};
  for (const [p, b] of files) {
    const parts = p.split("/");
    let n = root;
    for (const s of parts.slice(0, -1)) n = (n[s] ??= {}) as Node;
    n[parts[parts.length - 1]] = await git.writeBlob({ fs, dir, blob: b });
  }
  const tree = await writeTree(root);
  const prev = parent !== undefined ? parent : await head(ref);
  if (prev) { const c = await git.readCommit({ fs, dir, oid: prev }); if (c.commit.tree === tree && parent === undefined) return null; }
  const now = Math.floor(Date.now() / 1000), tz = new Date().getTimezoneOffset();
  const author = { name: who.name, email: who.email ?? "", timestamp: now, timezoneOffset: tz };
  const oid = await git.writeCommit({ fs, dir, commit: { message: message.trim() + "\n", tree, parent: prev ? [prev] : [], author, committer: author } });
  await git.writeRef({ fs, dir, ref: "refs/heads/" + ref, value: oid, force: true });
  return oid;
}

/** The files of a commit. */
export async function filesAt(oid: string | null): Promise<Files> {
  const out: Files = new Map();
  if (!oid) return out;
  await init();
  const walk = async (tree: string, pre: string) => {
    const t = await git.readTree({ fs, dir, oid: tree });
    for (const e of t.tree) {
      if (e.type === "tree") await walk(e.oid, pre + e.path + "/");
      else out.set(pre + e.path, (await git.readBlob({ fs, dir, oid: e.oid })).blob);
    }
  };
  const c = await git.readCommit({ fs, dir, oid });
  await walk(c.commit.tree, "");
  return out;
}

export async function log(ref: string, depth = 50) {
  await init();
  try { return await git.log({ fs, dir, ref: "refs/heads/" + ref, depth }); } catch { return []; }
}

export async function branches(): Promise<string[]> {
  await init();
  return (await git.listBranches({ fs, dir })).sort();
}

export async function deleteBranch(ref: string) { await init(); await git.deleteBranch({ fs, dir, ref }); }

// ---- review state (which branches await review, and what the person decided) ---------------------------------------

const STATE = "/state.json";
export async function states(): Promise<Record<string, BranchState>> {
  await init();
  try { return JSON.parse(dec.decode(await fs.promises.readFile(STATE) as Uint8Array)); } catch { return {}; }
}
export async function setState(name: string, s: Partial<BranchState>) {
  const all = await states();
  all[name] = { ...(all[name] ?? { name, status: "open", base: "", updated: 0 }), ...s, updated: Date.now() };
  await fs.promises.writeFile(STATE, enc.encode(JSON.stringify(all)));
  bc?.postMessage({ branch: name });
}
// (the review page and the paired page are different tabs: each hears the other's changes)
const bc = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("sagebrush-git") : undefined;
export function onChange(f: () => void) { bc?.addEventListener("message", f); }

// ---- diffs between two file sets -------------------------------------------------------------------------------------

export type Change = { path: string; kind: "added" | "deleted" | "changed"; before: Uint8Array | undefined; after: Uint8Array | undefined };
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);
export function diff(a: Files, b: Files): Change[] {
  const out: Change[] = [];
  for (const [p, x] of b) { const y = a.get(p); if (!y) out.push({ path: p, kind: "added", before: undefined, after: x }); else if (!same(x, y)) out.push({ path: p, kind: "changed", before: y, after: x }); }
  for (const [p, y] of a) if (!b.has(p)) out.push({ path: p, kind: "deleted", before: y, after: undefined });
  return out.sort((u, v) => (u.path < v.path ? -1 : 1));
}
export const eq = (a: Uint8Array | undefined, b: Uint8Array | undefined) => (a === undefined ? b === undefined : b !== undefined && same(a, b));
