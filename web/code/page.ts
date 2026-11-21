// The code page (1a; William, Nov 5: "users can easily browse these .py (etc) files"): /?code=<fid> on the notebook
// page, a lazy chunk (dist/sagebrush-code.js) that web/code/boot.ts mounts. A .py, .sage, .m, .mag, .js, .json or .txt
// file (tokens.ts CODE_LANGS) shown highlighted, with line numbers, read-only (View); ✎ Edit makes it a textarea with
// the highlighting behind it, saved as you type (as the LaTeX editor, #551: no Save button, no leave prompt).
//  - View or Edit as every document (web/doc-mode.ts, William's Nov 4 rule): View, unless the person last left this
//    file in Edit here.
//  - Saving writes only over the revision the text was read or saved as (ws.write's fid and base): a change made
//    elsewhere is never written over. With no unsaved edits here the page follows it; with them, saving stops and the
//    bar says so, offering Reload (theirs) or Save mine as a copy. Each save keeps the old bytes as a version (the
//    workspace's write), so nothing is lost.
//  - The text is only ever set as text (tokens.ts drawTokens, textarea.value): no file's bytes reach innerHTML (astra).
//  - Opened up to CODE.openBytes; editable up to CODE.editBytes, if it can be written back exactly (latex/save.ts);
//    highlighted live while editing up to CODE.liveBytes, in View up to CODE.viewBytes, plain above.
import type { Workspace, Entry } from "../workspace/api";
import type { renderFileMenu } from "../workspace/filemenu";
import { modeKey, modeOf, rememberMode, EDIT_TITLE, EDITING_TITLE } from "../doc-mode";
import { openBytes, encodeText } from "../latex/save";
import { freePath, nameOf, parentOf, safeName, splitExt } from "../workspace/paths";
import { tokensOf, drawTokens } from "./tokens";
import { langOf, type Lang } from "./langs";
import { EDIT_BYTES, editableOf } from "./edit";
import { codeUrl } from "./url";

export const CODE = { openBytes: 4 * 2 ** 20, editBytes: EDIT_BYTES, viewBytes: 2 ** 20, liveBytes: 256 * 1024, saveMs: 600 };
/** What the notebook page gives the code page: its workspace and the file's id; how to open what is chosen here; and
 * its own Open… dialog, examples and File menu (in the page's script already, so this chunk carries none of them). */
export type Host = {
  ws: Workspace; fid: string;
  open(e: Entry, how: "here" | "tab"): void;
  openFiles(): void;
  examples(): Promise<boolean>;
  renderFileMenu: typeof renderFileMenu;
  /** File ▸ Connect an agent…: the hosting page's pairing (null where it isn't offered: the app, the CLI's page) */
  agent?: ((back: HTMLElement) => Promise<unknown>) | null;
  /** To another page, every way out of this one: true once it navigates; false if the host refused, saying why (the
   * desktop app: until what was saved here is on disk, src: index.html leaveTo), and the page stays */
  navigate(to: string): Promise<boolean>;
};
const LANG_LABEL: Record<Lang, string> = { python: "Python", sage: "Sage", matlab: "MATLAB", magma: "Magma", js: "JavaScript", json: "JSON", text: "Text" };

