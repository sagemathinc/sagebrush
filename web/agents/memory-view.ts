// The Memory view (agent memory v1, the memory v1 protocol §7.3, to land in design/workspace-agent-protocol.md; lane
// C2): the notes the paired agent may use, in place of the chat, as a task's view is. It lists them by place (the
// agent's own, each tag the grant allows), searches them (the agent's plain substring over name, description and
// text), and opens one: its text, then Edit, Delete, Renew (90 days from now) and, for a note changed outside
// Sagebrush, Accept. Every request goes over this tab's pairing (memory.*), every answer is checked closed
// (memory-schema.ts), and note text is shown as text only and never kept by the page. The view is only in the tab
// whose agent is connected here with memory: another tab says so, and so does a lost connection. Tag names are this
// browser's (memory-tags.ts): a tag it hasn't named shows its id, with Name this tag.
import type { AgentPairing } from "../workspace/agent-pair";
import { grantMemory } from "../workspace/agent-grant";
import { TaskClient } from "../workspace/tasks-client";
import { MEMORY_FEATURE, MEMORY_LIMITS, MEMORY_RESULTS, MemoryShapeError, type Note, type NoteEntry, type Scope } from "../workspace/memory-schema";
import { expiresText } from "../workspace/agent-chat/view";
import { listTags, nameTag, tagName } from "./memory-tags";

export const VIEW_COPY = {
  button: "Memory…",
  title: "Memory",
  back: "← Back to chats",
  help: (path: string | null) =>
    `These are the notes this agent may use: its own, and those of the tags you allowed. They're kept on this computer${path ? `, in ${path}` : ""}. ` +
    "Reading and searching them here sends them nowhere. A note the agent reads in a turn goes to its model provider with that turn. " +
    "Notes expire 90 days after they're saved or renewed; reading them doesn't renew them. " +
    "When you connect your own Claude Code instead (a native session), it doesn't use these notes: it keeps its own memory, which isn't shown here. " +
    "Tag names are kept in this browser only: another browser shows a tag's id until you name it there.",
  noAgent: "Connect your agent to see the notes it may use.",
  noFeature: "This agent doesn't keep notes.",
  notGranted: "Memory isn't turned on for this agent. Turn it on in the agent's access: Notes it may use.",
  link: "Memory isn't available over this connection yet: it opens with an agent on this computer.",
  otherTab: "Memory is open in your other tab.",
  lost: (agent: string) => `Memory isn't available: ${agent} isn't connected (its computer may be asleep). It opens again when the agent is back.`,
  all: "All notes",
  own: "This agent's own notes",
  tag: (name: string) => `Tag ${name}`,
  search: "Search names, descriptions and text",
  empty: "No notes.",
  more: "More",
  usage: (used: string, limit: string) => `${used} of ${limit} used`,
  warn80: "Your notes are over 80% of their room.",
  warn90: "Your notes are over 90% of their room: new notes will be refused when it's full.",
  states: { ok: "", expired: "Expired", outside_edit: "Changed outside Sagebrush", invalid: "Unreadable" } as Record<string, string>,
  outsideEdit: "This note was changed outside Sagebrush, so the agent doesn't read it until you accept it as it is now.",
  invalid: "This note's file can't be read, so the agent never reads it. Delete it, or fix the file.",
  expired: "This note has expired, so the agent no longer reads it. Renew it to use it again.",
  from: (who: string) => `Proposed by ${who}`,
  edit: "Edit…",
  del: "Delete",
  renew: "Renew for 90 days",
  accept: "Accept as it is",
  nameTag: "Name this tag",
  rename: "Rename tag",
  delTitle: "Delete this note?",
  delBody: "The agent stops reading it at once. It stays in the notes' history on this computer.",
  saved: "Saved.",
  deleted: "Deleted.",
  renewed: "Renewed for 90 days.",
  accepted: "Accepted.",
  stale: "This note changed since you opened it. Here it is as it is now.",
  gone: "This note isn't there any more.",
  secret: "This note looks like it holds a secret (a key, token or password), so it wasn't saved. Take it out and try again.",
  full: "Your notes are full, so this wasn't saved. Delete or shorten some notes, then try again.",
  conflict: "A note with that name is already there. Choose another name.",
  long: "This note is too long. Shorten it.",
  unread: "The agent's answer couldn't be read. It may have gone through: try again to see, or check the list.",
  busy: "Wait for the last change to finish.",
  unreadDecision: "The agent's answer couldn't be read. It may have gone through: the note is shown as it is now.",
  loading: "Loading…",
  editStale: "This note changed while you were editing it. It's shown as it is now behind this; your text is kept here. Save again to replace it.",
  failed: "That didn't work",
  readFailed: "The notes couldn't be read",
  tagName: "Name for this tag (lowercase letters, digits and dashes)",
  tagBad: "That name can't be used: lowercase letters, digits and dashes, up to 32, and not a reserved word.",
  tagTaken: "Another tag here has that name.",
  tagStorage: "This browser couldn't keep the name.",
} as const;

