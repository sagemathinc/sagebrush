// Proposals (a PROTOTYPE for William, Nov 3 2026; not for merge): an agent proposes changes instead of making them,
// and the person sees each changed document before and after, in its own terms, then accepts or rejects it.
//
// A proposal is a folder in this browser's workspace, written by the agent with the workspace tools it already has
// (sagebrush-mcp 0.8.2: workspace_mkdir, workspace_create, workspace_write):
//   /Proposals/<name>/proposal.json   {"title", "description", "author"?, "status"?: "open", "changes": [...]}
//   /Proposals/<name>/<file>          a proposed file's new text
// each change being {"path": "/papers/a.tex", "file": "a.tex", "action"?: "edit" | "create" | "delete", "base"?: rev}.
// Accepting writes each file (refused if it changed since `base`; its old text stays in its history); a delete asks
// first (protected = you can't lose work). The proposal's status becomes "accepted" or "rejected".

import { Workspace } from "../workspace/api";
import { lineDiff } from "../latex/posmap";
import { texDiff } from "./texdiff";

declare const __SB_LATEX__: boolean | undefined;
const LATEX_URL = new URL("../sagebrush-latex.js", import.meta.url).href;
type Latex = { mountEditor?: (root: HTMLElement, o: { text: string; readOnly?: boolean; layout?: "split" | "preview" }) => { destroy(): void } };
const latexMod: Promise<Latex | null> = typeof __SB_LATEX__ !== "undefined" && __SB_LATEX__ ? import(/* @vite-ignore */ LATEX_URL).catch(() => null) : Promise.resolve(null);

type Change = { path: string; file?: string; action?: "edit" | "create" | "delete"; base?: number };
type Proposal = { folder: string; title: string; description: string; author: string; status: string; created: number; changes: Change[]; problem?: string };

const ROOT = "/Proposals";
const $ = <T extends HTMLElement = HTMLElement>(s: string) => document.querySelector(s) as T;
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...kids: (Node | string)[]) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };
const dec = new TextDecoder();
const asText = (c: unknown): string => (typeof c === "string" ? c : c instanceof Uint8Array ? dec.decode(c) : c instanceof ArrayBuffer ? dec.decode(new Uint8Array(c)) : JSON.stringify(c, null, 1));
const ago = (t: number) => { const s = Math.round((Date.now() - t) / 1000); return s < 60 ? "just now" : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : new Date(t).toLocaleDateString(); };

let ws: Workspace;
let selected = "";
let mounted: { destroy(): void }[] = [];
const said = new Map<string, string>();
// (a decided proposal's diffs compare the text it replaced, kept when it was accepted, with what it proposed)
const replaced = new Map<string, string | null>();

async function load(): Promise<Proposal[]> {
  const top = await ws.stat(ROOT).catch(() => undefined);
  if (!top) return [];
  const out: Proposal[] = [];
  for (const f of await ws.list(ROOT)) {
    if (f.kind !== "folder") continue;
    const p: Proposal = { folder: f.path, title: f.path.slice(ROOT.length + 1), description: "", author: "an agent", status: "open", created: f.created, changes: [] };
    try {
      const j = JSON.parse(asText((await ws.read(f.path + "/proposal.json")).content));
      p.title = String(j.title ?? p.title).slice(0, 200);
      p.description = String(j.description ?? "").slice(0, 20000);
      p.author = String(j.author ?? p.author).slice(0, 80);
      p.status = ["open", "accepted", "rejected"].includes(j.status) ? j.status : "open";
      p.changes = (Array.isArray(j.changes) ? j.changes : []).slice(0, 50).filter((c: any) => c && typeof c.path === "string" && c.path.startsWith("/"));
      if (!p.changes.length) p.problem = "no changes listed";
    } catch (e) { p.problem = "proposal.json: " + String((e as Error)?.message ?? e).slice(0, 200); }
    out.push(p);
  }
  return out.sort((a, b) => (a.status === "open" ? 0 : 1) - (b.status === "open" ? 0 : 1) || b.created - a.created);
}