const CSS = `
.code-page { position: fixed; inset: 0; display: flex; flex-direction: column; background: #fff; color: #222; font: 14px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; z-index: 10; }
body.wsfiles .code-page { left: 272px; }
@media (max-width: 640px) { body.wsfiles .code-page { left: 0; } }
.code-page .code-head { display: flex; align-items: center; gap: 8px; padding: 6px 10px; border-bottom: 1px solid #ddd; background: #f6f7f8; flex-wrap: wrap; }
.code-page .code-home { display: none; color: #4a6b49; font-size: 20px; font-weight: 700; letter-spacing: -0.01em; text-decoration: none; margin-right: 4px; }
body.sbft .code-page .code-home { display: inline; }
.code-page .code-name { font-size: 16px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 40vw; }
.code-page .code-lang { font-size: 12px; color: #555; border: 1px solid #ccd; border-radius: 9px; padding: 0 7px; }
.code-page .code-status { font-size: 12px; color: #555; margin-left: auto; }
.code-page .code-menu-wrap { position: relative; }
.code-page .code-filemenu { position: absolute; right: 0; top: 100%; min-width: 220px; background: #fff; border: 1px solid #ccc; border-radius: 8px; box-shadow: 0 6px 24px rgba(0,0,0,.15); padding: 4px; z-index: 30; }
.code-page .code-filemenu button { background: none; border: 0; padding: 5px 10px; border-radius: 5px; font: inherit; cursor: pointer; }
.code-page .code-filemenu button:hover:not(:disabled) { background: #eef2f7; }
.code-page .code-close { background: none; border: 0; font-size: 18px; line-height: 1; padding: 2px 6px; border-radius: 5px; color: #555; cursor: pointer; }
.code-page .code-close:hover { background: #e8eaed; color: #222; }
.code-page .code-bar { background: #fff4d6; border-bottom: 1px solid #e3c96b; padding: 6px 10px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.code-page .code-note { padding: 16px; color: #444; }
.code-page .code-body { flex: 1; overflow: auto; display: flex; font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; tab-size: 4; }
.code-page .code-ln { margin: 0; padding: 10px 8px 10px 12px; text-align: right; color: #999; user-select: none; background: #fafafa; border-right: 1px solid #eee; white-space: pre; font: inherit; }
.code-page .code-src { margin: 0; padding: 10px 12px; white-space: pre; font: inherit; flex: 1; min-width: 0; }
.code-page .code-edit { position: relative; flex: 1; min-width: 0; }
.code-page .code-edit pre, .code-page .code-edit textarea { margin: 0; padding: 10px 12px; font: inherit; white-space: pre; border: 0; box-sizing: border-box; width: 100%; min-height: 100%; tab-size: 4; }
.code-page .code-edit pre { position: absolute; inset: 0; pointer-events: none; overflow: hidden; }
.code-page .code-edit textarea { position: relative; display: block; height: 100%; resize: none; outline: none; background: transparent; color: transparent; caret-color: #222; overflow: auto; }
.code-page .code-edit textarea.plain { color: #222; }
.code-page .hc { color: #6a737d; font-style: italic; } .code-page .hs { color: #22863a; } .code-page .hn { color: #005cc5; }
.code-page .hk { color: #d73a49; font-weight: 600; } .code-page .hb { color: #6f42c1; } .code-page .hf { color: #6f42c1; font-weight: 600; } .code-page .hd { color: #e36209; }
`;

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = ""): HTMLElementTagNameMap[K] => { const e = document.createElement(tag); if (cls) e.className = cls; if (text) e.textContent = text; return e; };
const fmtSize = (n: number) => (n < 1024 ? `${n} B` : n < 2 ** 20 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 2 ** 20).toFixed(1)} MB`);
const download = (bytes: Uint8Array, name: string) => {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "application/octet-stream" }));
  const a = el("a"); a.href = url; a.download = name; document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
};
let current: { dispose(): void } | null = null;

/** The code page for host.fid, mounted into `root` (its children replaced). */
export async function mount(root: HTMLElement, host: Host): Promise<void> {
  current?.dispose();
  const life = new AbortController();
  if (!document.getElementById("sb-code-style")) { const s = el("style"); s.id = "sb-code-style"; s.textContent = CSS; document.head.append(s); }
  const ws = host.ws;
  root.replaceChildren();
  const page = el("div", "code-page"); root.append(page);
  const head = el("div", "code-head"), bar = el("div", "code-bar"), body = el("div", "code-body");
  bar.hidden = true;
  // (the agent's bar, when one is connected: its row under the head, over the notebook page's; workspace/agent-ui.ts)
  const agentRow = el("div", "code-agent"); agentRow.dataset.sbagSlot = "2";
  page.append(head, agentRow, bar, body);
  const files = el("button", "code-files", "Files"); files.setAttribute("aria-controls", "wssidebar");
  files.onclick = () => { const b = document.getElementById("wsfilesbtn"); if (b) b.click(); else void leave(); };
  const name = el("span", "code-name"), lang = el("span", "code-lang"), status = el("span", "code-status");
  status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite");
  const toggle = el("button", "code-toggle");
  const menuWrap = el("span", "code-menu-wrap"), fileBtn = el("button", "", "File"), menu = el("div", "code-filemenu");
  fileBtn.append(Object.assign(el("span", "sb-caret"), { ariaHidden: "true" }));
  fileBtn.setAttribute("aria-haspopup", "menu"); menu.hidden = true; menu.setAttribute("role", "menu");
  menuWrap.append(fileBtn, menu);
  // (Sagebrush, then the file's name, beside the corner Files button, as on the notebook, board and LaTeX pages)
  const home = el("a", "code-home", "Sagebrush") as HTMLAnchorElement; home.href = "/?home"; home.title = "About Sagebrush, and where to start";
  home.onclick = (ev) => { if (ev.button || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return; ev.preventDefault(); void leave(home.href); };
  // (✕: back to the notebook page, which opens the last notebook; what was typed here saved first)
  const close = el("button", "code-close", "✕"); close.title = "Close this file"; close.setAttribute("aria-label", "Close");
  // (leaving the page, to `to`: by the ✕, or by the notebook page for a notebook, board or code file opened here
  // (index.html and boot.ts, __sbCodeLeave), so every way out saves first)
  let mayLeave = async () => true;
  let leave = async (to = "/") => { await host.navigate(to).catch((err) => say("Couldn't leave this page: " + (err?.message ?? err))); };
  close.onclick = () => void leave();
  (globalThis as any).__sbCodeLeave = (to: string) => leave(to);
  head.append(files, home, name, lang, status, toggle, menuWrap, close);
  const say = (t: string) => { status.textContent = t; };
  const note = (t: string) => { body.replaceChildren(el("p", "code-note", t)); };

  // ---- the file, by its id: where it is, its bytes, its revision
  const found = await ws.pathOfFile(host.fid).catch(() => ({ ok: false as const, why: "none" as const }));
  if (!found.ok) { name.textContent = "A file"; toggle.hidden = true; fileBtn.hidden = true; note(found.why === "trashed" ? "This file is in Trash." : found.why === "ambiguous" ? "More than one file has this id: open it from Files." : "This file isn't here any more."); return; }
  let path = found.path, entry = found.entry;
  const showName = () => { name.textContent = nameOf(path); name.title = path; document.title = nameOf(path) + " — Sagebrush"; };
  showName();
  const lg: Lang = langOf(path) ?? "text";
  lang.textContent = LANG_LABEL[lg];
  if ((entry.size ?? 0) > CODE.openBytes) { toggle.hidden = true; note(`This file is too large to open here (${fmtSize(entry.size!)}): download it from Files.`); return; }
  // (a test's seam: the page test changes what is at the path here, between finding the file and reading it)
  await (globalThis as any).__sbCodeBeforeOpen?.(path);
  const read = await ws.readUpTo(path, CODE.openBytes).catch((e) => e as Error);
  if (read instanceof Error) { note("This file couldn't be read: " + String(read.message ?? read).slice(0, 200)); return; }
  if (read.entry.fid !== host.fid) { note("Another file is at this path now: open it again from Files."); return; }
  entry = read.entry;
  const o = openBytes(read.content);
  if (o.kind !== "text") { toggle.hidden = true; note(`This file can't be shown as text (${o.why}): download it from Files.`); return; }
  let text = o.text, saved = o.text, rev = entry.rev ?? 0, eol = o.eol;
  let editable = editableOf(o.saveable, read.content.length, entry.remote);
  // (why it can't be written back exactly, as it is now: as it opened, then as each change made elsewhere left it)
  let unsaveable = o.saveable ? "" : o.why;
  const whyNot = () => (unsaveable ? unsaveable : entry.remote ? "it is in the cloud: open it on the device that made it" : `it is over ${fmtSize(CODE.editBytes)}`);

  // ---- View and Edit
  const key = modeKey("file", host.fid);
  let mode: "view" | "edit" = editable ? modeOf(key) : "view";
  const ln = el("pre", "code-ln"), src = el("pre", "code-src"), code = el("code");
  src.append(code);
  const edit = el("div", "code-edit"), hl = el("pre"), ta = el("textarea");
  hl.setAttribute("aria-hidden", "true");
  ta.spellcheck = false; ta.setAttribute("autocapitalize", "off"); ta.setAttribute("autocomplete", "off"); ta.setAttribute("aria-label", nameOf(path));
  edit.append(hl, ta);
  const lines = (t: string) => { let n = 1; for (let i = 0; i < t.length; i++) if (t.charCodeAt(i) === 10) n++; return n; };
  const drawLines = (t: string) => { const n = lines(t); ln.textContent = Array.from({ length: n }, (_, i) => String(i + 1)).join("\n"); };
  const drawView = () => {
    drawLines(text);
    if (text.length <= CODE.viewBytes) drawTokens(code, tokensOf(text, lg)); else code.textContent = text;
    body.replaceChildren(ln, src);
  };
  let hlTimer: any = null;
  const drawEditHl = () => {
    const live = ta.value.length <= CODE.liveBytes;
    ta.classList.toggle("plain", !live);
    if (live) drawTokens(hl, tokensOf(ta.value + "\n", lg)); else hl.textContent = "";
    drawLines(ta.value);
  };
  const drawEdit = () => { ta.value = text; body.replaceChildren(ln, edit); drawEditHl(); ta.focus(); };
  const showMode = () => {
    toggle.hidden = false;
    toggle.disabled = !editable;
    toggle.textContent = mode === "edit" ? "View" : "✎ Edit";
    toggle.title = !editable ? `Read-only: ${whyNot()}` : mode === "edit" ? EDITING_TITLE : EDIT_TITLE;
    toggle.setAttribute("aria-pressed", String(mode === "edit"));
    mode === "edit" ? drawEdit() : drawView();
  };
  const setMode = async (m: "view" | "edit") => {
    if (m === "edit" && !editable) return;
    if (mode === "edit" && m === "view") { text = ta.value; await flush(); }
    mode = m; rememberMode(key, m); showMode();
  };
  toggle.onclick = () => void setMode(mode === "edit" ? "view" : "edit");
  // (Esc leaves Edit; E enters it, outside a field: the board's keys)
  const keys = (ev: KeyboardEvent) => {
    if (ev.key === "Escape" && mode === "edit" && menu.hidden && document.activeElement === ta) { void setMode("view"); return; }
    if ((ev.key === "e" || ev.key === "E") && mode === "view" && !ev.ctrlKey && !ev.metaKey && !ev.altKey && !(ev.target as HTMLElement)?.closest?.("input,textarea,select,[contenteditable]")) { ev.preventDefault(); void setMode("edit"); }
  };
  addEventListener("keydown", keys, { signal: life.signal });
  ta.addEventListener("scroll", () => { hl.scrollTop = ta.scrollTop; hl.scrollLeft = ta.scrollLeft; ln.style.transform = `translateY(${-ta.scrollTop}px)`; });
  ta.addEventListener("keydown", (ev) => {
    // (Tab indents, as in the notebook's editor; Shift+Tab leaves the field)
    if (ev.key === "Tab" && !ev.shiftKey && !ev.ctrlKey && !ev.altKey && !ta.readOnly) { ev.preventDefault(); document.execCommand?.("insertText", false, lg === "python" || lg === "sage" ? "    " : "\t") || ta.setRangeText("    ", ta.selectionStart, ta.selectionEnd, "end"); ta.dispatchEvent(new Event("input")); }
  });

  // ---- saving as you type: over the revision read or saved, never over another's change. One write at a time, in a
  // loop: after each write the text is checked again, and an edit made while it was written (its timer fired into the
  // write in flight) is written next, so the latest text always reaches the file (daybreak3, #773: it was dropped)
  let saveTimer: any = null, saving: Promise<void> | null = null, stopped = false;
  const live = () => (mode === "edit" ? ta.value : text);
  const dirty = () => (mode === "edit" ? ta.value : text) !== saved;
  ta.addEventListener("input", () => {
    clearTimeout(hlTimer); hlTimer = setTimeout(drawEditHl, ta.value.length > 64 * 1024 ? 120 : 0);
    if (stopped) { say("Not saved: this file was changed elsewhere"); return; }
    say("Editing…");
    clearTimeout(saveTimer); saveTimer = setTimeout(() => void flush(), CODE.saveMs);
  });
  // (one write of the text as it is now; true if it wrote)
  async function save(): Promise<boolean> {
    if (stopped || !editable) return false;
    const t = live();
    if (t === saved) return false;
    const bytes = encodeText(t, eol);
    if (bytes.length > CODE.editBytes) { say(`Not saved: over ${fmtSize(CODE.editBytes)}`); return false; }
    say("Saving…");
    try {
      const at = await ws.pathOfFile(host.fid);
      if (!at.ok) { stop("This file isn't here any more: your text is still here. Save it as a copy?"); return false; }
      // (a test's seam: the page test holds a write here to edit during it; nothing sets it otherwise)
      await (globalThis as any).__sbCodeBeforeWrite?.();
      const w = await ws.write(at.path, bytes, { fid: host.fid, base: rev });
      saved = t; rev = w.rev; entry = w.entry;
      if (at.path !== path) { path = at.path; showName(); }
      return true;
    } catch (err) {
      if ((err as any)?.code === "conflict") stop("This file was changed elsewhere, so your edits here weren't saved over it.");
      else say("Not saved: " + String((err as Error)?.message ?? err).slice(0, 200));
      return false;
    }
  }
  // (the save loop: while the text differs from what was saved, write it again; "Saved" only when they are the same.
  //  A flush while it runs waits for the same loop, which then writes the newer text too)
  const flush = (): Promise<void> => {
    clearTimeout(saveTimer);
    return (saving ??= (async () => {
      for (let n = 0; !stopped && editable && live() !== saved && n < 100; n++) if (!(await save())) break;
      if (!stopped && live() === saved) say("Saved");
    })().finally(() => { saving = null; }));
  };
  // (closing: the edits saved first; anything still unsaved (saving stopped, or a save refused or failed) is dropped by
  // leaving, so it asks, and stays if the person says no)
  // (one way out at a time (✕, a copy, Trash, a new notebook...), from its first step (the save, the question, the copy
  //  or notebook made) to the navigation or the page staying: every other does nothing meanwhile (no second question,
  //  drain or side effect), and no typing throughout, as what's typed then would be left behind (the desktop app's disk
  //  written first, by the host); typing back if the page stays. `leaving`: the navigation asked for, so the browser's
  //  prompt isn't. A navigation the host made that doesn't happen (cancelled) lets a way out be tried again after a
  //  while, said, typing still off (the page may yet go); a page come back from the back/forward cache is freed)
  let leaving = false, exiting = false;
  const stay = () => { exiting = false; leaving = false; ta.readOnly = false; };
  addEventListener("pageshow", (ev) => { if (ev.persisted) stay(); }, { signal: life.signal });
  const exit = async (run: () => Promise<boolean>) => {
    if (exiting) return;
    exiting = true; ta.readOnly = true;
    let went = false;
    try { went = await run(); } catch (err: any) { say("Couldn't leave this page: " + String(err?.message ?? err).slice(0, 200)); } finally { if (!went) stay(); }
    if (went) {
      const t = setTimeout(() => { exiting = false; leaving = false; say("This page hasn't been left yet: try again."); }, 30000);
      addEventListener("pagehide", () => clearTimeout(t), { once: true, signal: life.signal });
    }
  };
  mayLeave = async () => { await flush(); return !dirty() || confirm("Close this file? Your unsaved edits here are dropped."); };
  // (whether it navigated: false if the host refused (it said why) or failed (said here))
  const go = async (to: string) => {
    leaving = true;
    try { return await host.navigate(to); } catch (err: any) { say("Couldn't leave this page: " + (err?.message ?? err)); return false; }
  };
  leave = (to = "/") => exit(async () => (await mayLeave()) && go(to));
  // (decided to leave, with a step still to take first (a notebook made, this file moved to Trash), then gone)
  // (the copy just saved holds the edits: opened straight away, never asking whether to drop them)
  // (whether it navigated: a copy with no fid can't be opened here, and stays only said; nor one the host refused)
  const openCopy = async (e: Entry) => (e.fid ? go(codeUrl(e.fid)) : false);
  const thenGo = async (step: () => Promise<string>) => {
    // (a test's seam: the page test holds the step here to type during it; nothing sets it otherwise)
    await (globalThis as any).__sbCodeBeforeLeaveStep?.();
    return go(await step());
  };
  // (saving stopped: the bar asks; nothing is written until the person chooses)
  function stop(why: string) {
    stopped = true; clearTimeout(saveTimer);
    say("Not saved");
    const reload = el("button", "", "Reload (theirs)"), copy = el("button", "", "Save mine as a copy");
    reload.onclick = () => { if (exiting) return; if (dirty() && !confirm("Reload this file? Your unsaved edits here are dropped.")) return; void mount(root, host); };
    copy.onclick = () => void copyAndOpen();
    bar.replaceChildren(el("span", "", why), reload, copy);
    bar.hidden = false;
  }
  addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden" && dirty()) void flush(); }, { signal: life.signal });
  addEventListener("pagehide", () => { if (dirty()) void flush(); }, { signal: life.signal });
  // (a reload or a closed tab inside the save delay: the save started, and the browser's leave prompt requested, as a
  //  write isn't waited for on the way out; staying lets it land. Not once the page's own way out is navigating)
  addEventListener("beforeunload", (ev) => { if (leaving || !dirty()) return; void flush(); ev.preventDefault(); ev.returnValue = ""; }, { signal: life.signal });

  // ---- a change to this file made elsewhere: followed when nothing here is unsaved, else saving stops
  let checkTimer: any = null;
  const check = async () => {
    if (saving) await saving;
    // (stopped: nothing to follow, and the stop's own reason stays said; disposed: nothing here any more)
    if (stopped || life.signal.aborted) return;
    const r = await ws.pathOfFile(host.fid).catch(() => null);
    if (!r || !r.ok) { if (!stopped) stop("This file was moved to Trash or deleted elsewhere."); return; }
    if (r.path !== path) { path = r.path; showName(); }
    if ((r.entry.rev ?? 0) === rev) return;
    if (dirty()) { stop("This file was changed elsewhere while you were editing it here."); return; }
    // (what this page has before the read: if any of it changed while the read waited (an edit typed, a save of this
    //  page's own), the read's bytes aren't installed: an edit stops following with the draft kept, anything else
    //  checks again; astra on #773)
    const before = { live: live(), saved, rev, stopped, mode };
    await (globalThis as any).__sbCodeBeforeRead?.();
    const fresh = await ws.readUpTo(r.path, CODE.openBytes).catch(() => null);
    if (life.signal.aborted || stopped) return;
    if (live() !== before.live || saved !== before.saved || rev !== before.rev || mode !== before.mode || saving) {
      if (dirty()) { stop("This file was changed elsewhere while you were editing it here."); return; }
      clearTimeout(checkTimer); checkTimer = setTimeout(() => void check(), 50); return;
    }
    const fo = fresh && fresh.entry.fid === host.fid ? openBytes(fresh.content) : null;
    if (!fresh || !fo || fo.kind !== "text") { stop("This file was changed elsewhere and can't be shown here now."); return; }
    text = saved = fo.text; eol = fo.eol; rev = fresh.entry.rev ?? 0; entry = fresh.entry;
    editable = editableOf(fo.saveable, fresh.content.length, entry.remote);
    unsaveable = fo.saveable ? "" : fo.why;
    if (!editable && mode === "edit") mode = "view";
    if (mode === "edit") { const a = ta.selectionStart, b = ta.selectionEnd, top = ta.scrollTop; ta.value = text; ta.setSelectionRange(Math.min(a, text.length), Math.min(b, text.length)); ta.scrollTop = top; drawEditHl(); toggle.disabled = !editable; }
    else showMode();
    say("Updated: changed elsewhere");
  };
  // (every op on this file carries its fid, whatever its path (the workspace's log): a write, a rename, a move to Trash)
  const unwatch = ws.watch((c) => {
    if (!(c.ops ?? []).some((op: any) => op.fid === host.fid)) return;
    clearTimeout(checkTimer); checkTimer = setTimeout(() => void check(), 50);
  });
  life.signal.addEventListener("abort", () => { unwatch(); clearTimeout(checkTimer); clearTimeout(saveTimer); clearTimeout(hlTimer); });

  // ---- the one File menu (filemenu.ts), this page's keys
  const free = async (folder: string, base: string, ext: string) => { const taken = new Set((await ws.list(folder)).map((e) => e.path)); return freePath(folder, base, ext, (p) => taken.has(p)); };
  // (a copy of the text as it is now, then the copy opened: no typing from the moment the text is taken until the
  //  navigation, as what's typed then would be in neither file; typing again if no copy is made)
  // (a way out (exit): a second click while a copy is made does nothing)
  function copyAndOpen() {
    return exit(async () => {
      const e = await saveCopy(mode === "edit" ? ta.value : text);
      return e ? openCopy(e) : false;
    });
  }
  async function saveCopy(t: string): Promise<Entry | null> {
    const [base, ext] = splitExt(nameOf(path));
    const p = await free(parentOf(path), base + " (copy)", ext);
    if (!p) { say("No free name for a copy"); return null; }
    try {
      // (a test's seam: the page test holds the copy's create here, or fails it; nothing sets it otherwise)
      await (globalThis as any).__sbCodeBeforeCopyCreate?.();
      const e = await ws.create(p, { content: encodeText(t, eol) }); say("Copied to " + nameOf(p)); return e;
    }
    catch (err) { say("Not copied: " + String((err as Error)?.message ?? err).slice(0, 200)); return null; }
  }
  const actions: Record<string, () => unknown> = {
    "c-new": () => exit(async () => { const p = await free("/", "Untitled", ".ipynb"); if (!p) { say("No free name for a new notebook"); return false; } if (!(await mayLeave())) return false; return thenGo(async () => "/?nb=" + encodeURIComponent((await ws.createByPerson(p, { mode: "python" })).ref!)); }),
    "c-newboard": () => leave("/board/?new=python"),
    "c-newfolder": async () => { const n = prompt("A new folder, at the top of your files: its name", "New folder"); if (n?.trim()) await ws.mkdir("/" + safeName(n.trim())); },
    // (the gallery's panel, the only list of examples; where this page can't reach it, said)
    "c-examples": async () => { if (!(await host.examples())) say("The examples aren't available here."); },
    "c-open": () => host.openFiles(),
    "c-copy": async () => { await flush(); await copyAndOpen(); },
    "c-rename": async () => {
      await flush();
      const [base, ext] = splitExt(nameOf(path));
      const n = prompt("Rename this file", base);
      if (!n?.trim() || n.trim() === base) return;
      try { const e = await ws.rename(path, parentOf(path) + (parentOf(path) === "/" ? "" : "/") + safeName(n.trim()) + ext, { expect: { kind: entry.kind, ref: entry.ref, fid: entry.fid, created: entry.created } }); if (e) { path = e.path; entry = e; showName(); say("Renamed"); } }
      catch (err) { say("Not renamed: " + String((err as Error)?.message ?? err).slice(0, 200)); }
    },
    "c-download": async () => { await flush(); download(encodeText(mode === "edit" ? ta.value : text, eol), nameOf(path)); },
    "c-print": () => window.print(),
    "c-delete": () => exit(async () => {
      if (!confirm(`Move "${nameOf(path)}" to Trash? Trash keeps it until you empty it.`)) return false;
      // (the page is left after this: asked first, before anything is removed)
      if (!(await mayLeave())) return false;
      try { return await thenGo(async () => { await ws.remove(path, { kind: entry.kind, ref: entry.ref, fid: entry.fid, created: entry.created }); return "/"; }); }
      catch (err) { say("Not moved to Trash: " + String((err as Error)?.message ?? err).slice(0, 200)); return false; }
    }),
  };
  host.renderFileMenu(menu, {
    attr: "data-f",
    keys: { newNotebook: "c-new", newBoard: "c-newboard", newFolder: "c-newfolder", fromExample: "c-examples", open: "c-open", saveCopy: "c-copy", rename: "c-rename", print: "c-print", share: "c-share", delete: "c-delete" },
    disabled: { share: true },
    why: { upload: "Upload… is in Files", share: "A file is shared with its notebook or folder: share it from there" },
    downloads: [{ key: "c-download", label: nameOf(path) }],
    chosen: () => { menu.hidden = true; },
  });
  if (host.agent) {
    const b = el("button", "", "Connect an agent…");
    b.setAttribute("data-f", "c-agent"); b.setAttribute("role", "menuitem");
    b.title = "Connect an agent on this computer (Claude Code, Codex, …) to files you choose";
    actions["c-agent"] = () => { menu.hidden = true; return host.agent!(fileBtn).catch(() => say("Couldn't load the agent connection. Choose Connect an agent… again, or reload the page.")); };
    menu.append(el("hr"), b);
  }
  menu.addEventListener("click", (ev) => { const k = (ev.target as HTMLElement).closest("button")?.getAttribute("data-f"); const f = k ? actions[k] : null; if (f) Promise.resolve(f()).catch((err) => say(String((err as Error)?.message ?? err).slice(0, 200))); });
  fileBtn.onclick = (ev) => { ev.stopPropagation(); menu.hidden = !menu.hidden; };
  addEventListener("click", (ev) => { if (!menu.hidden && !menuWrap.contains(ev.target as Node)) menu.hidden = true; }, { signal: life.signal });

  // ---- for agents and tests: the file as this page has it
  const sb = ((globalThis as any).sagebrush ??= {});
  const handle = { fid: host.fid, say, get path() { return path; }, lang: lg, text: () => (mode === "edit" ? ta.value : text), mode: () => mode, setMode, flush, editable: () => editable, stopped: () => stopped };
  sb.code = handle;
  current = { dispose: () => { life.abort(); if (sb.code === handle) delete sb.code; } };
  showMode();
  say(editable ? "" : `Read-only: ${whyNot()}`);
}
