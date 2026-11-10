// An agent's runs of code in this page (chat plan PR 4a): the page's one run, its line with Stop, and the loader of the
// verbs themselves (/sagebrush-agent-run.js, run-verbs.ts), fetched at the first run. Only in the pages that offer runs
// (the notebook page, through agent-entry.ts): the pairing chunk of a page without them (the LaTeX page's) carries none
// of this (daybreak2's placement: the pairing keeps only the holder, Stop and the loader).
import type { RunVerbs, RunSide } from "./agent-pair";
import { grantProblem, type Grant } from "./agent-grant";
import type { RunHost, RunHolder } from "./run-verbs";

const CSS = `.sbag-run { position: fixed; left: 12px; bottom: calc(52px + var(--sb-alpha-banner, 0px)); z-index: 999; background: #fff; color: #1d241a; border: 1px solid #1d241a; border-radius: 18px; padding: 4px 6px 4px 14px; font: 13px system-ui, sans-serif; display: flex; gap: 10px; align-items: center; max-width: calc(100vw - 24px); }
.sbag-run button { font: inherit; border: 0; border-radius: 12px; padding: 3px 10px; background: #1d241a; color: #fff; cursor: pointer; }`;
let styled = false;
const style = () => { if (styled) return; styled = true; const s = document.createElement("style"); s.textContent = CSS; document.head.append(s); };
const el = (tag: string, props: Record<string, string>, ...kids: Node[]) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };

/** A run verb's params, checked before anything is loaded: why not, or null (board's Q-B5 words). */
export function runParams(method: string, p: unknown): string | null {
  if (!p || typeof p !== "object" || Array.isArray(p)) return "params must be an object";
  const k = Object.keys(p);
  if (method === "workspace.run_stop") return k.length ? `run_stop takes no params (${k[0].slice(0, 40)})` : null;
  const o = p as Record<string, unknown>;
  for (const x of k) if (x !== "path" && x !== "timeout_s") return `unknown param: ${x.slice(0, 40)}`;
  if (typeof o.path !== "string" || !o.path || o.path.length > 4096) return "path must be a workspace path";
  if (o.timeout_s !== undefined && !(Number.isInteger(o.timeout_s) && (o.timeout_s as number) >= 1 && (o.timeout_s as number) <= 600)) return "timeout_s must be a whole number of seconds, 1 to 600";
  return null;
}

/** The run verbs for the pairing (agent-pair.ts's RunVerbs): `runs` the page's loader and host. */
export function runVerbsFor(runs: { load(): Promise<typeof import("./run-verbs")>; host(): RunHost }): RunVerbs {
  let runLine: HTMLElement | null = null;
  const holder: RunHolder = {
    current: null,
    // (board's C2: "<agent name> is running <file name>", the file's base name with a middle ellipsis when long, its
    //  full path in the title; Stop; gone at every end)
    show(agent, view, stop) {
      runLine?.remove();
      style();
      const base = view.slice(view.lastIndexOf("/") + 1) || view;
      const file = base.length > 40 ? base.slice(0, 19) + "…" + base.slice(-19) : base;
      const stopB = el("button", { textContent: "Stop", title: "Stop this run (the agent is told it was stopped)" });
      stopB.onclick = stop;
      runLine = el("div", { className: "sbag-run", title: `Running ${view} for ${agent}` }, el("span", { textContent: `${agent} is running ${file}` }), stopB);
      runLine.setAttribute("role", "status");
      document.body.append(runLine);
    },
    hide() { runLine?.remove(); runLine = null; },
  };
  const call = async (method: string, params: any, ctx: any) => {
      // (run_stop: this grant's run, if there is one; while its chunk loads, stopped here)
      if (method === "workspace.run_stop") {
        const c = holder.current;
        if (!c || c.owner !== ctx.grant.id) return { stopped: false };
        if (c.loading) { c.stop(); return { stopped: true }; }
        return (await runs.load()).stop(ctx, holder);
      }
      // (a run: held here while its chunk loads, so the page's Stop and run_stop work on it already (daybreak2's
      //  placement); the chunk then takes it over, or ends it at once if it was stopped meanwhile)
      let pre: RunHolder["current"] = null, timer: ReturnType<typeof setTimeout> | undefined, unwatch = () => {};
      if (!holder.current) {
        // (its deadline from now, the chunk's load included; a grant ended meanwhile ends it too)
        const loading: { stopped: boolean; cause?: "stopped" | "timeout" } = { stopped: false };
        const deadlineAt = performance.now() + (Number.isInteger(params?.timeout_s) ? params.timeout_s : 120) * 1000;
        pre = { owner: ctx.grant.id, view: String(params?.path ?? ""), loading, deadlineAt, stop: () => { loading.stopped = true; holder.hide(); } };
        timer = setTimeout(() => { loading.cause ??= "timeout"; pre!.stop(); }, Math.max(0, deadlineAt - performance.now()));
        unwatch = ctx.onChange(() => { if (!ctx.live()) pre!.stop(); });
        holder.current = pre;
        holder.show(ctx.agent, pre.view, pre.stop);
      }
      try {
        const m = await runs.load();
        // (taken over by the run, which keeps its own deadline from deadlineAt)
        clearTimeout(timer); unwatch();
        return await m.run(method as any, params, ctx, runs.host(), holder, pre);
      } finally {
        clearTimeout(timer); unwatch();
        if (pre && holder.current === pre) { holder.current = null; holder.hide(); }
      }
  };
  const same = (a: string[], b: string[]) => a.length === b.length && a.every((f, i) => f === b[i]);
  return {
    // (its params first; then the grant in force; and nothing of a run said under a grant that has changed but its end
    //  and why (packet r3 §4))
    async serve(method: string, params: unknown, side: RunSide) {
      const bad = runParams(method, params);
      if (bad) return side.fail("invalid", bad);
      const g = side.grant;
      if (!side.current(g)) return side.fail("invalid", grantProblem(side.live.grant(), side.now()) ?? "the grant changed");
      // (why a run ended under its grant: board's four reasons)
      const why = () => {
        const now = side.live.grant();
        if (!now) return side.live.closeReason() === "the grant expired" || (g!.expires !== null && !(side.now() < g!.expires)) ? "the grant expired" : "the grant was revoked";
        if (now.expires !== null && !(side.now() < now.expires)) return "the grant expired";
        if (!now.run) return "May run code was turned off";
        if (!same(now.folders, g!.folders)) return "what you may read was narrowed";
        return "the grant was revoked";
      };
      // (still in force for a run: this grant (its id), in force, its folders as they were, and run as it was at the
      //  call (a call made after it was turned off is refused for that by the run itself, not ended); only its write
      //  may have narrowed, which the run applies)
      const live = () => {
        const now = side.live.grant();
        return side.live.state() === "granted" && now !== null && grantProblem(now, side.now()) === null && (now.run || !g!.run) && now.id === g!.id && same(now.folders, g!.folders);
      };
      const ctx = { agent: side.agent, actor: side.actor, grant: g!, live, why, grantNow: (): Grant | null => side.live.grant(), onChange: side.onChange };
      try {
        const result: any = await call(method, params, ctx);
        if (!live()) return side.reply({ ok: false, ended: "revoked", reason: why() });
        g!.lastUsed = side.now();
        side.reply(result);
      } catch (err: any) {
        if (!live()) return side.reply({ ok: false, ended: "revoked", reason: why() });
        const code = typeof err?.code === "string" && /^[a-z_]{1,20}$/.test(err.code) ? err.code : "invalid";
        side.fail(code, String(err?.message ?? err).slice(0, 500));
      }
    },
  };
}
