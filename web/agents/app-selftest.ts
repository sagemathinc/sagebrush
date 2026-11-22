// The desktop app's self-test of the agents page (app/selftest/run.mjs, "the agents page in the app";
// design/app-agent-host.md, step 1). The app starts on /agents/ with a pairing link in its address, the query form
// ?pair=CODE&port=N and a #pair= fragment, after recording every connection the page opens (lib.rs,
// AGENTS_NET_RECORDER). After a few seconds this reads back:
//  1. the address: no pair, no port, no #pair= left in it;
//  2. the connections: none to another origin, and no WebSocket or EventSource at all (the site's pairing, Chat here
//     and the computer relay aren't loaded in the app);
//  3. Connect Claude: shown, unavailable, saying "Not in this build yet";
//  4. agent_connect, from this page: refused with the fixed code not_bundled;
//  5. agent_connect from a notebook output's frame (sandbox="allow-scripts" srcdoc), every way it has: refused.
// One report line through selftest_report, then the app exits. Its control (SAGEBRUSH_APP_AGENTS_CONTROL=off-app) runs
// the same page off the app's mode, where the site's pairing takes the link: the check must then fail, for that reason.

export async function agentsSelftest(core: { invoke: (c: string, a?: any) => Promise<any> }) {
  await new Promise((r) => setTimeout(r, 4000));
  const fails: string[] = [];
  const left = new URLSearchParams(location.search);
  if (left.has("pair") || left.has("port") || /\bpair=/.test(location.hash)) fails.push(`the address still has the pairing link (${location.search}${location.hash})`);
  const net: { kind: string; url: string }[] = ((window as any).__sbNet ?? []).slice();
  const foreign = net.filter((n) => n.kind !== "fetch" || !n.url.startsWith(location.origin + "/"));
  if (foreign.length) fails.push(`connections it may not open: ${foreign.map((n) => `${n.kind} ${n.url.replace(/[?#].*$/, "")}`).join(", ")}`);
  const b = document.querySelector("#connect") as HTMLElement | null;
  const note = document.querySelector("#connect-note")?.textContent ?? "";
  const shown = !!b && !b.hidden, off = b?.getAttribute("aria-disabled") === "true";
  if (!shown || !off || note !== "Not in this build yet") fails.push(`Connect Claude: shown ${shown}, unavailable ${off}, says ${JSON.stringify(note)}`);
  const refused = await core.invoke("agent_connect", { kind: "claude" }).then(() => "accepted", (e: unknown) => (typeof e === "string" ? e : "other"));
  if (refused !== "not_bundled") fails.push(`agent_connect from the page: ${refused}`);
  const frame = await frameProbe();
  if (frame.reached.length) fails.push(`an output frame reached agent_connect: ${frame.reached.join(", ")}`);
  const ok = fails.length === 0;
  const line = ok
    ? `agents at ${location.origin}: the pairing link dropped; ${net.length} connections, all to this page's own files; Connect Claude says "Not in this build yet"; agent_connect refused (not_bundled), from the page and from an output frame (bootstrap ${frame.bootstrap})`
    : `agents at ${location.origin}: ${fails.join("; ")}`;
  await core.invoke("selftest_report", { report: `${ok ? "ok" : "FAIL"} persist: ${line}`, ok });
}

function frameProbe(): Promise<{ bootstrap: string; reached: string[] }> {
  const probe = `<script>(async () => {
    const out = { bootstrap: typeof window.__TAURI_INTERNALS__ === "object" ? "present" : "absent", reached: [] };
    const tryIt = async (k, f) => { try { await f(); out.reached.push(k); } catch {} };
    await tryIt("core", () => window.__TAURI__.core.invoke("agent_connect", { kind: "claude" }));
    await tryIt("internals", () => window.__TAURI_INTERNALS__.invoke("agent_connect", { kind: "claude" }));
    for (const u of ["ipc://localhost/agent_connect", "http://ipc.localhost/agent_connect"])
      await tryIt(u, async () => { const r = await fetch(u, { method: "POST", body: '{"kind":"claude"}', headers: { "Content-Type": "application/json", "Tauri-Callback": "1", "Tauri-Error": "2" } }); if (!r.ok) throw 0; });
    parent.postMessage({ sbAgentsProbe: out }, "*");
  })();<\/script>`;
  return new Promise((res) => {
    const f = document.createElement("iframe");
    f.setAttribute("sandbox", "allow-scripts");
    f.style.display = "none";
    const done = (v: any) => { removeEventListener("message", on); f.remove(); res(v); };
    const on = (e: MessageEvent) => { if (e.source === f.contentWindow && e.data?.sbAgentsProbe) done(e.data.sbAgentsProbe); };
    addEventListener("message", on);
    setTimeout(() => done({ bootstrap: "?", reached: ["(no answer from the frame)"] }), 15000);
    f.srcdoc = probe;
    document.body.append(f);
  });
}
