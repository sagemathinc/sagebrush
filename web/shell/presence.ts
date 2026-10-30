// What is open in this browser, for the terminal's `ps` and `top` (William's P1 on the terminal preview): each
// Sagebrush page answers "who's there?" on one BroadcastChannel with its documents and sessions; the asking page
// gathers the answers for a short window.  Same origin only (BroadcastChannel's own scope); no content, only names,
// kinds, states and times.  A page that doesn't answer (another tab of an older build, a board page today) isn't
// listed: `ps` says how many tabs answered.

export type Proc = {
  /** this tab's id (random per tab) */
  tab: string;
  kind: "notebook" | "board" | "terminal" | "kernel" | "other";
  /** the document's or session's name, its workspace path when it has one */
  name: string;
  path?: string;
  /** python, sage, magma, matlab, bash … */
  mode?: string;
  /** "running", "idle", "hidden" (a background tab) … */
  state: string;
  /** when it started (ms since the epoch) */
  since: number;
  /** the tab's JS heap in bytes, where the browser says (Chromium) */
  heap?: number;
};

const CHANNEL = "sagebrush-ps";
export const TAB = Math.random().toString(16).slice(2, 6);

/** Answers queries with `describe()` (this page's processes); returns a stop function. */
export function answerPresence(describe: () => Proc[] | Promise<Proc[]>): () => void {
  if (typeof BroadcastChannel !== "function") return () => {};
  const ch = new BroadcastChannel(CHANNEL);
  ch.onmessage = async (e) => {
    const m = e.data;
    if (!m || typeof m.q !== "string" || m.from === TAB) return;
    try {
      ch.postMessage({ a: m.q, from: TAB, procs: await describe() });
    } catch {}
  };
  return () => ch.close();
}

/** This page's processes plus every answer within `ms`; `self`: this tab's id (the page's, which answers for it). */
export async function gatherPresence(local: () => Proc[] | Promise<Proc[]>, ms = 300, self = TAB): Promise<{ procs: Proc[]; tabs: number }> {
  const procs: Proc[] = [...(await local())];
  const tabs = new Set([self]);
  if (typeof BroadcastChannel !== "function") return { procs, tabs: 1 };
  const ch = new BroadcastChannel(CHANNEL);
  const q = Math.random().toString(36).slice(2);
  ch.onmessage = (e) => {
    const m = e.data;
    if (!m || m.a !== q || typeof m.from !== "string" || tabs.has(m.from) || !Array.isArray(m.procs)) return;
    tabs.add(m.from);
    for (const p of m.procs.slice(0, 64)) if (p && typeof p.name === "string" && typeof p.kind === "string") procs.push({ ...p, tab: m.from });
  };
  ch.postMessage({ q, from: self });
  await new Promise((r) => setTimeout(r, ms));
  ch.close();
  return { procs, tabs: tabs.size };
}

const pad = (s: string, n: number) => (s.length >= n ? s : s + " ".repeat(n - s.length));
const two = (n: number) => String(n).padStart(2, "0");
export function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600);
  return (d ? `${d}-` : "") + `${two(h)}:${two(Math.floor((s % 3600) / 60))}:${two(s % 60)}`;
}
const mb = (b?: number) => (b == null ? "-" : `${(b / 2 ** 20).toFixed(0)}M`);

/** `ps`'s table: PID (a number per listing), TAB, KIND, STATE, TIME (since it started), MEM (the tab's heap), NAME. */
export function psTable(procs: Proc[], now = Date.now(), here = TAB): string {
  const rows = procs
    .slice()
    .sort((a, b) => (a.tab === here ? 0 : 1) - (b.tab === here ? 0 : 1) || a.tab.localeCompare(b.tab) || a.since - b.since);
  const lines = [`${pad("PID", 5)}${pad("TAB", 6)}${pad("KIND", 10)}${pad("STATE", 9)}${pad("TIME", 11)}${pad("MEM", 7)}NAME`];
  rows.forEach((p, i) => {
    const name = (p.path ?? p.name) + (p.mode ? `  (${p.mode})` : "") + (p.tab === here ? "  [this tab]" : "");
    lines.push(`${pad(String(i + 1), 5)}${pad(p.tab, 6)}${pad(p.kind, 10)}${pad(p.state, 9)}${pad(elapsed(now - p.since), 11)}${pad(mb(p.heap), 7)}${name}`);
  });
  return lines.join("\n") + "\n";
}

/** `top`'s header, then the table. */
export function topText(procs: Proc[], tabs: number, now = Date.now(), here = TAB): string {
  const d = new Date(now);
  const running = procs.filter((p) => p.state === "running").length;
  const docs = procs.filter((p) => p.kind === "notebook" || p.kind === "board").length;
  const head = `top - ${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}   ${tabs} tab${tabs === 1 ? "" : "s"}, ` +
    `${docs} document${docs === 1 ? "" : "s"}, ${running} running   (Stop or Ctrl-C to quit)\n\n`;
  return head + psTable(procs, now, here);
}
