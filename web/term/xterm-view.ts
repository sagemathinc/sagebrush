// The page's xterm setup, shared by its terminals (plan-term-xterm r2.6 PR 1: moved here unchanged from
// web/notebook/remote-terminal-view.ts, the terminal on your computer; the just-bash Terminal follows in PR 2).
//
// xterm renders a terminal's bytes as text into its own DOM in the page, so its escape-sequence parser is the trust
// boundary (terminals build plan r1, OUT-ISO).  Therefore, for every terminal made here:
// - no image or graphics addons (sixel, iTerm): only addon-fit, and the version is the lockfile's (6.0.0);
// - OSC 52 (clipboard writes) is swallowed: nothing in the output can write the clipboard;
// - a title (OSC 0/2) goes to the caller as text, for textContent, never markup;
// - links, OSC 8 or a plain web address, are http(s) only, opened only on a click, in a new tab with noopener and
//   noreferrer (the page's own way to open a tab: board/page.ts, code/boot.ts);
// - nothing in the output is evaluated or set as HTML.
import { Terminal } from "@xterm/xterm";
import css from "@xterm/xterm/css/xterm.css" with { type: "text" };

export { Terminal };
export { FitAddon } from "@xterm/addon-fit";

// Ported from CoCalc packages/frontend/frame-editors/terminal-editor/mobile-terminal-toolbar.tsx (SageMath, Inc.; relicensed by the copyright owner, Nov 7 2026)
// (KEYS, lines 35-44, and TOOLBAR_STYLE and BUTTON_STYLE, lines 16-33 @2265acac, as CSS)
export const KEYS: { label: string; title: string; data: string }[] = [
  { label: "Esc", title: "Escape", data: "\x1b" },
  { label: "Tab", title: "Tab", data: "\x09" },
  { label: "^C", title: "Control+C", data: "\x03" },
  { label: "`", title: "Backtick", data: "`" },
  { label: "←", title: "Left arrow", data: "\x1b[D" },
  { label: "↑", title: "Up arrow", data: "\x1b[A" },
  { label: "↓", title: "Down arrow", data: "\x1b[B" },
  { label: "→", title: "Right arrow", data: "\x1b[C" },
];
export const TOOLBAR_CSS = "align-items: center; background: rgba(248, 248, 248, 0.96); border-bottom: 1px solid #d9d9d9; display: flex; gap: 4px; min-height: 34px; overflow-x: auto; padding: 3px 6px; -webkit-overflow-scrolling: touch;";
export const BUTTON_CSS = "flex: 0 0 auto; min-width: 34px; padding-left: 6px; padding-right: 6px;";

/** xterm's own stylesheet, once per page. */
export function ensureXtermCss(): void {
  if (!document.getElementById("xterm-css")) {
    const style = Object.assign(document.createElement("style"), { id: "xterm-css", textContent: css });
    document.head.appendChild(style);
  }
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

export function openWeb(text: string): void {
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

/**
 * The extra-keys row (Esc, Tab, ^C, `, arrows) on a touch screen or the phone layout, else null.  `send` gets a key's
 * bytes; `refocus` gives the focus back to the terminal.
 */
export function extraKeysRow(className: string, send: (data: string) => void, refocus: () => void): HTMLElement | null {
  if (!(matchMedia("(pointer: coarse)").matches || document.documentElement.classList.contains("phone"))) return null;
  const row = Object.assign(document.createElement("div"), { className });
  row.setAttribute("role", "toolbar");
  row.setAttribute("aria-label", "Extra keys");
  for (const k of KEYS) {
    const b = Object.assign(document.createElement("button"), { type: "button", textContent: k.label, title: k.title });
    b.setAttribute("aria-label", k.title);
    b.dataset.key = k.title;
    // (the button never takes the focus from the terminal, so a phone's keyboard stays up)
    b.addEventListener("pointerdown", (e: Event) => e.preventDefault());
    b.addEventListener("click", () => { send(k.data); refocus(); });
    row.append(b);
  }
  return row;
}

/**
 * A Terminal with the OUT-ISO rules above in place: OSC 52 swallowed, the title to `onTitle` as text, OSC 8 and plain
 * web addresses http(s) only and opened on a click.  Not yet opened: the caller loads its addons and opens it.
 */
export function safeTerminal(o: { scrollback: number; onTitle: (title: string) => void }): Terminal {
  const term = new Terminal({
    fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
    fontSize: 14,
    cursorBlink: true,
    scrollback: o.scrollback,
    theme: themeFromCss(),
    // (OSC 8: http(s) only (allowNonHttpProtocols is false), opened on a click)
    linkHandler: { activate: (_e: MouseEvent, text: string) => openWeb(text), allowNonHttpProtocols: false },
  });
  // OSC 52, a clipboard write: swallowed (handled, so xterm does nothing more with it)
  term.parser.registerOscHandler(52, () => true);
  term.onTitleChange((t: string) => o.onTitle(t.slice(0, 120)));
  term.registerLinkProvider({
    provideLinks: (y: number, cb: (links: any[] | undefined) => void) => {
      const line = term.buffer.active.getLine(y - 1)?.translateToString(true) ?? "";
      const links = webLinksIn(line).map((l) => ({
        text: l.text,
        range: { start: { x: l.start + 1, y }, end: { x: l.start + l.text.length, y } },
        activate: (_e: MouseEvent, text: string) => openWeb(text),
      }));
      cb(links.length ? links : undefined);
    },
  });
  return term;
}

// (the console's colors: web/console.ts)
export function themeFromCss() {
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
