// The terminal's Tab completion, `help NAME` routing and `ls` colours (plan-term-help-tab r3.1 §2T, §2H, §2C), given
// to the panel by the page (web/shell/terminal.ts, as panel-commands.ts is), so the panel's own code carries only the
// calls.  The logic is web/shell/complete.ts's pure functions; the only
// listing is ShellHost.complete, the shell's own checks, read-only, never an invocation.
import type { ShellHost } from "./host.ts";
import { words, type PanelTab, type TabInput, type TabState } from "./panel.ts";
import { tabAction, tabWord, complete, matches, splitPath, candidateBlock, commandNames, compgen, lsColourable, colourLs, SHELL_COMMANDS, BUILTINS, PANEL_COMMANDS, type Cand } from "./complete.ts";
import { absPath } from "./panel-commands.ts";

const PERSON = { kind: "person" } as const;

export function panelTab(host: ShellHost): PanelTab & { requests: number } {
  let ctl: AbortController | null = null;
  // (each reset (an edit, a cd, a run, reset, end) starts a new generation: an answer from an older one is stale)
  let gen = 0;
  let lastTab: string | null = null;
  let root0: HTMLElement | null = null;
  // (any key but Tab (history's Up/Down, Ctrl-C, Enter, an edit) supersedes what a Tab has in flight: the panel calls
  // reset() for each, so an Up then Down back to the same text can't revive it: astra TH-C3)
  const self = {
    /** the listings asked of the host (the tests' counter, E5) */
    requests: 0,
    reset() {
      gen++;
      // (the tests read the aborts on the panel's root, kept by reference after a close)
      if (ctl && !ctl.signal.aborted && root0) root0.dataset.tabAborts = String(Number(root0.dataset.tabAborts ?? 0) + 1);
      ctl?.abort();
      ctl = null;
    },
    key(input: TabInput, root: HTMLElement, state: () => TabState): boolean {
      const st = state();
      // (completion only at a word's end, nothing selected, nothing running, and a literal word: otherwise nothing,
      // the Tab staying in the Terminal (panel.ts: Esc then Tab leaves it); Shift-Tab never reaches here)
      root0 = root;
      if (tabAction(input.value, input.caret, input.caret, st.busy) !== "complete") return false;
      const w = tabWord(input.value, input.caret);
      if (!w) return false;
      ctl?.abort();
      const mine = (ctl = new AbortController());
      const g = gen;
      const snap = { value: input.value, caret: input.caret, cwd: st.cwd };
      // (the answer is still for what is on screen: this Tab's listing, the same generation, input, caret and cwd,
      // nothing running, the session not ended)
      const fresh = () => {
        const s = state();
        return !mine.signal.aborted && ctl === mine && g === gen && !s.busy && !s.ended && s.cwd === snap.cwd &&
          input.value === snap.value && input.caret === snap.caret;
      };
      void (async () => {
        const lit = w.literal!;
        const { dir, name } = splitPath(lit);
        let cands: Cand[], atTop = false;
        if (w.first && !dir) cands = commandNames().map((n) => ({ name: n }));
        else {
          const folder = absPath(snap.cwd, dir || ".");
          atTop = folder === "/";
          self.requests++;
          root.dataset.tabRequests = String(self.requests);
          // (the tests' knob for a slow listing, E5: a delay only, never another answer)
          const delay = Number((globalThis as any).__sbTermTabDelayMs) || 0;
          if (delay) await new Promise((r) => setTimeout(r, delay));
          const r = await host.complete(PERSON, folder, mine.signal);
          if (!("entries" in r)) {
            if ("tooMany" in r && fresh()) input.show("Too many entries here to complete.");
            return;
          }
          cands = r.entries.map((x) => ({ name: x.name, dir: x.kind === "folder" }));
        }
        if (!fresh()) return;
        const res = complete(snap.value, snap.caret, w, cands, atTop);
        if (res === null) return;
        if (res === "list") {
          // (bash's way: the first Tab with nothing new does nothing, the second lists)
          if (lastTab === snap.value) input.show(candidateBlock(matches(cands, name, !dir, atTop).map((c) => c.name + (c.dir ? "/" : ""))));
          lastTab = snap.value;
          return;
        }
        lastTab = null;
        input.set(res.line, res.caret);
      })();
      return true;
    },
    route(argv: string[] | null, line: string): string | null {
      if (!argv) return null;
      // (compgen typed alone in a form that isn't the panel's: bash's own, as typed)
      if (argv[0] === "compgen" && compgen(argv.slice(1)) === null) return line;
      // (help NAME for a shell command or a builtin: bash's own help for it, NAME an exact member of the fixed lists,
      // never another word put into shell syntax; plan-term-help-tab §3)
      if (argv.length === 2 && argv[0] === "help" && !PANEL_COMMANDS.includes(argv[1]) && argv[1] !== "compgen") {
        if (SHELL_COMMANDS.includes(argv[1])) return `${argv[1]} --help`;
        if (BUILTINS.includes(argv[1])) return `help '${argv[1]}'`;
      }
      return null;
    },
    async colour(line: string, out: string, cwd: string): Promise<string> {
      return colourOf(host, line, out, cwd);
    },
  };
  return self;
}

/**
 * A plain `ls` typed alone (-a -A -1 -F -R, no pipe or redirect: words() parses it), its output coloured by each
 * entry's workspace kind (§2C); the folders' kinds from the host's checked listing; any other output unchanged.
 */
async function colourOf(host: ShellHost, line: string, out: string, cwd: string): Promise<string> {
  const argv = words(line.trim());
  const paths = lsColourable(argv);
  if (!paths || !out) return out;
  const headers = paths.length > 1 || argv!.slice(1).some((a) => a.startsWith("-") && a.includes("R"));
  const start = paths.length === 0 ? cwd : paths.length === 1 ? absPath(cwd, paths[0]) : null;
  const dirs = new Set<string>();
  if (start) dirs.add(start);
  const lines = out.split("\n");
  if (headers) for (const [i, l] of lines.entries()) if (l.endsWith(":") && (i === 0 || lines[i - 1] === "")) dirs.add(absPath(cwd, l.slice(0, -1)));
  const kinds = new Map<string, Map<string, string>>();
  // (at most 20 folders' listings, each bounded by bash.list_entries)
  for (const d of [...dirs].slice(0, 20)) {
    const r = await host.complete(PERSON, d);
    if ("entries" in r) kinds.set(d, new Map(r.entries.map((x) => [x.name, x.kind])));
  }
  return colourLs(out, start, headers, (h) => absPath(cwd, h), (d, n) => kinds.get(d)?.get(n));
}
