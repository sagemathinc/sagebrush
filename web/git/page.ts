// The Git page (PROTOTYPE for William, Nov 3 2026; branch git-proto, not for merge): /git/
//   main         your files' changes since main's last commit, and Commit (only when you ask: explicit, as git)
//   agent/<n>    an agent's branch: what it changed since it branched, file by file in each file's own terms;
//                Accept (all or the files you tick) copies them into your files and commits main; Reject says no
// See web/git/repo.ts for the repository, web/git/agent.ts for the agent's verbs.

import { Workspace } from "../workspace/api";
import { lineDiff } from "../latex/posmap";
import { texDiff } from "../proposals/texdiff";
import * as R from "./repo";
import { mountAgentPairing, floatingButton } from "../workspace/agent-ui";

declare const __SB_LATEX__: boolean | undefined;
const LATEX_URL = new URL("../sagebrush-latex.js", import.meta.url).href;
type Latex = { mountEditor?: (root: HTMLElement, o: { text: string; readOnly?: boolean; layout?: "split" | "preview" }) => { destroy(): void } };
const latexMod: Promise<Latex | null> = typeof __SB_LATEX__ !== "undefined" && __SB_LATEX__ ? import(/* @vite-ignore */ LATEX_URL).catch(() => null) : Promise.resolve(null);

const $ = <T extends HTMLElement = HTMLElement>(s: string) => document.querySelector(s) as T;
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...kids: (Node | string)[]) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };
const ago = (t: number) => { const s = Math.round((Date.now() - t) / 1000); return s < 60 ? "just now" : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : new Date(t).toLocaleDateString(); };
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

let ws: Workspace;
let selected = "main";
let mounted: { destroy(): void }[] = [];
const said = new Map<string, string>();

// ---- views of one file's change, in its own terms ---------------------------------------------------------------

/** A notebook as lines a person reads: each cell a header and its source (outputs are never committed). */
function notebookText(b: Uint8Array | undefined): string {
  if (!b) return "";
  try {
    const d = JSON.parse(R.text(b)!);
    return (d.cells ?? []).map((c: any, i: number) => `── cell ${i + 1} (${c.cell_type}) ──\n${c.source}`).join("\n\n") + "\n";
  } catch { return R.text(b)!; }
}
/** A board as lines: each item by id, its kind and its text. */
function boardText(b: Uint8Array | undefined): string {
  if (!b) return "";
  try {
    const d = JSON.parse(R.text(b)!);
    const items: any[] = d.nodes ?? d.items ?? d.elements ?? [];
    if (!Array.isArray(items) || !items.length) return R.text(b)!;
    return items.map((n) => `${n.type ?? n.kind ?? "item"} ${n.id ?? ""}: ${String(n.text ?? n.label ?? n.content ?? n.str ?? "").replace(/\n/g, " ⏎ ")}`).sort().join("\n") + "\n";
  } catch { return R.text(b)!; }
}

