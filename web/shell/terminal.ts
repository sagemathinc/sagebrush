// The terminal's module (plan-bash-shell r8c step 6): built on its own (web/build.ts: dist/shell/terminal.js) and
// loaded by a page only when its ⋯ ▸ Terminal is first opened, so the page itself carries none of it: the shell's
// host and loader, the panel, and the page commands.  One ShellHost per page tab, the person principal.
import type { Workspace } from "../workspace/api";
import { ShellHost } from "./host.ts";
import { startShell } from "./loader.ts";
import { TerminalPanel } from "./panel.ts";
import { terminalCommands, type PageHooks } from "./panel-commands.ts";
import { gatherPresence, type Proc } from "./presence.ts";

export interface OpenTerminal {
  ws: Workspace;
  /** the package set the shell runs (its 64-hex id) */
  S: string;
  /** `open FILE`, the page's own way to open a workspace path */
  open?: PageHooks["open"];
  /** this page's processes, for `ps` and `top` (other tabs answer for themselves) */
  here: () => Promise<Proc[]>;
  /** this page's presence id (its own presence module's TAB: this module has a copy of its own) */
  tab: string;
  /** where the site's pkgset/ and pkg/ are, relative to this page (default "./"; the board page, under /board/: "../") */
  base?: string;
}

/** A terminal panel on a new ShellHost; ✕ ends its shell too. */
export function openTerminal(o: OpenTerminal): TerminalPanel {
  const host = new ShellHost(o.ws, async (signal) => (await startShell(o.S, o.base ?? "./", { signal })).shell);
  const term = new TerminalPanel({ host, label: "bash · " + o.S.slice(0, 8), commands: terminalCommands({ open: o.open, ps: () => gatherPresence(o.here, 300, o.tab), tab: o.tab }) });
  return term; // (✕ ends its host's shell itself: TerminalPanel.end)
}
