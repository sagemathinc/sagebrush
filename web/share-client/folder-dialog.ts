// Share folder… (Files ▸ ⋯ on a folder; book links B2, design r2): the dialog, in a chunk of its own
// (/sagebrush-share-folder.js), loaded only when it is chosen.  It lists every notebook and data file under the
// folder, ticked, except a file that looks like it holds a secret (secrets.ts: unticked, with why and where), uploads
// the ticked ones as the folder's share (folder.ts: a new version at the same link once it has one), and gives a
// link per chapter (?f=<path>: a notebook or a LaTeX document), with Copy all links.
//
// Its words (William, Nov 12): what is shared is the folder's contents, nothing special about notebooks; the share is a
// copy, the same until the folder is shared again; no account is needed to open it, run its code or edit its LaTeX;
// nothing shared is indexed by search engines; signed out, this is where to sign in or make an account; the license
// is "None given" unless chosen, with what that means (CoCalc's policies).
//
// A talk's Share… (the LaTeX editor's File menu, `talk`): the same dialog for the talk's folder, as a talk's code can
// read its folder's files (the share page mounts only them).  Its talks are chapters too, the talk's own link first;
// the open talk is saved first, and a save that fails (or doesn't hold the text on screen) shares nothing.  A talk at
// the top of the files isn't shared: its folder would be all of them (@sagebrush's ruling, Nov 12).
import { folderPlan, shareFolderUpload, chapterLink, linksText, goneChapters, type PlanEntry, type FolderShare } from "./folder";
import { findSecret, secretName, secretWarning, SCANNED } from "./secrets";
import { uploadCollection, AttemptError, shareStatus, signInUrl, type LazyFile } from "./upload";
import { texUses } from "./tex-uses";

export interface ShareFolderHost {
  folder: { path: string; fid: string };
  /** every entry under the folder (metadata only) */
  list: () => Promise<PlanEntry[]>;
  /** a data file's bytes (throws if it isn't the file listed any more) */
  readFile: (e: PlanEntry) => Promise<Uint8Array>;
  /** a notebook's saved record */
  readNotebook: (e: PlanEntry) => Promise<any>;
  /** a notebook record's .ipynb text (file-bytes.ts notebookFileText: Download's bytes) */
  notebookText: (doc: any) => string;
  /** the notebook open on the page, saved first */
  saveOpen: () => Promise<void>;
  /** the folder's share record (api.ts folderShare / setFolderShare) */
  getShare: () => Promise<FolderShare | undefined>;
  setShare: (expect: FolderShare | undefined, next: FolderShare | undefined) => Promise<boolean>;
  /** this device's upload records for "folder:<fid>" (index.html's shareSent), for `account` */
  sent: (account: string) => { get: () => Promise<any>; put: (attempt: string) => Promise<string>; drop: (attempt: string) => Promise<unknown> };
  sentMax: number;
  fmtSize: (n: number) => string;
  /** the talk this was opened for, by its path under the folder; `saveOpen` then saves it, and its failure stops the share */
  talk?: { rel: string };
  /** the files as one .zip, handed to the browser's download (the page's export chunk): "Download instead", the share
   *  anyone can open with no service at all (William, Nov 12) */
  zip?: (picks: { name: string; read(): Promise<Uint8Array> }[], name: string) => Promise<void>;
}

/** The lines for a LaTeX document (sharing it from the LaTeX editor): it is shared with the files it uses, wherever it
 *  is, never by moving it (William, Nov 12: "Most people will do this"). */
export const TALK_SAVE_FAILED = "Couldn't save the document, so nothing was shared. Try again in a moment.";
export const TALK_SCOPE = "Shares this document and the files it uses, ticked below. The other files in its folder are listed unticked: tick any it needs that weren't found.";

/** The dialog's words: what a share is and isn't (also the sign-in prompt's). */
export const SHARE_OPEN = "Anyone with a link can open the share, run its code and edit its LaTeX in their browser, with no account. Nothing shared is listed by search engines.";
export const SHARE_COPY = "The share is a copy: it stays as it is while you keep working here. Share again to publish your changes, at the same links.";
/** Where sharing isn't (a preview, the CLI's page): what it is and where it works, never a dead end (William, Nov 12). */
export const SHARE_NOSERVER = "Publishing a link needs Sagebrush's share service, which this site doesn't have. On sagebrush.space, sign in with CoCalc (or make an account) and share from there.";
export const SHARE_SITE = "https://sagebrush.space";
export const SHARE_SIGNIN = "Sharing needs a CoCalc account: sign in, or make one, and come back here.";
export const POLICIES = "https://cocalc.ai/policies";

