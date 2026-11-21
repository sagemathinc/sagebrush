// The real sagebrush-agent, from a packed tarball, for the Delegate end-to-end case: started as a person starts it
// (`npx --package <tgz> sagebrush-agent`, here with --origin for the test site's own origin), in a temporary HOME
// and npm cache, with the fake model (SAGEBRUSH_AGENT_FAKE=1: no Claude, no network for the model) and its Delegate
// tasks kept in a temporary folder (SAGEBRUSH_TASKS_HOME). The tarball is checked against its sha256 first, when one
// is given.
//
//   const agent = await startTarballAgent({ tgz, sha256, origin: site.origin });
//   await pairTarballAgent(page, site, agent, grant);   // the Agents page paired with it, the grant allowed
//   ... page closed or reloaded ...
//   await pairTarballAgent(page, site, agent, grant);   // paired again with the fresh code the agent printed
//   await agent.stop();
//
// The tarball comes from SAGEBRUSH_AGENT_TGZ (and SAGEBRUSH_AGENT_TGZ_SHA256) unless given.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allow, sleep } from "./harness.mjs";

const LINK = /\?pair=([^&\s]+)&port=(\d+)/g;

/**
 * Start the tarball's agent. Resolves once it has printed its first pairing link: `{ port, code, codes, latestCode,
 * nextCode, tasksHome, pause, resume, output, stop }`. `codes` holds every code printed, in order (a new one each time a page goes);
 * `nextCode(after)` waits for one after `after`.
 */
export async function startTarballAgent({ tgz = process.env.SAGEBRUSH_AGENT_TGZ, sha256 = process.env.SAGEBRUSH_AGENT_TGZ_SHA256, origin, ms = 180_000 } = {}) {
  if (!tgz) throw new Error("no tarball: give one, or set SAGEBRUSH_AGENT_TGZ");
  if (sha256) {
    const got = createHash("sha256").update(readFileSync(tgz)).digest("hex");
    if (got !== sha256) throw new Error(`the tarball's sha256 is ${got}, not ${sha256}`);
  }
  const home = mkdtempSync(join(tmpdir(), "sb-agent-e2e-"));
  const tasksHome = join(home, "tasks-home");
  const env = { ...process.env, HOME: home, npm_config_cache: join(home, ".npm"), npm_config_update_notifier: "false", SAGEBRUSH_AGENT_FAKE: "1", SAGEBRUSH_TASKS_HOME: tasksHome };
  const args = ["-y", "--package", tgz, "sagebrush-agent", ...(origin ? ["--origin", origin] : [])];
  // (its own process group: npx and the agent under it end together)
  const child = spawn("npx", args, { env, stdio: ["ignore", "pipe", "pipe"], detached: true });
  let out = "", err = "", port = null, exited = null;
  const codes = [];
  const read = () => { for (const m of out.matchAll(LINK)) { if (port === null) port = Number(m[2]); if (!codes.includes(m[1])) codes.push(m[1]); } };
  child.stdout.on("data", (d) => { out += d; read(); });
  child.stderr.on("data", (d) => { err = (err + d).slice(-20_000); });
  child.on("exit", (code, sig) => { exited = code ?? sig; });
  // (stopped on every way out: stop(), and at this process's exit, so a case that throws leaves no agent and no HOME)
  const killNow = () => { try { process.kill(-child.pid, "SIGKILL"); } catch {} rmSync(home, { recursive: true, force: true }); };
  process.on("exit", killNow);
  let stopping = null;
  /** Stop the agent (SIGTERM to its group, SIGKILL after 2 s) and remove the temporary HOME. */
  const stop = () => stopping ??= (async () => {
    try { process.kill(-child.pid, "SIGCONT"); process.kill(-child.pid, "SIGTERM"); } catch {}
    for (const t = Date.now(); exited === null && Date.now() - t < 2000; ) await sleep(50);
    killNow();
    process.off("exit", killNow);
  })();
  for (const t = Date.now(); !codes.length; ) {
    if (exited !== null) { await stop(); throw new Error(`the agent exited (${exited}) before printing a link: ${err.slice(-500)}`); }
    if (Date.now() - t > ms) { await stop(); throw new Error(`no pairing link within ${ms} ms: ${err.slice(-500)}`); }
    await sleep(50);
  }
  return {
    port,
    code: codes[0],
    codes,
    latestCode: () => codes.at(-1),
    /** A code printed after `after` (the agent prints a fresh link each time a page goes). */
    async nextCode(after, waitMs = 15_000) {
      for (const t = Date.now(); Date.now() - t < waitMs; await sleep(50)) { const i = codes.indexOf(after); if (codes.length > i + 1) return codes.at(-1); }
      throw new Error("the agent printed no new pairing link");
    },
    tasksHome,
    /** The agent's whole process group stopped (SIGSTOP), and let go on (SIGCONT): a negative control's agent that
     *  does nothing while no page is paired. */
    pause: () => { try { process.kill(-child.pid, "SIGSTOP"); } catch {} },
    resume: () => { try { process.kill(-child.pid, "SIGCONT"); } catch {} },
    output: () => ({ stdout: out, stderr: err }),
    stop,
  };
}

/** Pair the Agents page with the tarball's agent (its latest code), then allow the grant, as the chat surface does. */
export async function pairTarballAgent(page, site, agent, grant) {
  await page.navigate(`${site.origin}/agents/?pair=${agent.latestCode()}&port=${agent.port}`);
  if (!(await page.until(`!!document.querySelector(".sbag-box button.primary")`, 60_000))) throw new Error("the Agents page didn't open Connect");
  await page.ev(`(document.querySelector(".sbag-box button.primary").click(), true)`);
  await allow(page, grant);
}
