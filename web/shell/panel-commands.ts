// The terminal's page commands (William's P1 on the preview), given to the panel by the page (web/shell/panel.ts's
// `commands`): `open FILE...` (Sagebrush's own way to open a workspace path) and `ps` / `top` (what is open in this
// browser, web/shell/presence.ts).  Run in the page when typed alone; anything with shell syntax goes to bash.
import { psTable, topText, type Proc } from "./presence.ts";
import type { PanelCommand } from "./panel.ts";
import { SHELL_COMMANDS, BUILTINS, compgen } from "./complete.ts";

/** An absolute workspace path: PATH against the directory `cwd`, with . and .. resolved. */
export function absPath(cwd: string, p: string): string {
  const parts: string[] = [];
  for (const seg of ((p.startsWith("/") ? "" : cwd + "/") + p).split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return "/" + parts.join("/");
}

export interface PageHooks {
  /** opens a workspace path in Sagebrush; resolves with a line to show, or rejects with why not */
  open?: (path: string) => Promise<string>;
  /** what is open in this browser */
  ps?: () => Promise<{ procs: Proc[]; tabs: number }>;
  /** this tab's id (the page's presence id), marked [this tab] */
  tab?: string;
}

// (help's page, about 25 lines: what the panel offers, the shell's commands, the keys; plan-term-help-tab §2H)
const USAGE: Record<string, string> = {
  help: "help [NAME]: this page, or one command's help",
  open: "open FILE...: opens it in Sagebrush (a notebook or board in a new tab, a data file in its preview)",
  ps: "ps: what is open in this browser (notebooks, boards, terminals, kernels)",
  top: "top: ps, refreshed every 2 s until Stop",
  clear: "clear: clears the scrollback (Ctrl-L)",
  reset: "reset: clears the scrollback and the input, and starts a fresh shell (keeps the directory and history)",
  compgen: "compgen -c|-b [PREFIX]: the command (or builtin) names",
};
const wrapList = (xs: string[], width = 76) => {
  const lines: string[] = [];
  let cur = "";
  for (const x of xs) {
    if (cur && cur.length + 1 + x.length > width) (lines.push(cur), (cur = ""));
    cur += (cur ? " " : "") + x;
  }
  if (cur) lines.push(cur);
  return lines.map((l) => "  " + l).join("\n");
};
export function helpText(): string {
  return [
    "The Terminal: a bash-like shell over your workspace's files. Commands change files right away.",
    "",
    "Sagebrush's commands: open, ps, top, clear, reset, help",
    "The shell's commands:",
    wrapList(SHELL_COMMANDS),
    "Builtins:",
    wrapList(BUILTINS),
    "",
    "Keys: Enter runs; Shift-Enter a new line; Up/Down the history; Tab completes a command or a path at the end of",
    "a word (otherwise Tab and Shift-Tab move focus as usual); Ctrl-L clears; Stop or Ctrl-C stops a command.",
    "",
    "help NAME for one command.",
    "",
  ].join("\n");
}

export function terminalCommands(page: PageHooks): Record<string, PanelCommand> {
  const out: Record<string, PanelCommand> = {};
  // help, and help NAME for the panel's own commands (the shell's and the builtins' go to bash: panel.ts)
  out.help = async (args, io) => {
    if (!args.length) {
      io.write(helpText());
      return 0;
    }
    if (args.length === 1 && Object.hasOwn(USAGE, args[0])) {
      io.write(USAGE[args[0]] + "\n");
      return 0;
    }
    io.write(`help: no help topics match '${args.join(" ")}'\n`, true);
    return 1;
  };
  // compgen -c|-b|-A command|-A builtin [PREFIX], typed alone (§2G); any other form goes to bash (panel.ts)
  out.compgen = async (args, io) => {
    const r = compgen(args);
    if (!r) return 2;
    io.write(r.out);
    return r.code;
  };
  if (page.open) {
    const open = page.open;
    out.open = async (args, io) => {
      if (!args.length) {
        io.write("usage: open FILE...  (opens it in Sagebrush: a notebook or board in a new tab, a data file in its preview)\n", true);
        return 2;
      }
      let code = 0;
      for (const a of args) {
        try {
          io.write((await open(absPath(io.cwd, a))) + "\n");
        } catch (e) {
          io.write(`open: ${a}: ${String((e as Error)?.message ?? e)}\n`, true);
          code = 1;
        }
      }
      return code;
    };
  }
  if (page.ps) {
    const ps = page.ps;
    out.ps = async (_args, io) => {
      io.write(psTable((await ps()).procs, Date.now(), page.tab));
      return 0;
    };
    // top: the same listing, refreshed every 2 s until Stop (or Ctrl-C)
    out.top = async (_args, io) => {
      while (!io.signal.aborted) {
        const { procs, tabs } = await ps();
        if (io.signal.aborted) break;
        io.replace(topText(procs, tabs, Date.now(), page.tab));
        await new Promise<void>((r) => {
          const t = setTimeout(r, 2000);
          io.signal.addEventListener("abort", () => (clearTimeout(t), r()), { once: true });
        });
      }
      return 0;
    };
  }
  return out;
}