export interface MemoryViewHost {
  pairing(): AgentPairing | null;
  /** the agent's name, for the lost line */
  agent(): string;
  toast(text: string, ms?: number): void;
  /** the view is shown or not: the page hides the chat and its composer (and closes a task's view or a mirror) */
  shown(on: boolean): void;
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] => {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids);
  return e;
};
const hex = (n: number) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => b.toString(16).padStart(2, "0")).join("");
const kb = (n: number) => (n < 1024 * 1024 ? `${n === 0 ? 0 : Math.max(1, Math.round(n / 1024))} KB` : `${(n / (1024 * 1024)).toFixed(1)} MB`);
const DAY = 24 * 3600 * 1000;
const scopeKey = (s: Scope) => (s === "own" ? "own" : "tag:" + s.tag);
const tagLabel = (id: string) => tagName(id) ?? id;
const scopeLabel = (s: Scope) => (s === "own" ? VIEW_COPY.own : VIEW_COPY.tag(tagLabel(s.tag)));

// (the tab whose agent is connected with memory says so to this browser's other tabs: theirs then say where it is.
//  Display only: any page of this origin could post here, but a tab's own memory never depends on what it hears, and
//  nothing is sent on the channel but these words)
const CHANNEL = "sb-memory-view-v1";

export function mountMemoryView(h: MemoryViewHost) {
  const btn = el("button", { id: "memory-btn", type: "button", hidden: true, title: "The notes your agent may use" }, VIEW_COPY.button);
  document.querySelector("#files-big")?.before(btn);
  const view = el("section", { id: "memory-view", hidden: true, ariaLabel: VIEW_COPY.title });
  document.querySelector("main .composer-wrap")?.before(view);

  // (the view's parts, made once: a redraw fills them, and never replaces the controls, so typing in the search keeps
  //  its place and focus)
  const back = el("button", { type: "button", className: "link", textContent: VIEW_COPY.back });
  const head = el("div", { className: "memory-head" }, back, el("h2", { textContent: VIEW_COPY.title }));
  const why = el("p", { className: "memory-unavailable", role: "status" });
  const help = el("p", { className: "memory-help" });
  const usageLine = el("p", { className: "memory-usage" });
  const scopeSel = el("select", { name: "memory-scope" });
  const search = el("input", { type: "search", name: "memory-search", placeholder: VIEW_COPY.search, maxLength: MEMORY_LIMITS.query });
  const controls = el("div", { className: "memory-controls" }, scopeSel, search);
  const tagsBox = el("div", { className: "memory-tags" });
  const errLine = el("p", { className: "msg", role: "alert" });
  const listBox = el("div", { className: "memory-rows" });
  const more = el("button", { type: "button", className: "link", textContent: VIEW_COPY.more });
  const listPart = el("div", { className: "memory-list" }, controls, tagsBox, errLine, listBox, more);
  const notePart = el("div", { className: "memory-open" });
  view.append(head, why, help, usageLine, listPart, notePart);

  let open = false;
  let otherTab = false;
  let filter = "all";
  let query = "";
  let notes: NoteEntry[] = [];
  let next: string | null = null;
  let usage: { bytes: number; limit: number } | null = null;
  let path = "";
  let readError = "";
  let shownNote: Note | null = null;
  let loading = 0;
  let opening = 0;
  // (the first listing answered since the view opened or memory changed: until then, Loading…)
  let listed = false;
  // (what the rows and the open note were last drawn from: drawn again only when that changes, so focus and a
  //  selection in them stay while the pairing says other things)
  let notesVer = 0;
  let drawnRows = "";
  let drawnNote = "";
  // (dialogs open on a note: closed when what they were for goes)
  const dialogs = new Set<HTMLDialogElement>();
  // (one change at a time per note: its buttons wait for the answer)
  const busy = new Set<string>();
  // (a decision's id, kept only to send the very same request again after its answer was lost: the agent keeps each
  //  id's request and answer (§6.1); after any answer it could read, a new decision gets a new id. Renew's expiry is
  //  kept with it, so a retry is the same request)
  const decisions = new Map<string, { key: string; id: string; renew?: { revision: number; expires: number } }>();
  const LOST = new Set(["timeout", "closed"]);
  const unreadable = (e: unknown) => e instanceof MemoryShapeError || (e as { extra?: { answer?: unknown } })?.extra?.answer === true;
  const lost = (e: unknown) => unreadable(e) || LOST.has((e as { code?: string })?.code ?? "");

  // ---- where memory is
  const p = () => h.pairing();
  const here = () => {
    const x = p();
    return !!x && x.state === "granted" && !x.link && !!x.hello?.features?.includes(MEMORY_FEATURE) && !!grantMemory(x.grant);
  };
  const grantedTags = () => grantMemory(p()?.grant ?? null)?.tags ?? [];
  let bc: BroadcastChannel | null = null;
  try { bc = new BroadcastChannel(CHANNEL); } catch { bc = null; }
  let otherTimer = 0;
  bc?.addEventListener("message", (e) => {
    const m = e.data as { kind?: unknown } | null;
    if (m?.kind === "ask" && here()) bc!.postMessage({ kind: "here" });
    else if (m?.kind === "here") { otherTab = true; clearTimeout(otherTimer); otherTimer = window.setTimeout(() => { otherTab = false; render(); }, 25000); render(); }
    else if (m?.kind === "gone") { otherTab = false; clearTimeout(otherTimer); render(); }
  });
  let wasHere = false;
  // (memory was here in this tab, and the connection was lost (not ended by the person): said as such)
  let wasEverHere = false;
  const announce = () => {
    const now = here();
    if (now !== wasHere) bc?.postMessage({ kind: now ? "here" : "gone" });
    wasHere = now;
  };
  // (a tab that has memory says so now and then, so a tab opened later learns it without asking)
  window.setInterval(() => { if (here()) bc?.postMessage({ kind: "here" }); }, 10000);
  addEventListener("pagehide", () => { if (wasHere) bc?.postMessage({ kind: "gone" }); });
  // (a tab opened while another has memory: asked at once, so its Memory button and line say where it is)
  bc?.postMessage({ kind: "ask" });

  /** Why the view can't show the notes now, in the page's words, or null when it can. */
  function unavailable(): string | null {
    const x = p();
    if (x?.link) return VIEW_COPY.link;
    if (here()) return null;
    if (otherTab) return VIEW_COPY.otherTab;
    // (not connected now (closed, or trying again after a loss): lost, if memory was here in this tab)
    if (!x || x.state !== "granted") return wasEverHere ? VIEW_COPY.lost(h.agent()) : VIEW_COPY.noAgent;
    if (!x.hello?.features?.includes(MEMORY_FEATURE)) return VIEW_COPY.noFeature;
    return VIEW_COPY.notGranted;
  }
  // (what the listing depends on: memory here or not, the pairing, and the grant's tags. Only a change of these lists
  //  again, and drops what was shown from before)
  let shownFor = "";
  const keyNow = () => (here() ? JSON.stringify([pairingId(p()), grantedTags()]) : "");
  const ids = new WeakMap<object, string>();
  function pairingId(x: object | null): string {
    if (!x) return "";
    let id = ids.get(x);
    if (!id) ids.set(x, (id = hex(8)));
    return id;
  }
  function reset() {
    notes = [];
    notesVer++;
    next = null;
    usage = null;
    path = "";
    readError = "";
    shownNote = null;
    listed = false;
    busy.clear(); // (a request still out on the earlier pairing answers to no one)
    opening++;
    loading++;
    for (const d of [...dialogs]) d.close();
  }

  // ---- requests
  async function request(method: string, params: Record<string, unknown>) {
    const x = p();
    if (!x) throw Object.assign(new Error("the agent isn't connected"), { code: "closed" });
    return TaskClient.of(x).request(method, params);
  }
  /** A decision (edit, delete, accept): its id kept only across a lost answer, and dropped once an answer is read. */
  async function decide(note: string, method: "memory.edit" | "memory.delete" | "memory.accept", params: Record<string, unknown>) {
    const key = JSON.stringify([method, params]);
    const kept = decisions.get(note);
    const decision_id = kept?.key === key ? kept.id : hex(16);
    decisions.set(note, { key, id: decision_id, ...(kept?.renew ? { renew: kept.renew } : {}) });
    try {
      const r = MEMORY_RESULTS[method](await request(method, { note, ...params, decision_id }));
      decisions.delete(note);
      return r;
    } catch (e) {
      if (!lost(e)) decisions.delete(note);
      throw e;
    }
  }
  function refused(e: unknown) {
    const code = (e as { code?: string })?.code;
    if (unreadable(e)) return h.toast(VIEW_COPY.unread, 8000);
    h.toast(
      code === "secret" ? VIEW_COPY.secret : code === "full" ? VIEW_COPY.full : code === "conflict" ? VIEW_COPY.conflict : code === "too_large" ? VIEW_COPY.long
        : code === "stale" ? VIEW_COPY.stale : code === "not_found" ? VIEW_COPY.gone : `${VIEW_COPY.failed}: ${(e as Error)?.message ?? e}`,
      8000,
    );
  }

  async function load(more = false) {
    if (unavailable()) return render();
    if (more && !next) return;
    const ticket = ++loading;
    const params: Record<string, unknown> = {};
    if (filter !== "all") params.scope = filter === "own" ? "own" : { tag: filter.slice(4) };
    if (query) params.query = query.slice(0, MEMORY_LIMITS.query);
    if (more && next) params.after = next;
    try {
      const r = MEMORY_RESULTS["memory.list"](await request("memory.list", params));
      if (ticket !== loading) return; // (a later listing was asked for meanwhile: its answer is the one shown)
      notes = more ? [...notes, ...r.notes] : r.notes;
      notesVer++;
      listed = true;
      next = r.next;
      usage = r.usage;
      path = r.path;
      readError = "";
    } catch (e) {
      if (ticket !== loading) return;
      listed = true;
      readError = unreadable(e) ? VIEW_COPY.unread : `${VIEW_COPY.readFailed}: ${(e as Error)?.message ?? e}`;
    }
    render();
  }
  /** A note opened: shown once its answer comes, unless the person has moved on meanwhile. */
  async function openNote(note: string): Promise<Note | null> {
    const ticket = ++opening;
    let got: Note | null = null;
    try {
      got = MEMORY_RESULTS["memory.get"](await request("memory.get", { note }));
    } catch (e) {
      if (ticket !== opening) return null;
      shownNote = null;
      refused(e);
      void load();
      return null;
    }
    if (ticket !== opening || !open) return null;
    shownNote = got;
    render();
    return got;
  }
  function toList() {
    opening++;
    shownNote = null;
    render();
    void load();
  }
  // (after a change: the note again, as the agent has it now, or the list; only if the person is still where they
  //  were when they asked (`at`): one who has moved on is told, and stays)
  async function after(acted: string, note: string | null, said: string, at: number) {
    h.toast(said, 4000);
    if (!open) return;
    // (moved on, and back on that same note: it's shown again as it is now, its buttons free)
    if (opening !== at && shownNote?.note !== acted) { if (!shownNote) void load(); else render(); return; }
    if (note) await openNote(note);
    else toList();
  }
  async function act(n: Note, what: "renew" | "delete" | "accept") {
    if (busy.has(n.note)) return h.toast(VIEW_COPY.busy, 3000);
    if (what === "delete" && !(await confirm(VIEW_COPY.delTitle, VIEW_COPY.delBody, VIEW_COPY.del))) return;
    if (busy.has(n.note)) return h.toast(VIEW_COPY.busy, 3000);
    const at = opening;
    busy.add(n.note);
    render();
    try {
      if (what === "renew") {
        // (a retry after a lost answer is the same request: the expiry it asked for is kept with its id, for that
        //  revision only)
        const kept = decisions.get(n.note);
        const expires = kept?.renew?.revision === n.revision ? kept.renew.expires : Date.now() + 90 * DAY;
        decisions.set(n.note, { key: kept?.key ?? "", id: kept?.id ?? "", renew: { revision: n.revision, expires } });
        await decide(n.note, "memory.edit", { revision: n.revision, expires });
        busy.delete(n.note);
        await after(n.note, n.note, VIEW_COPY.renewed, at);
      } else if (what === "accept") {
        await decide(n.note, "memory.accept", { revision: n.revision });
        busy.delete(n.note);
        await after(n.note, n.note, VIEW_COPY.accepted, at);
      } else {
        await decide(n.note, "memory.delete", { revision: n.revision });
        busy.delete(n.note);
        await after(n.note, null, VIEW_COPY.deleted, at);
      }
    } catch (e) {
      busy.delete(n.note);
      const code = (e as { code?: string })?.code;
      const stay = !open || (opening !== at && shownNote?.note !== n.note);
      // (an answer that couldn't be read may have gone through, and asking again gets the same answer: the note is
      //  shown as it is now)
      if (unreadable(e)) { h.toast(VIEW_COPY.unreadDecision, 8000); if (!stay) await openNote(n.note); else render(); return; }
      refused(e);
      if (stay) render();
      else if (code === "stale") await openNote(n.note);
      else if (code === "not_found") toList();
      else render();
    }
  }

  // ---- dialogs
  function confirm(title: string, body: string, ok: string): Promise<boolean> {
    const dlg = el("dialog", { className: "memory-dlg" });
    const form = el("form", { method: "dialog" }, el("h3", { textContent: title }), el("p", { textContent: body }),
      el("menu", {}, el("button", { value: "cancel", textContent: "Cancel" }), " ", el("button", { value: "ok", className: "primary", textContent: ok })));
    dlg.append(form);
    document.body.append(dlg);
    dialogs.add(dlg);
    dlg.showModal();
    return new Promise((resolve) => dlg.addEventListener("close", () => { dialogs.delete(dlg); resolve(dlg.returnValue === "ok"); dlg.remove(); }, { once: true }));
  }
  function editNote(first: Note) {
    if (busy.has(first.note)) return h.toast(VIEW_COPY.busy, 3000);
    // (the note as last read: a stale answer reads it again, and the person's text stays in the dialog)
    let n = first;
    const tags = grantedTags();
    const dlg = el("dialog", { className: "memory-edit" });
    const name = el("input", { name: "name", value: n.name, maxLength: MEMORY_LIMITS.name });
    const description = el("input", { name: "description", value: n.description, maxLength: MEMORY_LIMITS.description });
    const body = el("textarea", { name: "body", value: n.body, rows: 10 });
    const where = el("select", { name: "scope" });
    where.append(el("option", { value: "own", textContent: VIEW_COPY.own }), ...tags.map((t) => el("option", { value: "tag:" + t, textContent: VIEW_COPY.tag(tagLabel(t)) })));
    where.value = scopeKey(n.scope);
    // (a place the grant no longer has isn't offered: the person chooses again)
    if (where.value !== scopeKey(n.scope)) { where.prepend(el("option", { value: "", textContent: "Choose…", disabled: true })); where.value = ""; }
    const msg = el("p", { className: "msg", role: "alert" });
    const ok = el("button", { type: "button", className: "primary", textContent: "Save" });
    const cancel = el("button", { type: "button", textContent: "Cancel", onclick: () => dlg.close() });
    dialogs.add(dlg);
    dlg.append(el("h2", { textContent: "Edit the note" }), el("label", {}, "Name", name), el("label", {}, "Description (one line)", description), el("label", {}, "Note", body), el("label", {}, "Where", where), msg, el("menu", {}, cancel, ok));
    dlg.addEventListener("close", () => { dialogs.delete(dlg); dlg.remove(); }, { once: true });
    ok.onclick = async () => {
      if (!where.value) return h.toast("Choose where to keep this note.", 5000);
      if (busy.has(n.note)) return h.toast(VIEW_COPY.busy, 3000);
      // (only what changed from the note as read is sent: the agent keeps the rest as it is)
      const change: Record<string, unknown> = { revision: n.revision };
      const nm = name.value.trim(), ds = description.value.trim();
      if (nm !== n.name) change.name = nm;
      if (ds !== n.description) change.description = ds;
      if (body.value !== n.body) change.body = body.value;
      if (where.value !== scopeKey(n.scope)) change.scope = where.value === "own" ? "own" : { tag: where.value.slice(4) };
      if (Object.keys(change).length === 1) return dlg.close();
      ok.disabled = true;
      busy.add(n.note);
      try {
        const at = opening;
        const r = (await decide(n.note, "memory.edit", change)) as { note: string; revision: number };
        busy.delete(n.note);
        dlg.close();
        await after(n.note, r.note, VIEW_COPY.saved, at);
      } catch (e) {
        busy.delete(n.note);
        const code = (e as { code?: string })?.code;
        // (a reset closed the dialog meanwhile: said, and nothing else moves)
        if (!dialogs.has(dlg)) { refused(e); return; }
        if (code === "stale" || unreadable(e)) {
          // (changed at the agent, or an answer that couldn't be read (it may have gone through; asking again would get
          //  the same answer): the dialog stays with the person's text, and the note behind it is read again. A field
          //  the person didn't change takes the note's new value, so Save again sends only their own changes)
          if (unreadable(e)) decisions.delete(n.note);
          const fresh = await openNote(n.note);
          if (fresh && dialogs.has(dlg)) {
            if (name.value.trim() === n.name) name.value = fresh.name;
            if (description.value.trim() === n.description) description.value = fresh.description;
            if (body.value === n.body) body.value = fresh.body;
            if (where.value === scopeKey(n.scope) && [...where.options].some((o) => o.value === scopeKey(fresh.scope))) where.value = scopeKey(fresh.scope);
            n = fresh;
            msg.textContent = unreadable(e) ? VIEW_COPY.unreadDecision : VIEW_COPY.editStale;
          } else if (dialogs.has(dlg)) msg.textContent = VIEW_COPY.readFailed; // (the note couldn't be read again: the text stays)
        } else if (code === "not_found") {
          refused(e);
          dlg.close();
          toList();
        } else refused(e); // (a refusal the person can fix (a secret, a name, the size) keeps the dialog and its text)
      } finally {
        ok.disabled = false;
      }
    };
    document.body.append(dlg);
    dlg.showModal();
    body.focus();
  }
  function nameDialog(id: string) {
    const dlg = el("dialog", { className: "memory-dlg" });
    const input = el("input", { name: "tag-name", value: tagName(id) ?? "", maxLength: 32 });
    const msg = el("p", { className: "msg", role: "alert" });
    const ok = el("button", { type: "button", className: "primary", textContent: "Save" });
    dlg.append(el("h3", { textContent: tagName(id) ? VIEW_COPY.rename : VIEW_COPY.nameTag }), el("p", { className: "tag-id", textContent: id }), el("label", {}, VIEW_COPY.tagName, input), msg,
      el("menu", {}, el("button", { type: "button", textContent: "Cancel", onclick: () => dlg.close() }), " ", ok));
    dlg.addEventListener("close", () => dlg.remove(), { once: true });
    ok.onclick = () => {
      const r = nameTag(id, input.value.trim());
      if (r.ok === false) { const why = (r as { why: string }).why; msg.textContent = why === "taken" ? VIEW_COPY.tagTaken : why === "storage" ? VIEW_COPY.tagStorage : VIEW_COPY.tagBad; return; }
      dlg.close();
      drawTags(true);
      render();
    };
    document.body.append(dlg);
    dlg.showModal();
    input.focus();
  }

  // ---- the controls (their handlers once)
  back.onclick = () => close();
  scopeSel.onchange = () => { filter = scopeSel.value; next = null; void load(); };
  let typing = 0;
  search.oninput = () => { clearTimeout(typing); typing = window.setTimeout(() => { query = search.value; next = null; void load(); }, 250); };
  more.onclick = () => void load(true);
  // (the place choices and the tag lines: drawn again only when the granted tags or their names change)
  let tagsDrawn = "";
  function drawTags(force = false) {
    const tags = grantedTags();
    const sig = JSON.stringify(tags.map((t) => [t, tagName(t)]));
    if (sig === tagsDrawn && !force) return;
    tagsDrawn = sig;
    scopeSel.replaceChildren(el("option", { value: "all", textContent: VIEW_COPY.all }), el("option", { value: "own", textContent: VIEW_COPY.own }), ...tags.map((t) => el("option", { value: "tag:" + t, textContent: VIEW_COPY.tag(tagLabel(t)) })));
    scopeSel.value = filter;
    if (scopeSel.value !== filter) { filter = "all"; scopeSel.value = "all"; }
    // (a granted tag this browser hasn't named: its id, and Name this tag; a named one: Rename)
    tagsBox.replaceChildren(...tags.map((t) => {
      const row = el("div", { className: "memory-tag" }, el("span", { textContent: VIEW_COPY.tag(tagLabel(t)) }), " ",
        el("button", { type: "button", className: "link", textContent: tagName(t) ? VIEW_COPY.rename : VIEW_COPY.nameTag, onclick: () => nameDialog(t) }));
      row.dataset.tag = t;
      return row;
    }));
    tagsBox.hidden = !tags.length;
  }

  // ---- drawing
  function show() {
    open = true;
    h.shown(true);
    // (another tab may have memory: asked, and its answer redraws)
    if (!here()) bc?.postMessage({ kind: "ask" });
    sync(true);
  }
  function close() {
    if (!open) return;
    open = false;
    opening++;
    shownNote = null;
    view.hidden = true;
    h.shown(false);
    render();
  }
  btn.onclick = () => (open ? close() : show());

  function render() {
    announce();
    if (here()) wasEverHere = true;
    const x = p();
    // (the button: where an agent offering memory is connected, or another tab has it, or it was here and is lost)
    btn.hidden = !(here() || otherTab || wasEverHere || !!x?.hello?.features?.includes(MEMORY_FEATURE));
    btn.classList.toggle("on", open);
    if (!open) { view.hidden = true; return; }
    view.hidden = false;
    const w = unavailable();
    why.textContent = w ?? "";
    why.hidden = !w;
    help.hidden = usageLine.hidden = listPart.hidden = notePart.hidden = !!w;
    // (nothing of the notes stays in the page while they can't be shown)
    if (w) { listBox.replaceChildren(); notePart.replaceChildren(); drawnRows = drawnNote = ""; return; }
    help.textContent = VIEW_COPY.help(path || null);
    if (usage) {
      const share = usage.bytes / usage.limit;
      usageLine.className = "memory-usage" + (share >= 0.9 ? " warn90" : share >= 0.8 ? " warn80" : "");
      usageLine.replaceChildren(VIEW_COPY.usage(kb(usage.bytes), kb(usage.limit)));
      if (share >= 0.8) usageLine.append(" ", el("b", { textContent: share >= 0.9 ? VIEW_COPY.warn90 : VIEW_COPY.warn80 }));
    }
    usageLine.hidden = !usage;
    listPart.hidden = !!shownNote;
    notePart.hidden = !shownNote;
    if (shownNote) return drawNote(shownNote);
    drawTags();
    errLine.textContent = readError;
    errLine.hidden = !readError;
    more.hidden = !next;
    const rowsSig = JSON.stringify([notesVer, listed, tagsDrawn, !!readError]);
    if (rowsSig === drawnRows) return;
    drawnRows = rowsSig;
    if (!listed) return void listBox.replaceChildren(el("p", { className: "memory-empty", textContent: VIEW_COPY.loading }));
    // (a listing that failed with nothing shown: its error only, never "No notes")
    if (readError && !notes.length) return void listBox.replaceChildren();
    listBox.replaceChildren(...(notes.length ? notes.map((n) => {
      const b = el("button", { type: "button", className: "memory-note" + (n.state !== "ok" ? " " + n.state : "") },
        el("span", { className: "n", textContent: n.name }),
        el("span", { className: "d", textContent: n.description }),
        el("small", { textContent: [scopeLabel(n.scope), kb(n.bytes), expiresText(n.expires), VIEW_COPY.states[n.state], n.proposed_by ? VIEW_COPY.from(n.proposed_by) : ""].filter(Boolean).join(" · ") }));
      b.dataset.note = n.note;
      b.onclick = () => void openNote(n.note);
      return b;
    }) : [el("p", { className: "memory-empty", textContent: VIEW_COPY.empty })]));
  }

  function drawNote(n: Note) {
    const sig = JSON.stringify([n, busy.has(n.note), tagsDrawn]);
    if (sig === drawnNote) return;
    drawnNote = sig;
    notePart.dataset.note = n.note;
    const toAll = el("button", { type: "button", className: "link", textContent: "← All notes", onclick: () => toList() });
    const actions = el("menu", { className: "memory-actions" });
    const working = busy.has(n.note);
    const btnOf = (label: string, what: string, fn: () => void) => { const b = el("button", { type: "button", textContent: label, onclick: fn, disabled: working }); b.dataset.act = what; return b; };
    if (n.state !== "invalid") actions.append(btnOf(VIEW_COPY.edit, "edit", () => editNote(n)));
    if (n.expires !== null || n.state === "expired") actions.append(btnOf(VIEW_COPY.renew, "renew", () => void act(n, "renew")));
    if (n.state === "outside_edit") actions.append(btnOf(VIEW_COPY.accept, "accept", () => void act(n, "accept")));
    actions.append(btnOf(VIEW_COPY.del, "delete", () => void act(n, "delete")));
    notePart.replaceChildren(
      toAll,
      el("h3", { textContent: n.name }),
      el("p", { className: "d", textContent: n.description }),
      el("p", { className: "where", textContent: [scopeLabel(n.scope), expiresText(n.expires), VIEW_COPY.states[n.state]].filter(Boolean).join(" · ") }),
      ...(n.state === "outside_edit" ? [el("p", { className: "note-state", textContent: VIEW_COPY.outsideEdit })] : []),
      ...(n.state === "invalid" ? [el("p", { className: "note-state", textContent: VIEW_COPY.invalid })] : []),
      ...(n.state === "expired" ? [el("p", { className: "note-state", textContent: VIEW_COPY.expired })] : []),
      el("pre", { className: "mem-body", textContent: n.body }),
      actions);
  }

  /** Drawn again for where memory is now; listed again only when what the listing depends on changed (or asked). */
  function sync(relist = false) {
    const x = p();
    // (the person ended the connection: not "lost")
    if (x?.state === "closed" && (x.closeReason === "revoked by the person" || x.closeReason === "the grant expired")) wasEverHere = false;
    const key = keyNow();
    if (key !== shownFor) {
      shownFor = key;
      reset();
      relist = true;
    }
    render();
    if (open && relist && key) void load();
  }

  return {
    render,
    close,
    showing: () => open,
    /** The pairing changed (connected, lost, its grant, or anything else it says): drawn again, listed again only if
     *  memory, the pairing or the granted tags changed. */
    changed: () => sync(),
  };
}