function diffView(a: string, b: string): HTMLElement {
  const box = el("div", { className: "diff" });
  const A = a.split("\n");
  const { changes, inserted } = lineDiff(a, b);
  const lineAt = (off: number) => a.slice(0, off).split("\n").length - 1;
  const row = (cls: string, sign: string, text: string) => box.append(el("div", { className: "dl " + cls }, el("span", { className: "s" }, sign), text || " "));
  const gap = (n: number) => { if (n > 0) box.append(el("div", { className: "dl gap" }, `⋯ ${plural(n, "unchanged line")}`)); };
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

async function rendered(host: HTMLElement, text: string | null) {
  const frame = el("div", { className: "render" });
  host.append(frame);
  if (text === null) return void frame.append(el("p", { className: "muted" }, "(none)"));
  const m = await latexMod;
  if (!m?.mountEditor) return void frame.append(el("pre", {}, text));
  mounted.push(m.mountEditor(frame, { text, readOnly: true, layout: "preview" }));
}

function changeView(c: R.Change, note?: HTMLElement): HTMLElement {
  const sec = el("section", { className: "change" });
  const k = R.kindOf(c.path), isTex = /\.tex$/i.test(c.path);
  sec.append(el("h3", {}, "/" + c.path, el("span", { className: "tag" }, c.kind), k !== "file" ? el("span", { className: "tag" }, k) : ""), ...(note ? [note] : []));
  const body = el("div");
  if (k === "notebook") body.append(diffView(notebookText(c.before), notebookText(c.after)));
  else if (k === "board") body.append(diffView(boardText(c.before), boardText(c.after)));
  else if (isTex && c.before && c.after) {
    const tabs = el("div", { className: "tabs" });
    const show = async (v: string) => {
      for (const t of tabs.children) t.classList.toggle("on", (t as HTMLElement).dataset.v === v);
      body.replaceChildren();
      if (v === "source") return void body.append(diffView(R.text(c.before)!, R.text(c.after)!));
      const d = texDiff(R.text(c.before)!, R.text(c.after)!);
      body.append(el("div", { className: "m" }, `${plural(d.added, "word")} added, ${d.removed} removed`));
      await rendered(body, d.source);
    };
    for (const [v, label] of [["marked", "Marked changes"], ["source", "Source"]]) { const t = el("button", { textContent: label }); t.dataset.v = v; t.onclick = () => show(v); tabs.append(t); }
    sec.append(tabs);
    show("marked");
  } else body.append(diffView(R.text(c.before) ?? "", R.text(c.after) ?? ""));
  sec.append(body);
  return sec;
}

// ---- the list ---------------------------------------------------------------------------------------------------

async function drawList() {
  const box = $("#list");
  const states = await R.states();
  const mainHead = await R.head("main");
  box.replaceChildren();
  const item = (key: string, t: string, m: string, done = false) => {
    const b = el("button", { className: "item" + (key === selected ? " on" : "") + (done ? " done" : "") }, el("span", { className: "t" }, t), el("span", { className: "m" }, m));
    b.onclick = () => { selected = key; drawList(); drawOne(); };
    box.append(b);
  };
  item("main", "main", mainHead ? "your files" : "no commit yet");
  const list = Object.values(states).sort((a, b) => (a.status === "review" ? 0 : 1) - (b.status === "review" ? 0 : 1) || b.updated - a.updated);
  const waiting = list.filter((s) => s.status === "review").length;
  document.title = waiting ? `Git (${waiting}) · Sagebrush` : "Git · Sagebrush";
  for (const s of list) item(s.name, "agent/" + s.name, `${s.status === "review" ? "asks for review" : s.status} · ${ago(s.updated)}`, s.status === "accepted" || s.status === "rejected");
}

// ---- main: commit your files --------------------------------------------------------------------------------------

async function drawMain(box: HTMLElement) {
  const h = await R.head("main");
  const committed = await R.filesAt(h);
  const now = await R.snapshot(ws, "/");
  const changes = R.diff(committed, now);
  box.append(el("div", { className: "head" }, el("h2", {}, "main"), el("div", { className: "m" }, h ? `last commit ${h.slice(0, 8)}` : "no commit yet: commit your files so agents can branch from them")));
  if (said.get("main")) box.append(el("p", { className: "done-note" }, said.get("main")!));
  const msg = el("textarea", { placeholder: h ? "What changed, in a line or two" : "First commit", rows: 2 }) as HTMLTextAreaElement;
  const go = el("button", { className: "primary", textContent: changes.length ? `Commit ${plural(changes.length, "file")}` : "Nothing to commit", disabled: !changes.length });
  const say = el("span", { className: "say", role: "status" });
  go.onclick = async () => {
    const m = msg.value.trim() || (h ? "Update" : "First commit");
    try { const oid = await R.commit("main", now, m, { name: "you" }); said.set("main", oid ? `Committed ${oid.slice(0, 8)}: ${m}` : "Nothing changed."); drawList(); drawOne(); }
    catch (e) { say.textContent = "Not committed: " + String((e as Error)?.message ?? e).slice(0, 300); }
  };
  box.append(el("div", { className: "actions" }, msg, go, say));
  box.append(el("p", { className: "m" }, changes.length ? `Changed since the last commit (${plural(changes.length, "file")}). TimeTravel keeps every edit; a commit is what you share.` : "Your files are as last committed."));
  for (const c of changes) box.append(changeView(c));
  const log = await R.log("main", 20);
  if (log.length) {
    box.append(el("h3", { className: "sub" }, "History"));
    const ul = el("ul", { className: "log" });
    for (const e of log) ul.append(el("li", {}, el("code", {}, e.oid.slice(0, 8)), " ", e.commit.message.split("\n")[0], el("span", { className: "m" }, ` · ${e.commit.author.name} · ${ago(e.commit.author.timestamp * 1000)}`)));
    box.append(ul);
  }
}

// ---- an agent's branch: review, accept, reject --------------------------------------------------------------------

async function drawBranch(box: HTMLElement, name: string) {
  const s = (await R.states())[name];
  const ref = "agent/" + name, tree = `${R.BRANCHES}/${name}`;
  const headOid = await R.head(ref), mainHead = await R.head("main");
  const base = await R.filesAt(s.base), after = await R.filesAt(headOid), mainNow = await R.filesAt(mainHead);
  const changes = R.diff(base, after);
  const log = (await R.log(ref, 20)).filter((e) => e.oid !== s.base);
  box.append(el("div", { className: "head" }, el("h2", {}, ref), el("div", { className: "m" }, `${s.status === "review" ? "asks for your review" : s.status} · worktree ${tree} · ${plural(Math.max(0, log.length - 1), "commit")}`)));
  if (s.title) box.append(el("div", { className: "desc" }, s.title));
  if (said.get(name)) box.append(el("p", { className: "done-note" }, said.get(name)!));
  if (s.note) box.append(el("p", { className: "m" }, "Your note to the agent: " + s.note));
  const ticks = new Map<string, HTMLInputElement>();
  if (s.status === "open" || s.status === "review") {
    const note = el("input", { type: "text", placeholder: "A note for the agent (optional)" }) as HTMLInputElement;
    const acc = el("button", { className: "primary", textContent: "Accept" }), rej = el("button", { textContent: "Reject" });
    const say = el("span", { className: "say", role: "status" });
    acc.onclick = () => accept(name, changes, ticks, note.value, say);
    rej.onclick = async () => { await R.setState(name, { status: "rejected", note: note.value || undefined }); said.set(name, "Rejected. Your files weren't changed; the agent sees this in git_status."); drawList(); drawOne(); };
    box.append(el("div", { className: "actions" }, acc, rej, note, say));
    if (s.status === "open") box.append(el("p", { className: "m" }, "The agent hasn't asked for review yet: this is its work so far."));
  }
  if (mainHead && mainHead !== s.base) box.append(el("p", { className: "warn-note" }, "main has moved on since this branch began: files changed on both sides are marked; accepting one replaces your version (yours stays in its TimeTravel)."));
  if (!changes.length) box.append(el("p", { className: "muted" }, "No changes committed on this branch yet."));
  for (const c of changes) {
    const both = !R.eq(base.get(c.path), mainNow.get(c.path));
    const t = el("input", { type: "checkbox", checked: true, disabled: !(s.status === "open" || s.status === "review") }) as HTMLInputElement;
    ticks.set(c.path, t);
    const note = el("label", { className: "pick" }, t, " accept this file", both ? el("span", { className: "tag warn", title: "You changed it on main too" }, "also changed on main") : "");
    box.append(changeView(c, note));
  }
  if (log.length) {
    box.append(el("h3", { className: "sub" }, "Commits"));
    const ul = el("ul", { className: "log" });
    for (const e of log) ul.append(el("li", {}, el("code", {}, e.oid.slice(0, 8)), " ", e.commit.message.split("\n")[0], el("span", { className: "m" }, ` · ${e.commit.author.name} · ${ago(e.commit.author.timestamp * 1000)}`)));
    box.append(ul);
  }
}

async function accept(name: string, changes: R.Change[], ticks: Map<string, HTMLInputElement>, note: string, say: HTMLElement) {
  const tree = `${R.BRANCHES}/${name}`;
  const picked = changes.filter((c) => ticks.get(c.path)?.checked);
  if (!picked.length) return void (say.textContent = "Tick at least one file, or Reject.");
  const dels = picked.filter((c) => c.kind === "deleted");
  if (dels.length && !confirm(`This moves ${dels.map((c) => "/" + c.path).join(", ")} to Trash. Go on?`)) return;
  try {
    for (const c of picked) {
      const to = "/" + c.path;
      if (c.kind === "deleted") { if (await ws.stat(to).catch(() => undefined)) await ws.remove(to); continue; }
      // (the agent's live file, outputs and all, not the committed canonical form)
      const live = await ws.read(`${tree}/${c.path}`).catch(() => null);
      if (live) {
        const cur = await ws.stat(to).catch(() => undefined);
        if (!cur) { const d = to.slice(0, to.lastIndexOf("/")); if (d && !(await ws.stat(d).catch(() => undefined))) await ws.mkdir(d); await ws.create(to, { content: live.content }); }
        else { const r = await ws.read(to); await ws.write(to, live.content, { base: r.rev }); }
      } else await R.put(ws, to, c.after!);
    }
    const s = (await R.states())[name];
    const files = await R.snapshot(ws, "/");
    const oid = await R.commit("main", files, `Accept agent/${name}${s.title ? ": " + s.title : ""}${picked.length < changes.length ? ` (${picked.length} of ${changes.length} files)` : ""}`, { name: "you" });
    await R.setState(name, { status: "accepted", note: [picked.length < changes.length ? `accepted ${picked.length} of ${changes.length} files` : "", note].filter(Boolean).join("; ") || undefined });
    said.set(name, `Accepted ${plural(picked.length, "file")} into your files and committed main${oid ? " " + oid.slice(0, 8) : ""}. Their old versions are in TimeTravel.`);
    drawList(); drawOne();
  } catch (e) { say.textContent = "Not accepted: " + String((e as Error)?.message ?? e).slice(0, 300); }
}

async function drawOne() {
  for (const m of mounted) { try { m.destroy(); } catch {} }
  mounted = [];
  const box = $("#one");
  box.replaceChildren();
  try { if (selected === "main") await drawMain(box); else await drawBranch(box, selected); }
  catch (e) { box.append(el("p", { className: "bad" }, "Can't show this: " + String((e as Error)?.message ?? e).slice(0, 300))); }
}

const AGENT_HELP = `Work on your own git branch, then ask me to review it:
1. workspace_git_branch {name: "<short-name>"}: your branch agent/<short-name>, with its worktree folder /Branches/<short-name>/ holding main's committed files.
2. Edit, create and run things ONLY under /Branches/<short-name>/ (the same paths as in main, below that folder). Verify your work there.
3. workspace_git_commit {name, message, review: true} when it's verified. Commit as often as you like without review: true.
4. workspace_git_status {name} tells you whether I accepted or rejected it, and my note. If main moved on, say so and offer to redo it.
Never change my files outside /Branches yourself.`;

async function main() {
  $("#agenthelp").textContent = AGENT_HELP;
  $("#copyhelp").onclick = async () => { try { await navigator.clipboard.writeText(AGENT_HELP); $("#copyhelp").textContent = "Copied"; } catch { $("#copyhelp").textContent = "Select the text and copy it"; } };
  try { ws = await Workspace.open(); }
  catch (e) { $("#list").textContent = "Your files can't be opened in this browser: " + String((e as Error)?.message ?? e).slice(0, 200); return; }
  // (the agent follows the person here: a remembered pairing reconnects; the button pairs a new one)
  mountAgentPairing(ws as any, { button: floatingButton() });
  let t: ReturnType<typeof setTimeout> | undefined;
  const redraw = () => { clearTimeout(t); t = setTimeout(() => { drawList(); drawOne(); }, 400); };
  R.onChange(redraw);
  ws.watch(() => { if (selected === "main") redraw(); });
  // (PROTOTYPE test hook: the end-to-end check drives the same code an agent's verbs run)
  (window as any).__sbGit = { R, ws, redraw: async () => { await drawList(); await drawOne(); }, select: async (k: string) => { selected = k; await drawList(); await drawOne(); }, gitVerb: async (verb: string, p: unknown) => (await import(/* @vite-ignore */ new URL("/git/agent.js", location.origin).href)).gitVerb(verb, p, ws, "test-agent") };
  await drawList();
  await drawOne();
}
main();
