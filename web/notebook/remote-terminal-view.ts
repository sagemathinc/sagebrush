// A terminal on one of your computers (terminal addendum T1.4, build step T-3): its own chunk,
// sagebrush-remote-terminal.js (web/build.ts), loaded by the notebook page only when ⋯ ▸ Terminal on your computer…
// is chosen (offered with ?remote=1).  It lists your enrolled computers (GET /api/remote/v1/peers, kind "runner"),
// and draws one's shell in xterm (the @xterm/xterm 6.0 the console already ships, with @xterm/addon-fit), over the
// relay's terminal page leg (remote-terminal.js: the protocol, the page's DPoP key and proofs, credit and acks).
//
// xterm renders the runner's bytes as text into its own DOM in this page, so its escape-sequence parser is the trust
// boundary (terminals build plan r1, OUT-ISO).  Therefore:
// - no image or graphics addons (sixel, iTerm): only addon-fit, and the version is the lockfile's (6.0.0);
// - OSC 52 (clipboard writes) is swallowed: nothing in the output can write the clipboard;
// - a title (OSC 0/2) is text in the panel's header (textContent), never markup;
// - links, OSC 8 or a plain web address, are http(s) only, opened only on a click, in a new tab with noopener and
//   noreferrer (the page's own way to open a tab: board/page.ts, code/boot.ts);
// - nothing in the output is evaluated or set as HTML.
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import css from "@xterm/xterm/css/xterm.css" with { type: "text" };
import { RemoteTerminal, terminalKey } from "./remote-terminal.js";

// Ported from CoCalc packages/frontend/frame-editors/terminal-editor/connected-terminal.ts (SageMath, Inc.; relicensed by the copyright owner, Nov 7 2026)
// (lines 73-74 @2265acac; the other two constants there, the local history and the auto-response buffer, have no
// use here: the runner keeps the history and replays it)
const SCROLLBACK = 5000;

// Ported from CoCalc packages/frontend/frame-editors/terminal-editor/mobile-terminal-toolbar.tsx (SageMath, Inc.; relicensed by the copyright owner, Nov 7 2026)
// (KEYS, lines 35-44, and TOOLBAR_STYLE and BUTTON_STYLE, lines 16-33 @2265acac, as CSS)
const KEYS: { label: string; title: string; data: string }[] = [
  { label: "Esc", title: "Escape", data: "\x1b" },
  { label: "Tab", title: "Tab", data: "\x09" },
  { label: "^C", title: "Control+C", data: "\x03" },
  { label: "`", title: "Backtick", data: "`" },
  { label: "←", title: "Left arrow", data: "\x1b[D" },
  { label: "↑", title: "Up arrow", data: "\x1b[A" },
  { label: "↓", title: "Down arrow", data: "\x1b[B" },
  { label: "→", title: "Right arrow", data: "\x1b[C" },
];
const TOOLBAR_CSS = "align-items: center; background: rgba(248, 248, 248, 0.96); border-bottom: 1px solid #d9d9d9; display: flex; gap: 4px; min-height: 34px; overflow-x: auto; padding: 3px 6px; -webkit-overflow-scrolling: touch;";
const BUTTON_CSS = "flex: 0 0 auto; min-width: 34px; padding-left: 6px; padding-right: 6px;";

const PANEL_CSS = `
#rterm { position: fixed; left: 0; right: 0; bottom: 0; height: 42vh; min-height: 160px; display: flex; flex-direction: column; background: var(--code); border-top: 1px solid var(--line); box-shadow: 0 -4px 18px rgba(0,0,0,.12); z-index: 6; }
html.phone #rterm { bottom: calc(var(--bar-h, 56px) + var(--sb-preview-gutter, 0px)); height: 50vh; }
#rterm .rhead { display: flex; gap: 10px; align-items: center; padding: 4px 12px; font-size: 13px; color: var(--muted); flex: none; min-width: 0; }
#rterm .rhead b { color: var(--fg); white-space: nowrap; }
#rterm .rhead .rtitle { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
#rterm .rhead .sp { flex: 1; }
#rterm .rhead button { padding: 1px 8px; font-size: 12px; }
#rterm .rstatus { padding: 0 12px 4px; font-size: 13px; color: var(--fg); flex: none; }
#rterm .rstatus:empty { display: none; }
#rterm .rkeys { ${TOOLBAR_CSS} flex: none; }
#rterm .rkeys button { ${BUTTON_CSS} }
#rterm .rpick { padding: 6px 12px; display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
#rterm .rbody { flex: 1; min-height: 0; padding: 0 0 0 8px; }
`;

