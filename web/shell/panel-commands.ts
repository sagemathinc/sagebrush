// The terminal's page commands (William's P1 on the preview), given to the panel by the page (web/shell/panel.ts's
// `commands`): `open FILE...` (Sagebrush's own way to open a workspace path) and `ps` / `top` (what is open in this
// browser, web/shell/presence.ts).  Run in the page when typed alone; anything with shell syntax goes to bash.
import { psTable, topText, type Proc } from "./presence.ts";
import type { PanelCommand } from "./panel.ts";

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
}

export function terminalCommands(page: PageHooks): Record<string, PanelCommand> {
  const out: Record<string, PanelCommand> = {};
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
      io.write(psTable((await ps()).procs));
      return 0;
    };
    // top: the same listing, refreshed every 2 s until Stop (or Ctrl-C)
    out.top = async (_args, io) => {
      while (!io.signal.aborted) {
        const { procs, tabs } = await ps();
        if (io.signal.aborted) break;
        io.replace(topText(procs, tabs));
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