// (files read for secrets: text by name, each at most this many bytes; a larger one isn't read, and says so)
const SCAN_BYTES = 1 << 20;
const STYLE = `#sbfolderdlg{border:1px solid var(--line);border-radius:10px;background:var(--cell);color:var(--fg);padding:14px 16px;width:min(620px,94vw)}
#sbfolderdlg::backdrop{background:rgba(0,0,0,.35)}#sbfolderdlg .note{color:var(--muted);font-size:13px;margin:2px 0 8px}
#sbfolderdlg label.f{display:flex;gap:8px;align-items:center;margin:6px 0;font-size:13px}#sbfolderdlg label.f input{flex:1}
#sbfolderdlg .rows{max-height:34vh;overflow:auto;border:1px solid var(--line);border-radius:6px;margin:6px 0;font-size:13px}
#sbfolderdlg .row{display:flex;gap:8px;align-items:baseline;padding:3px 8px}#sbfolderdlg .row .size{color:var(--muted);margin-left:auto}
#sbfolderdlg .warn{color:#b3261e;font-size:12px;padding:0 8px 4px 30px}#sbfolderdlg .links div{display:flex;gap:8px;align-items:center;font-size:13px;margin:3px 0}
#sbfolderdlg .links a{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}`;

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { className?: string } = {}, ...kids: (Node | string)[]) => {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids);
  return e;
};
const nameOf = (p: string) => p.slice(p.lastIndexOf("/") + 1) || "/";
const rand = () => [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");

/** Opens the dialog; resolves when it is closed.  (tests: window.sagebrush.shareFolderDialog is the open one) */
export async function openShareFolder(h: ShareFolderHost): Promise<void> {
  if (!document.getElementById("sbfolderstyle")) document.head.append(el("style", { id: "sbfolderstyle", textContent: STYLE }));
  document.getElementById("sbfolderdlg")?.remove();
  const close = el("button", { type: "button", textContent: "✕", ariaLabel: "Close" });
  const status = el("p", { className: "note", role: "status" });
  const body = el("div");
  // (a LaTeX document's dialog is titled for it, wherever it is; a folder's for the folder)
  const top = !!h.talk;
  const heading = top ? `Share “${nameOf(h.talk!.rel)}”` : `Share folder “${nameOf(h.folder.path)}”`;
  const dlg = el("dialog", { id: "sbfolderdlg" }, el("div", { style: "display:flex;justify-content:space-between;align-items:center" } as any, el("b", { textContent: heading }), close), status, body);
  dlg.setAttribute("aria-label", top ? `Share ${nameOf(h.talk!.rel)}` : `Share folder ${nameOf(h.folder.path)}`);
  document.body.append(dlg);
  let busy = false;
  close.onclick = () => { if (!busy) dlg.close(); };
  // (while uploading, the dialog stays: Esc does nothing)
  dlg.addEventListener("cancel", (ev) => { if (busy) ev.preventDefault(); });
  const closed = new Promise<void>((r) => dlg.addEventListener("close", () => { dlg.remove(); r(); }));
  dlg.showModal();
  const talk = h.talk ?? null;

  // (what would be shared: the folder's files, or a LaTeX document and the files it uses, ticked; null if the document
  //  couldn't be saved, said)
  const listRows = async () => {
  status.textContent = "Listing the folder…";
    // (a talk's save failing stops it here: its text on screen isn't what would be listed and read)
    if (talk) {
      try { await h.saveOpen(); } catch { status.textContent = TALK_SAVE_FAILED; return null; }
    } else await h.saveOpen().catch(() => {});
    const plan = folderPlan(h.folder.path, await h.list());
    // (a LaTeX document: the files it uses ticked (its \input, \includegraphics, \bibliography, … and what its code
    //  names, tex-uses.ts), its results file too; the folder's other files listed unticked, and at the top of the files
    //  only those at the top. A name that leaves the folder is never followed, only said)
    let uses: Set<string> | null = null, outsideRefs: string[] = [];
    if (talk) {
      status.textContent = "Finding the files it uses…";
      const byRel = new Map(plan.files.map((f) => [f.rel, f]));
      const textOf = async (rel: string) => {
        const f = byRel.get(rel);
        if (!f || f.notebook || (f.entry.size ?? 0) > SCAN_BYTES) return null;
        try { return new TextDecoder().decode(await h.readFile(f.entry)); } catch { return null; }
      };
      const found = await texUses((await textOf(talk.rel)) ?? "", plan.files.filter((f) => !f.notebook).map((f) => f.rel), textOf);
      uses = found.uses;
      uses.add(talk.rel).add(talk.rel + ".results.json");
      outsideRefs = found.outside;
    }
    // (never anything in Trash, whatever names it)
    const listed = (talk && h.folder.path === "/" ? plan.files.filter((f) => !f.rel.includes("/") || uses!.has(f.rel)) : plan.files).filter((f) => !f.entry.path.startsWith("/Trash/"));
    const rows = listed.map((f) => ({ f, box: el("input", { type: "checkbox", checked: !uses || uses.has(f.rel) }), warn: "" }));
    return { plan, rows, uses, outsideRefs };
  };
  // (the files ticked, as the .zip's members: a notebook as its .ipynb text)
  const picksOf = (rs: { f: { rel: string; notebook: boolean; entry: PlanEntry } }[]) => rs.map((r) => r.f.notebook
    ? { name: r.f.rel, read: async () => new TextEncoder().encode(h.notebookText(await h.readNotebook(r.f.entry))) }
    : { name: r.f.rel, read: () => h.readFile(r.f.entry) });
  const zipName = () => (talk ? nameOf(talk.rel).replace(/\.tex$/i, "") : nameOf(h.folder.path)) + ".zip";
  const zipButton = (rs: () => { f: { rel: string; notebook: boolean; entry: PlanEntry } }[], said: HTMLElement) => {
    const b = el("button", { type: "button", textContent: "Download as .zip" });
    b.title = "These files in one .zip, downloaded to this computer: anyone you send it to can open them";
    b.onclick = async () => {
      const chosen = rs();
      if (!chosen.length) { said.textContent = "Tick a file to download."; return; }
      b.disabled = true; said.textContent = "Making the .zip…";
      try { await h.zip!(picksOf(chosen), zipName()); said.textContent = `Downloaded ${zipName()} (${chosen.length} file${chosen.length === 1 ? "" : "s"}).`; }
      catch (e) { said.textContent = "Not downloaded: " + String((e as Error)?.message ?? e).slice(0, 200); }
      finally { b.disabled = false; }
    };
    return b;
  };

  status.textContent = "Checking your sign-in…";
  const s = await shareStatus();
  if (!s.enabled || !s.me) {
    status.textContent = s.enabled ? SHARE_SIGNIN : s.error ? "Couldn't reach the server to check your sign-in. Try again in a moment." : SHARE_NOSERVER;
    if (s.enabled) body.append(el("p", { className: "note", textContent: SHARE_OPEN }), el("a", { className: "btn", href: signInUrl(location.pathname + location.search), textContent: "Sign in with CoCalc" }));
    else if (!s.error) body.append(el("p", { className: "note", textContent: SHARE_OPEN }), el("a", { className: "btn", href: SHARE_SITE, target: "_blank", rel: "noopener", textContent: "Open sagebrush.space" }));
    // (and the share that needs no service: the files themselves, downloaded)
    if (h.zip && !s.error) {
      const msg = status.textContent;
      const got = await listRows();
      status.textContent = got ? msg : status.textContent;
      if (got) {
        const ticked = got.rows.filter((r) => r.box.checked), said = el("span", { className: "note" });
        body.append(el("p", { className: "note", textContent: `Or download ${talk ? "it and the files it uses" : "the folder's files"} (${ticked.length} file${ticked.length === 1 ? "" : "s"}) as one .zip, and send that: anyone can open it.` }), el("div", {}, zipButton(() => ticked, said), " ", said));
      }
    }
    return closed;
  }
  const me = s.me;
  const got = await listRows();
  if (!got) return closed;
  const { plan, rows, uses, outsideRefs } = got;
  // (secrets: by name, then the text of notebooks and text files; one finding per file)
  status.textContent = "Checking the files for keys…";
  const unread: string[] = [];
  for (const r of rows) {
    const byName = secretName(nameOf(r.f.rel));
    if (byName) { r.warn = secretWarning(r.f.rel, { what: byName }); r.box.checked = false; continue; }
    try {
      if (r.f.notebook) {
        const doc = await h.readNotebook(r.f.entry);
        const cells: any[] = Array.isArray(doc?.cells) ? doc.cells : [];
        for (let i = 0; i < cells.length && !r.warn; i++) {
          const hit = findSecret(String(cells[i]?.code ?? cells[i]?.source ?? ""));
          if (hit) r.warn = secretWarning(r.f.rel, hit, i + 1);
        }
      } else if (SCANNED.test(r.f.rel)) {
        if ((r.f.entry.size ?? 0) > SCAN_BYTES) { unread.push(r.f.rel); continue; }
        const hit = findSecret(new TextDecoder().decode(await h.readFile(r.f.entry)));
        if (hit) r.warn = secretWarning(r.f.rel, hit);
      }
    } catch {
      unread.push(r.f.rel);
    }
    if (r.warn) r.box.checked = false;
  }
  const maxFile = me.limits?.max_file_bytes, left = me.limits ? me.limits.storage_bytes - me.usage : undefined;
  for (const r of rows) if (maxFile !== undefined && (r.f.entry.size ?? 0) > maxFile) { r.box.checked = false; r.box.disabled = true; r.warn ||= `larger than the ${h.fmtSize(maxFile)} a shared file can be`; }

  const title = el("input", { type: "text", value: talk ? nameOf(talk.rel).replace(/\.tex$/i, "") : nameOf(h.folder.path), maxLength: 200 });
  const license = el("select");
  // (None given first, the default: what that means is CoCalc's policies, linked beside it)
  for (const [v, t] of [["", "None given"], ["CC-BY-4.0", "CC BY 4.0"], ["CC0-1.0", "CC0 (public domain)"], ["MIT", "MIT"], ["Apache-2.0", "Apache 2.0"]]) license.append(el("option", { value: v, textContent: t }));
  const list = el("div", { className: "rows" });
  list.setAttribute("role", "group");
  list.setAttribute("aria-label", "Files to include");
  for (const r of rows) {
    r.box.dataset.rel = r.f.rel;
    list.append(el("label", { className: "row" }, r.box, el("span", { textContent: r.f.rel }), el("span", { className: "size", textContent: r.f.notebook ? "notebook" : h.fmtSize(r.f.entry.size ?? 0) })));
    if (r.warn) list.append(el("div", { className: "warn", textContent: r.warn }));
  }
  const summary = el("p", { className: "note" });
  const upload = el("button", { type: "button", className: "primary", textContent: "Upload" });
  const progress = el("span", { className: "note" });
  const result = el("div", { className: "links" });
  const notes = el("p", { className: "note" });
  const out: string[] = [];
  if (plan.left.length) out.push("Not included: " + plan.left.map((l) => `${l.rel} (${l.why})`).join("; ") + ".");
  if (outsideRefs.length) out.push("Not included, as it names files outside its folder, which are never shared: " + outsideRefs.join(", ") + ".");
  if (unread.length) out.push("Not checked for keys (too large or unreadable): " + unread.join(", ") + ".");
  notes.textContent = out.join(" ");
  const ticked = () => rows.filter((r) => r.box.checked);
  const zipSaid = el("p", { className: "note" });
  // (a chapter, a link of its own: a notebook or a LaTeX document; for a document's share, the document and any other
  //  document ticked, never a part it \inputs (that is the document's, not a page of its own); the document first)
  const chapter = (f: { rel: string; notebook: boolean }) => f.notebook || (/\.tex$/i.test(f.rel) && (!talk || f.rel === talk.rel || !uses?.has(f.rel)));
  const firstTalk = (a: string, b: string) => (talk ? Number(b === talk.rel) - Number(a === talk.rel) : 0);
  const sum = () => {
    const t = ticked(), bytes = t.reduce((n, r) => n + (r.f.notebook ? 0 : r.f.entry.size ?? 0), 0);
    const over = left !== undefined && bytes > left;
    summary.textContent = `${t.length} of ${rows.length} files, ${h.fmtSize(bytes)} of data${left !== undefined ? ` (${h.fmtSize(Math.max(0, left))} left in your storage)` : ""}${over ? ": more than your storage has left" : ""}.` +
      (t.length && !t.some((r) => chapter(r.f)) ? " Tick a notebook or a LaTeX document: the share opens at one." : "");
    upload.disabled = busy || t.length === 0 || !t.some((r) => chapter(r.f)) || over;
  };
  list.addEventListener("change", sum);
  body.append(
    ...(talk ? [el("p", { className: "note", textContent: TALK_SCOPE })] : []),
    el("p", { className: "note", textContent: (talk ? "Publishes a copy of this document and the files it uses, with a link to it. " : "Publishes a copy of the folder's contents, with a link to each notebook and LaTeX document in it. ") + SHARE_OPEN }),
    el("p", { className: "note", textContent: SHARE_COPY }),
    ...(me.name || me.email ? [el("p", { className: "note", textContent: `Signed in to CoCalc as ${me.name || me.email}.` })] : []),
    el("label", { className: "f" }, "Title ", title),
    el("label", { className: "f" }, "License ", license, el("a", { href: POLICIES, target: "_blank", rel: "noopener", textContent: "What “None given” means" })),
    list, notes, summary, el("div", {}, upload, " ", ...(h.zip ? [zipButton(ticked, zipSaid), " "] : []), progress), zipSaid, result,
  );
  sum();
  status.textContent = rows.some((r) => r.warn) ? "Some files look like they hold a key or password: they are unticked. Tick one only if you are sure it is safe to publish." : "";

  const deps = {
    get: h.getShare, set: h.setShare, sent: h.sent(me.account_id), sentMax: h.sentMax, random: rand,
    upload: (o: any, p: any, opts: any) => uploadCollection(o, p, opts),
    attemptError: (e: unknown) => (e instanceof AttemptError ? { kind: e.kind, share: e.share } : null),
  };
  // (the files of the share's last version, for the chapter links it no longer has: read before uploading)
  const lastFiles = async (): Promise<string[] | null> => {
    try {
      const b = await h.getShare();
      if (!b?.share_id) return null;
      const r = await fetch(`/api/share/c/${encodeURIComponent(b.share_id)}`, { credentials: "same-origin" });
      if (!r.ok) return null;
      const files = (await r.json())?.manifest?.files;
      return Array.isArray(files) ? files.map((f: any) => String(f?.path ?? "")) : null;
    } catch {
      return null;
    }
  };
  upload.onclick = async () => {
    if (busy) return;
    busy = true;
    sum();
    result.textContent = "";
    progress.textContent = "Preparing…";
    try {
      if (talk) {
        try { await h.saveOpen(); } catch { progress.textContent = TALK_SAVE_FAILED; return; }
      } else await h.saveOpen().catch(() => {});
      const before = await lastFiles();
      const chosen = ticked().map((r) => r.f);
      const files: LazyFile[] = chosen.map((f) => f.notebook
        ? { path: f.rel, read: async () => new TextEncoder().encode(h.notebookText(await h.readNotebook(f.entry))) }
        : { path: f.rel, size: f.entry.size, read: () => h.readFile(f.entry) });
      const r = await shareFolderUpload({ title: title.value.trim() || nameOf(h.folder.path), license: license.value, files }, deps, (d, t) => { progress.textContent = t ? `Uploading… ${Math.round((100 * d) / t)}%` : "Uploading…"; });
      const chapters = chosen.filter(chapter).map((f) => f.rel).sort(firstTalk);
      progress.textContent = r.again ? "A new version is up, at the same links." : "Shared.";
      const copyAll = el("button", { type: "button", textContent: "Copy all links" });
      copyAll.onclick = () => void navigator.clipboard?.writeText(linksText(r.url, chapters)).then(() => { copyAll.textContent = "Copied"; });
      result.append(el("div", {}, el("a", { href: r.url, target: "_blank", rel: "noopener", textContent: r.url }), copyAll));
      for (const c of chapters) {
        const link = chapterLink(r.url, c), copy = el("button", { type: "button", textContent: "Copy" });
        copy.onclick = () => void navigator.clipboard?.writeText(link).then(() => { copy.textContent = "Copied"; });
        result.append(el("div", { className: "chapter" }, copy, el("a", { href: link, target: "_blank", rel: "noopener", textContent: c })));
      }
      const gone = goneChapters(before, chapters);
      if (gone.length) result.append(el("p", { className: "note", textContent: `These chapters' links no longer open them (renamed, removed or unticked): ${gone.join(", ")}.` }));
      const missing = rows.filter((x) => !x.box.checked).map((x) => x.f.rel);
      if (missing.length) result.append(el("p", { className: "note", textContent: `Not uploaded (unticked): ${missing.join(", ")}.` }));
    } catch (e) {
      progress.textContent = "";
      // (a message that says what happened and what to do next (`plain`: its share deleted, its record let go) stands alone)
      result.append(el("p", { className: "note", textContent: (e as any)?.plain ? String((e as Error).message) : "Not shared: " + String((e as Error)?.message ?? e) }));
    } finally {
      busy = false;
      sum();
    }
  };
  (window as any).sagebrush && ((window as any).sagebrush.shareFolderDialog = dlg);
  return closed;
}