export interface Runner {
  remote_id: string;
  name: string;
}

/** Your enrolled computers: GET /api/remote/v1/peers (this site, its session cookie), kind "runner" only. */
export async function listRunners(f: typeof fetch = fetch): Promise<Runner[]> {
  const r = await f("/api/remote/v1/peers", { credentials: "same-origin", headers: { accept: "application/json" } });
  if (r.status === 401 || r.status === 403) throw new Error("sign in to use your computers");
  if (!r.ok) throw new Error(`this site can't list your computers (HTTP ${r.status})`);
  const j = await r.json().catch(() => null);
  const peers = Array.isArray(j?.peers) ? j.peers : [];
  return peers
    .filter((p: any) => p && p.kind === "runner" && typeof p.remote_id === "string" && p.remote_id.length > 0 && p.remote_id.length <= 200)
    .map((p: any) => ({ remote_id: p.remote_id, name: typeof p.name === "string" && p.name.trim() ? p.name.trim().slice(0, 80) : p.remote_id.slice(0, 12) }));
}

/** The relay's terminal page leg for a remote, on this site. */
export function pageLegUrl(remoteId: string, loc: { protocol: string; host: string } = location): string {
  return `${loc.protocol === "https:" ? "wss:" : "ws:"}//${loc.host}/api/remote/v1/page?${new URLSearchParams({ remote: remoteId, chan: "terminal" })}`;
}

/** An http(s) URL, as the absolute href to open, or null for anything else (javascript:, data:, file:, …). */
export function webHref(text: string): string | null {
  try {
    const u = new URL(text);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
}

function openWeb(text: string): void {
  const href = webHref(text);
  if (href) window.open(href, "_blank", "noopener,noreferrer");
}

// (plain web addresses in a line of the buffer: the link provider below; the closing punctuation of a sentence isn't part of one)
const WEB_RE = /https?:\/\/[^\s"'<>`]+/g;
export function webLinksIn(line: string): { start: number; text: string }[] {
  const out: { start: number; text: string }[] = [];
  for (const m of line.matchAll(WEB_RE)) {
    const text = m[0].replace(/[.,;:!?)\]}]+$/, "");
    if (webHref(text)) out.push({ start: m.index!, text });
  }
  return out;
}

const SESSION_KEY = (remoteId: string) => "sagebrush-rterm:" + remoteId;

export interface RemoteTerminalPanel {
  focus(): void;
  close(): void;
}

/**
 * The panel: first your computers to choose from (none to choose when there is one), then its terminal.  ✕ detaches
 * (the session keeps running on the computer, and this tab reattaches to it next time); End session stops it.
 */