async function current(path: string): Promise<{ text: string | null; rev: number | null }> {
  try { const r = await ws.read(path); return { text: asText(r.content), rev: r.rev }; } catch { return { text: null, rev: null }; }
}
async function proposed(p: Proposal, c: Change): Promise<string | null> {
  if (c.action === "delete") return null;
  const name = c.file ?? c.path.split("/").pop()!;
  return asText((await ws.read(p.folder + "/" + name)).content);
}

async function drawList() {
  const list = await load();
  const box = $("#list");
  box.replaceChildren();
  const open = list.filter((p) => p.status === "open").length;
  document.title = open ? `Proposals (${open}) · Sagebrush` : "Proposals · Sagebrush";
  if (!list.length) box.append(el("p", { className: "muted" }, "No proposals yet. Ask your agent to propose a change (see “For your agent”)."));
  for (const p of list) {
    const b = el("button", { className: "item" + (p.folder === selected ? " on" : "") + (p.status !== "open" ? " done" : "") },
      el("span", { className: "t" }, p.title),
      el("span", { className: "m" }, `${p.author} · ${p.changes.length} file${p.changes.length === 1 ? "" : "s"} · ${p.status === "open" ? ago(p.created) : p.status}`));
    b.onclick = () => { selected = p.folder; drawList(); drawOne(p); };
    box.append(b);
  }
  if (!selected && list[0]) { selected = list[0].folder; drawList(); drawOne(list[0]); }
}

/** A source diff with 3 lines of context around each hunk (the LaTeX editor's line diff, web/latex/posmap.ts). */
function diffView(a: string, b: string): HTMLElement {
  const box = el("div", { className: "diff" });
  const A = a.split("\n");
  const { changes, inserted } = lineDiff(a, b);
  const lineAt = (off: number) => a.slice(0, off).split("\n").length - 1;
  const row = (cls: string, sign: string, text: string) => box.append(el("div", { className: "dl " + cls }, el("span", { className: "s" }, sign), text || " "));
  const gap = (n: number) => { if (n > 0) box.append(el("div", { className: "dl gap" }, `⋯ ${n} unchanged line${n === 1 ? "" : "s"}`)); };
  let shownTo = 0;
  for (let i = 0; i < changes.length; i++) {
    const ch = changes[i];
    const from = lineAt(ch.from), to = ch.to > ch.from ? lineAt(ch.to - 1) + 1 : from;
    const ctx = Math.max(shownTo, from - 3);
    gap(ctx - shownTo);
    for (let k = ctx; k < from; k++) row("ctx", " ", A[k]);
    for (let k = from; k < to; k++) row("del", "−", A[k]);
    if (inserted[i]) for (const l of (inserted[i].endsWith("\n") ? inserted[i].slice(0, -1) : inserted[i]).split("\n")) row("add", "+", l);
    const next = i + 1 < changes.length ? lineAt(changes[i + 1].from) - 3 : Infinity;
    const end = Math.min(A.length, to + 3, Math.max(to, next));
    for (let k = to; k < end; k++) row("ctx", " ", A[k]);
    shownTo = end;
  }
  if (changes.length) gap(A.length - shownTo);
  else box.append(el("p", { className: "muted" }, "No differences."));
  return box;
}

async function rendered(host: HTMLElement, text: string | null, label: string) {
  if (label !== "Marked") host.append(el("div", { className: "cap" }, label));
  const frame = el("div", { className: "render" });
  host.append(frame);
  if (text === null) { frame.append(el("p", { className: "muted" }, label === "Before" ? "(a new file)" : "(deleted)")); return; }
  const m = await latexMod;
  if (!m?.mountEditor) { frame.append(el("pre", {}, text)); return; }
  mounted.push(m.mountEditor(frame, { text, readOnly: true, layout: "preview" }));
}

