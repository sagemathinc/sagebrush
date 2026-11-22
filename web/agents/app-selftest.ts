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
//     This build's agent_connect refuses every caller with not_bundled, so a refusal alone proves nothing: each answer
//     goes through outcome() below, where a resolved call or any answer naming not_bundled is "reached" (the command
//     ran), a refusal counts only as a known denial (no bridge in the frame, the request blocked, or the ACL's "not
//     allowed"), and any other answer is "unclassified" and fails the check. The page's own call in 4 goes through the
//     same outcome() and must be "reached": the control that a reachable command is caught.
// One report line through selftest_report, then the app exits. Its control (SAGEBRUSH_APP_AGENTS_CONTROL=off-app) runs
// the same page off the app's mode, where the site's pairing takes the link: it opens the Connect dialog with the code
// filled in, and only that dialog's Connect button opens the socket, so the control clicks it (as a person would) and
// the check must then fail, for that reason.

export async function agentsSelftest(core: { invoke: (c: string, a?: any) => Promise<any> }, inApp: boolean) {
  await new Promise((r) => setTimeout(r, 4000));
  const fails: string[] = [];
  if (!inApp) {
    // (the control only: the site's Connect dialog, its Connect button (never the page's own #connect))
    const go = [...document.querySelectorAll("button.primary")].find((x) => x.textContent === "Connect" && x.id !== "connect") as HTMLButtonElement | undefined;
    if (go) { go.click(); await new Promise((r) => setTimeout(r, 3000)); }
    fails.push(go ? "(the control) the pairing dialog's Connect clicked" : "(the control) no pairing dialog to click");
  }
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
  // (the control: the page's own call, which reaches the stub, is "reached" by the same rule the frame is judged by)
  const own = await core.invoke("agent_connect", { kind: "claude" }).then((v: unknown) => outcome(true, v), (e: unknown) => outcome(false, e));
  if (!own.startsWith("reached")) fails.push(`the control: the page's own agent_connect is not judged reached (${own}), so the frame's check can't catch a reachable command`);
  const frame = await frameProbe();
  const bad = Object.entries(frame.results).filter(([, v]) => !/^(denied|absent|blocked)\b/.test(v));
  if (!Object.keys(frame.results).length || bad.length) fails.push(`an output frame's agent_connect: ${bad.length ? bad.map(([k, v]) => `${k}: ${v}`).join(", ") : "no answer from the frame"}`);
  const ok = fails.length === 0;
  const line = ok
    ? `agents at ${location.origin}: the pairing link dropped; ${net.length} connections, all to this page's own files; Connect Claude says "Not in this build yet"; agent_connect refused (not_bundled) from the page (the control: judged ${own}); from an output frame (bootstrap ${frame.bootstrap}) ${Object.entries(frame.results).map(([k, v]) => `${k} ${v}`).join("; ")}`
    : `agents at ${location.origin}: ${fails.join("; ")}`;
  await core.invoke("selftest_report", { report: `${ok ? "ok" : "FAIL"} persist: ${line}`, ok });
}

// How one call came out. Self-contained (no outside names): its source also runs inside the frame's probe.
//  - "reached": it resolved, or its answer names not_bundled, this build's refusal from the command itself;
//  - "denied": Tauri's refusal before any command runs: its ACL's "... not allowed ..." (tauri 2's ipc/authority.rs), or
//    its IPC protocol's "missing Tauri-Invoke-Key header" / "missing Origin header" (ipc/protocol.rs);
//  - "absent": the frame has no bridge to call through (a TypeError on a missing __TAURI__ / __TAURI_INTERNALS__);
//  - "blocked": the request never got an answer (a fetch that fails: "Failed to fetch", "Load failed", a network error);
//  - "unclassified": anything else, which the check treats as reached.
export function outcome(resolved: boolean, v: unknown): string {
  if (resolved) return "reached (resolved)";
  const t = String(typeof v === "string" ? v : (v && (v as any).message) || v).slice(0, 160);
  const isType = !!v && typeof v === "object" && (v as any).name === "TypeError";
  if (/not_bundled/.test(t)) return "reached (" + t + ")";
  if (/\bnot allowed\b|missing (Tauri-[A-Za-z-]+|Origin) header/.test(t)) return "denied (" + t + ")";
  if (isType && /fetch|load failed|network/i.test(t)) return "blocked (" + t + ")";
  if (isType && /undefined|null|not an object|cannot read/i.test(t)) return "absent (" + t + ")";
  return "unclassified (" + t + ")";
}

export function frameProbe(): Promise<{ bootstrap: string; results: Record<string, string> }> {
  const probe = `<script>(async () => {
    const outcome = ${outcome.toString()};
    const out = { bootstrap: typeof window.__TAURI_INTERNALS__ === "object" ? "present" : "absent", results: {} };
    const tryIt = async (k, f) => { try { const v = await f(); out.results[k] = outcome(true, v); } catch (e) { out.results[k] = outcome(false, e); } };
    await tryIt("core", () => window.__TAURI__.core.invoke("agent_connect", { kind: "claude" }));
    await tryIt("internals", () => window.__TAURI_INTERNALS__.invoke("agent_connect", { kind: "claude" }));
    // (an HTTP answer is judged by its body: the command's own refusal comes back as a non-2xx response naming not_bundled)
    for (const u of ["ipc://localhost/agent_connect", "http://ipc.localhost/agent_connect"])
      await tryIt(u, async () => { const r = await fetch(u, { method: "POST", body: '{"kind":"claude"}', headers: { "Content-Type": "application/json", "Tauri-Callback": "1", "Tauri-Error": "2" } }); const b = await r.text().catch(() => ""); if (r.ok) return b; throw "HTTP " + r.status + " " + b; });
    parent.postMessage({ sbAgentsProbe: out }, "*");
  })();<\/script>`;
  return new Promise((res) => {
    const f = document.createElement("iframe");
    f.setAttribute("sandbox", "allow-scripts");
    f.style.display = "none";
    const done = (v: any) => { removeEventListener("message", on); f.remove(); res(v); };
    const on = (e: MessageEvent) => { if (e.source === f.contentWindow && e.data?.sbAgentsProbe) done(e.data.sbAgentsProbe); };
    addEventListener("message", on);
    setTimeout(() => done({ bootstrap: "?", results: {} }), 15000);
    f.srcdoc = probe;
    document.body.append(f);
  });
}