export function openRemoteTerminal(o: { onEnd?: () => void; fetch?: typeof fetch; WebSocket?: any } = {}): RemoteTerminalPanel {
  if (!document.getElementById("xterm-css")) {
    const style = Object.assign(document.createElement("style"), { id: "xterm-css", textContent: css });
    document.head.appendChild(style);
  }
  if (!document.getElementById("rterm-css")) document.head.appendChild(Object.assign(document.createElement("style"), { id: "rterm-css", textContent: PANEL_CSS }));
  const el = (tag: string, props: Record<string, any> = {}) => Object.assign(document.createElement(tag), props);
  const panel = el("section", { id: "rterm" });
  panel.setAttribute("aria-label", "Terminal on your computer");
  const head = el("div", { className: "rhead" });
  const label = el("b", { textContent: "Terminal" });
  const title = el("span", { className: "rtitle" });
  const reconnectB = el("button", { type: "button", textContent: "Reconnect", hidden: true });
  const endB = el("button", { type: "button", textContent: "End session", hidden: true, title: "Stop this shell and everything it runs" });
  const closeB = el("button", { type: "button", textContent: "✕", title: "Close (the session keeps running on your computer)" });
  closeB.setAttribute("aria-label", "Close the terminal");
  head.append(label, title, el("span", { className: "sp" }), reconnectB, endB, closeB);
  const status = el("div", { className: "rstatus" });
  status.setAttribute("role", "status");
  const body = el("div", { className: "rbody" });
  panel.append(head, status, body);
  document.body.appendChild(panel);
  const say = (t: string) => { status.textContent = t; };

  let ended = false, term: Terminal | null = null, fit: FitAddon | null = null, client: RemoteTerminal | null = null, observer: ResizeObserver | null = null;
  let runner: Runner | null = null, keyP: Promise<any> | null = null;
  // (while the runner replays a session's past output, what xterm answers to that output's queries (a cursor position,
  // its attributes) is not sent: those were asked long ago.  Keys typed meanwhile still are, through onKey.)
  let replaying = false;

  const close = () => {
    if (ended) return;
    ended = true;
    client?.close();
    observer?.disconnect();
    term?.dispose();
    panel.remove();
    o.onEnd?.();
  };
  closeB.addEventListener("click", close);

  function connect(): void {
    if (!runner || !term || ended) return;
    const r = runner;
    reconnectB.hidden = true;
    say(`Connecting to ${r.name}…`);
    const session = sessionStorage.getItem(SESSION_KEY(r.remote_id)) ?? undefined;
    keyP ??= terminalKey();
    keyP.then((key) => {
      if (ended || runner !== r) return;
      const old = client;
      client = null; // (its own close isn't news)
      old?.close();
      let errored = false;
      const t: RemoteTerminal = new RemoteTerminal({
        url: pageLegUrl(r.remote_id), remoteId: r.remote_id, key, rows: term!.rows, cols: term!.cols, session,
        WebSocket: o.WebSocket,
        view: {
          // Ported from CoCalc packages/frontend/frame-editors/terminal-editor/connected-terminal.ts (SageMath, Inc.; relicensed by the copyright owner, Nov 7 2026)
          // (render, lines 1842-1872 @2265acac: output goes to xterm in arrival order through write's callback, which
          // is when it has been drawn: remote-terminal.js acks it then)
          write: (bytes: Uint8Array, done: () => void) => term!.write(bytes, done),
          reset: () => { replaying = true; },
          // (the replay's last bytes drawn, then one turn, as render's delay(0) before it counts down)
          live: () => term!.write(new Uint8Array(0), () => setTimeout(() => { if (client === t) replaying = false; }, 0)),
        },
        on: (e: any) => {
          if (client !== t || ended) return;
          if (e.t === "opened") {
            sessionStorage.setItem(SESSION_KEY(r.remote_id), e.session);
            endB.hidden = false;
            say("");
          } else if (e.t === "exit") {
            sessionStorage.removeItem(SESSION_KEY(r.remote_id));
            endB.hidden = true;
            reconnectB.textContent = "New session";
            reconnectB.hidden = false;
            say(`The shell ended${e.code != null ? ` (exit code ${e.code})` : e.signal ? ` (${e.signal})` : ""}.`);
          } else if (e.t === "elsewhere") {
            reconnectB.textContent = "Take it back";
            reconnectB.hidden = false;
            endB.hidden = true;
            say("This session was opened in another tab or window.");
          } else if (e.t === "error" && (e.error === "unknown_session" || e.error === "expired") && session) {
            // (the session this tab remembered is gone: a new one)
            sessionStorage.removeItem(SESSION_KEY(r.remote_id));
            connect();
          } else if (e.t === "error") {
            errored = true;
            say(`${r.name}: ${e.error}${e.reason ? ` (${String(e.reason).slice(0, 200)})` : ""}`);
          } else if (e.t === "closed" && !t.exited && !t.closedFor) {
            endB.hidden = true;
            reconnectB.textContent = "Reconnect";
            reconnectB.hidden = false;
            // (an error already said why)
            if (!errored) say(`Not connected to ${r.name}${e.why ? `: ${String(e.why).slice(0, 200)}` : ""}.`);
          }
        },
      });
      client = t;
      replaying = false;
      t.start();
    }, (err) => say(`The terminal's key couldn't be made: ${err?.message ?? err}`));
  }
  reconnectB.addEventListener("click", () => connect());
  endB.addEventListener("click", () => client?.kill());

  function start(r: Runner): void {
    runner = r;
    label.textContent = `Terminal · ${r.name}`;
    body.replaceChildren();
    if (matchMedia("(pointer: coarse)").matches || document.documentElement.classList.contains("phone")) {
      const row = el("div", { className: "rkeys" });
      row.setAttribute("role", "toolbar");
      row.setAttribute("aria-label", "Extra keys");
      for (const k of KEYS) {
        const b = el("button", { type: "button", textContent: k.label, title: k.title });
        b.setAttribute("aria-label", k.title);
        b.dataset.key = k.title;
        // (the button never takes the focus from the terminal, so a phone's keyboard stays up)
        b.addEventListener("pointerdown", (e: Event) => e.preventDefault());
        b.addEventListener("click", () => { client?.input(k.data); term?.focus(); });
        row.append(b);
      }
      panel.insertBefore(row, body);
    }
    term = new Terminal({
      fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
      fontSize: 14,
      cursorBlink: true,
      scrollback: SCROLLBACK,
      theme: themeFromCss(),
      // (OSC 8: http(s) only (allowNonHttpProtocols is false), opened on a click)
      linkHandler: { activate: (_e: MouseEvent, text: string) => openWeb(text), allowNonHttpProtocols: false },
    });
    // OSC 52, a clipboard write: swallowed (handled, so xterm does nothing more with it)
    term.parser.registerOscHandler(52, () => true);
    term.onTitleChange((t: string) => { title.textContent = t.slice(0, 120); });
    term.registerLinkProvider({
      provideLinks: (y: number, cb: (links: any[] | undefined) => void) => {
        const line = term!.buffer.active.getLine(y - 1)?.translateToString(true) ?? "";
        const links = webLinksIn(line).map((l) => ({
          text: l.text,
          range: { start: { x: l.start + 1, y }, end: { x: l.start + l.text.length, y } },
          activate: (_e: MouseEvent, text: string) => openWeb(text),
        }));
        cb(links.length ? links : undefined);
      },
    });
    // Ported from CoCalc packages/frontend/frame-editors/terminal-editor/connected-terminal.ts (SageMath, Inc.; relicensed by the copyright owner, Nov 7 2026)
    // (onKey / onData, lines 527-548 @2265acac: while output is being drawn, keys still go through onKey, or typing
    // "123456789" across the number row drops a "4".  There, it is while any output renders, because CoCalc's
    // terminals are collaborative; here, one tab holds a session, so it is only during the replay.)
    term.onKey(({ key }: { key: string }) => {
      if (!replaying) return;
      client?.input(key);
    });
    term.onData((data: string) => {
      if (replaying) return;
      client?.input(data);
    });
    term.onBinary((data: string) => {
      if (replaying) return;
      client?.input(Uint8Array.from(data, (c) => c.charCodeAt(0) & 0xff));
    });
    fit = new FitAddon();
    term.loadAddon(fit);
    term.open(body);
    fit.fit();
    term.onResize(({ rows, cols }: { rows: number; cols: number }) => client?.resize(rows, cols));
    observer = new ResizeObserver(() => { try { fit?.fit(); } catch {} });
    observer.observe(body);
    term.focus();
    connect();
  }

  say("Finding your computers…");
  listRunners(o.fetch ?? fetch).then((list) => {
    if (ended) return;
    if (!list.length) return say("None of your computers is set up for this. On one, run: sagebrush remote login");
    if (list.length === 1) return start(list[0]);
    say("Open a terminal on:");
    const pick = el("div", { className: "rpick" });
    for (const r of list) {
      const b = el("button", { type: "button", textContent: r.name });
      b.addEventListener("click", () => { say(""); start(r); });
      pick.append(b);
    }
    body.replaceChildren(pick);
    (pick.firstElementChild as HTMLElement | null)?.focus();
  }, (e) => { if (!ended) say(`Your computers: ${e?.message ?? e}`); });

  return {
    focus: () => { term ? term.focus() : (panel.querySelector(".rpick button") as HTMLElement | null)?.focus(); },
    close,
  };
}

// (the console's colors: web/console.ts)
function themeFromCss() {
  const v = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const dark = v("--scheme") === "dark";
  return {
    background: v("--code"),
    foreground: v("--fg"),
    cursor: v("--fg"),
    selectionBackground: dark ? "#3d4a3f" : "#cfe0c8",
    red: v("--err"),
    green: v("--accent"),
    ...(dark ? {} : { brightBlack: "#5d645f", white: "#5d645f" }),
  };
}