async function drawOne(p: Proposal) {
  for (const m of mounted) { try { m.destroy(); } catch {} }
  mounted = [];
  const box = $("#one");
  box.replaceChildren();
  box.append(el("div", { className: "head" },
    el("h2", {}, p.title),
    el("div", { className: "m" }, `Proposed by ${p.author} · ${new Date(p.created).toLocaleString()} · ${p.status}`)));
  if (p.description) box.append(el("div", { className: "desc" }, p.description));
  // (what the person's last decision did, kept across the redraw the change itself causes)
  if (said.get(p.folder)) box.append(el("p", { className: "done-note" }, said.get(p.folder)!));
  if (p.status !== "open") box.append(el("p", { className: "m" }, p.status === "accepted" ? "Accepted: below is what it changed, as it was proposed." : "Rejected: your files weren't changed."));
  if (p.problem) { box.append(el("p", { className: "bad" }, "This proposal can't be shown: " + p.problem)); return; }
  const say = el("div", { className: "say", role: "status" });
  if (p.status === "open") {
    const accept = el("button", { className: "primary", textContent: "Accept" });
    const reject = el("button", { textContent: "Reject" });
    accept.onclick = () => decide(p, true, say);
    reject.onclick = () => decide(p, false, say);
    box.append(el("div", { className: "actions" }, accept, reject, say));
  }
  for (const c of p.changes) {
    const sec = el("section", { className: "change" });
    box.append(sec);
    const cur = await current(c.path);
    const key = p.folder + "\n" + c.path;
    if (p.status === "accepted" && replaced.has(key)) cur.text = replaced.get(key)!;
    let next: string | null = null;
    try { next = await proposed(p, c); } catch (e) { sec.append(el("p", { className: "bad" }, `${c.path}: its proposed text is missing (${String((e as Error)?.message ?? e).slice(0, 120)})`)); continue; }
    const stale = p.status === "open" && c.base !== undefined && cur.rev !== null && cur.rev !== c.base;
    const what = c.action === "delete" ? "deleted" : cur.text === null ? "new file" : "changed";
    sec.append(el("h3", {}, c.path, el("span", { className: "tag" }, what), stale ? el("span", { className: "tag warn", title: "It was edited after this proposal was made: accepting is refused until the agent updates the proposal" }, "edited since") : ""));
    const tabs = el("div", { className: "tabs" });
    const body = el("div");
    sec.append(tabs, body);
    const isTex = /\.tex$/i.test(c.path);
    const show = async (which: "marked" | "rendered" | "source") => {
      for (const t of tabs.children) t.classList.toggle("on", (t as HTMLElement).dataset.v === which);
      body.replaceChildren();
      if (which === "source") { body.append(diffView(cur.text ?? "", next ?? "")); return; }
      if (which === "marked") {
        // (one rendered document, latexdiff-style: added in blue, removed struck through in red)
        const d = texDiff(cur.text ?? "", next ?? "");
        const one = el("div", { className: "marked" });
        body.append(el("div", { className: "m" }, `${d.added} word${d.added === 1 ? "" : "s"} added, ${d.removed} removed`, el("span", { className: "key" }, el("span", { className: "kadd" }, "added"), el("span", { className: "kdel" }, "removed"))), one);
        await rendered(one, d.source, "Marked");
        return;
      }
      const two = el("div", { className: "two" });
      const l = el("div"), r = el("div");
      two.append(l, r);
      body.append(two);
      await Promise.all([rendered(l, cur.text, "Before"), rendered(r, next, "After")]);
    };
    const both = isTex && cur.text !== null && next !== null;
    for (const [v, label] of (isTex ? [...(both ? [["marked", "Marked changes"]] : []), ["rendered", "Side by side"], ["source", "Source"]] : [["source", "Changes"]]) as [("marked" | "rendered" | "source"), string][]) {
      const t = el("button", { textContent: label });
      t.dataset.v = v;
      t.onclick = () => show(v);
      tabs.append(t);
    }
    await show(both ? "marked" : isTex ? "rendered" : "source");
  }
}

async function setStatus(p: Proposal, status: "accepted" | "rejected") {
  const r = await ws.read(p.folder + "/proposal.json");
  const j = JSON.parse(asText(r.content));
  j.status = status;
  j.decided = new Date().toISOString();
  await ws.write(p.folder + "/proposal.json", JSON.stringify(j, null, 2) + "\n", { base: r.rev });
}

