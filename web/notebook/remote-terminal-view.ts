// A terminal on one of your computers (terminal addendum T1.4, build step T-3): its own chunk,
// sagebrush-remote-terminal.js (web/build.ts), loaded by the notebook page only when ⋯ ▸ Terminal on your computer…
// is chosen (offered with ?remote=1).  The site and the app serve it; the CLI's page doesn't (it can't reach a relay).  It lists your enrolled computers (GET /api/remote/v1/peers, kind "runner"),
// and draws one's shell in xterm (the @xterm/xterm 6.0 the console already ships, with @xterm/addon-fit), over the
// relay's terminal page leg (remote-terminal.js: the protocol, the page's DPoP key and proofs, credit and acks).
//
// xterm renders the runner's bytes as text into its own DOM in this page, so its escape-sequence parser is the trust
// boundary (terminals build plan r1, OUT-ISO): the rules are web/term/xterm-view.ts's, shared with the page's other
// terminals (no image addons; OSC 52 swallowed; the title as text in the panel's header; links http(s) only, on a click).
import { Terminal, FitAddon, TOOLBAR_CSS, BUTTON_CSS, ensureXtermCss, extraKeysRow, safeTerminal, themeFromCss } from "../term/xterm-view.ts";
import { RemoteTerminal, terminalKey } from "./remote-terminal.js";
import { listRunners, pageLegUrl as sharedLegUrl, type Runner } from "../workspace/remote-runners";

// (the module's own check of a link, under xterm's OSC 8 filter: the page test imports it from this chunk)
export { webHref, webLinksIn } from "../term/xterm-view.ts";

// Ported from CoCalc packages/frontend/frame-editors/terminal-editor/connected-terminal.ts (SageMath, Inc.; relicensed by the copyright owner, Nov 7 2026)
// (lines 73-74 @2265acac; the other two constants there, the local history and the auto-response buffer, have no
// use here: the runner keeps the history and replays it)
const SCROLLBACK = 5000;


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

// (your computers: the shared listing, web/workspace/remote-runners.ts, as the Agents page's Chat here uses it)
export { listRunners, type Runner } from "../workspace/remote-runners";

/** The relay's terminal page leg for a remote, on this site. */
export function pageLegUrl(remoteId: string, loc: { protocol: string; host: string } = location): string {
  return sharedLegUrl(remoteId, "terminal", loc);
}


// (the runner's errors, terminal.py, and the client's own, remote-terminal.js, in words: after the computer's name)
const ERRORS: Record<string, string> = {
  hello: "didn't accept a terminal. Its Sagebrush may predate terminals: update it, then Reconnect.",
  protocol: "sent something unexpected. Reconnect starts afresh.",
  spawn: "couldn't start a shell.",
  refused: "refused to open the terminal.",
  not_open: "has no terminal open on this connection. Reconnect.",
  expired: "ended this session.",
  // (remote-terminal.js: 2 pings to the relay unanswered)
  relay: "isn't answering: the connection went quiet. Reconnect.",
};

const SESSION_KEY = (remoteId: string) => "sagebrush-rterm:" + remoteId;

export interface RemoteTerminalPanel {
  /** the panel (the page puts it in front of, or behind, the console) */
  el: HTMLElement;
  focus(): void;
  /** the page's theme again (it changed): the console's colors, as web/console.ts setTheme */
  setTheme(): void;
  close(): void;
}

/**
 * The panel: first your computers to choose from (none to choose when there is one), then its terminal.  ✕ detaches
 * (the session keeps running on the computer, and this tab reattaches to it next time); End session stops it.
 */
export function openRemoteTerminal(o: { onEnd?: () => void; fetch?: typeof fetch; WebSocket?: any } = {}): RemoteTerminalPanel {
  ensureXtermCss();
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
            // (no reason after the relay's sentence: "no pong" is the event's and the close's, not a person's (board, #853))
            const why = e.reason && e.error !== "relay" ? ` (${String(e.reason).slice(0, 200)})` : "";
            // (the session limit is the runner's own number, terminal.py TERMINAL_LIMITS)
            const text = e.error === "sessions" ? `already runs ${e.limit == null ? "as many terminals as it allows" : e.limit === 1 ? "1 terminal" : `${e.limit} terminals`}. End one there, then Reconnect.` : ERRORS[e.error];
            say(text ? `${r.name} ${text}${why}` : `${r.name}: ${String(e.error).slice(0, 60)}${why}`);
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
    }, (err) => say(`The terminal couldn't start in this browser: ${err?.message ?? err}`));
  }
  reconnectB.addEventListener("click", () => connect());
  endB.addEventListener("click", () => client?.kill());

  function start(r: Runner): void {
    runner = r;
    label.textContent = `Terminal · ${r.name}`;
    body.replaceChildren();
    const row = extraKeysRow("rkeys", (data) => client?.input(data), () => term?.focus());
    if (row) panel.insertBefore(row, body);
    term = safeTerminal({ scrollback: SCROLLBACK, onTitle: (t) => { title.textContent = t; } });
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
    el: panel,
    setTheme: () => { if (term) term.options.theme = themeFromCss(); },
    focus: () => { term ? term.focus() : (panel.querySelector(".rpick button") as HTMLElement | null)?.focus(); },
    close,
  };
}