async function decide(p: Proposal, accept: boolean, say: HTMLElement) {
  try {
    if (!accept) { said.set(p.folder, "Rejected. Nothing in your files changed."); await setStatus(p, "rejected"); return void drawList(); }
    // (every check first, then every write: one stale file refuses the whole proposal)
    const plan: { c: Change; next: string | null; rev: number | null }[] = [];
    for (const c of p.changes) {
      const cur = await current(c.path);
      if (c.base !== undefined && cur.rev !== null && cur.rev !== c.base) throw new Error(`${c.path} was edited after this proposal was made: ask the agent to update the proposal`);
      plan.push({ c, next: await proposed(p, c), rev: cur.rev });
      replaced.set(p.folder + "\n" + c.path, cur.text);
    }
    const deletes = plan.filter((x) => x.c.action === "delete" && x.rev !== null);
    if (deletes.length && !confirm(`This proposal deletes ${deletes.map((x) => x.c.path).join(", ")}. Move ${deletes.length === 1 ? "it" : "them"} to Trash?`)) { say.textContent = "Not accepted: nothing changed."; return; }
    for (const { c, next, rev } of plan) {
      if (c.action === "delete") { if (rev !== null) await ws.remove(c.path); continue; }
      if (rev === null) {
        const dir = c.path.slice(0, c.path.lastIndexOf("/"));
        if (dir && !(await ws.stat(dir).catch(() => undefined))) await ws.mkdir(dir);
        await ws.create(c.path, { content: next! });
      } else await ws.write(c.path, next!, { base: rev });
    }
    said.set(p.folder, `Accepted: ${plan.length} file${plan.length === 1 ? "" : "s"} updated. ${plan.length === 1 ? "Its old version is in its" : "Their old versions are in each file's"} history.`);
    await setStatus(p, "accepted");
    drawList();
  } catch (e) {
    say.textContent = "Not accepted: " + String((e as Error)?.message ?? e).slice(0, 300);
  }
}

const AGENT_HELP = `To propose a change instead of making it, write a proposal folder with your workspace tools:
1. workspace_mkdir /Proposals/<short-name>
2. For each file you change: workspace_create /Proposals/<short-name>/<file name> with its complete new text.
3. workspace_create /Proposals/<short-name>/proposal.json with
   {"title": "One line saying what this does",
    "description": "Why, and what the person should look at, in plain words.",
    "author": "<your name>",
    "changes": [{"path": "/the/real/file.tex", "file": "<file name>", "base": <its rev from workspace_read>}]}
   Use "action": "create" for a new file (no base), and "action": "delete" to propose deleting one.
Don't change the real files yourself. The person reviews proposals at /proposals/ and accepts or rejects each.
If the person edited a file after you proposed, read it again and rewrite the proposal with the new base.`;

async function main() {
  $("#agenthelp").textContent = AGENT_HELP;
  $("#copyhelp").onclick = async () => { try { await navigator.clipboard.writeText(AGENT_HELP); $("#copyhelp").textContent = "Copied"; } catch { $("#copyhelp").textContent = "Select the text and copy it"; } };
  try { ws = await Workspace.open(); }
  catch (e) { $("#list").textContent = "Your files can't be opened in this browser: " + String((e as Error)?.message ?? e).slice(0, 200); return; }
  let t: ReturnType<typeof setTimeout> | undefined;
  // (redrawn when anything under /Proposals changes: the agent writing a proposal, from the board page's pairing)
  ws.watch((ch: any) => {
    const paths: string[] = (ch?.ops ?? []).flatMap((o: any) => [o?.path, o?.from, o?.to]).filter((x: unknown): x is string => typeof x === "string");
    if (paths.length && !paths.some((p) => p === ROOT || p.startsWith(ROOT + "/"))) return;
    clearTimeout(t);
    t = setTimeout(async () => { await drawList(); const list = await load(); const p = list.find((x) => x.folder === selected); if (p) drawOne(p); }, 300);
  });
  await drawList();
}
main();
