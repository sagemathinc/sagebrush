// The desktop app's self-test probe of its workspace on disk (part of sagebrush-desktop.js, web/workspace/desktop-entry.ts).
// The two-launch check (SAGEBRUSH_APP_PERSIST, app/selftest/run.mjs; the workspace on disk,
// web/workspace/disk-mirror.ts): "write:<token>" makes a data file, a notebook and a board in the workspace and a
// setting, and waits until they are on disk (the mirror drained, the settings written); then times the disk's
// write-through of a large notebook, board and data file, and deletes those.  "check:<token>", in the next launch
// (on another port: another origin, and a web view that kept nothing), finds the four, the data file as another
// program changed it on disk between the launches, then deletes them for good, waits for the disk, and finds them
// gone from it.  Each launch also reads what the page has in this web view: cross-origin isolation and
// SharedArrayBuffer, in the page and in a worker (required: the page's own interpreter's Stop needs them, and this
// check runs without the engine subprocess) and OPFS (said only).  One report line, then the app exits.
export async function persistProbe(spec: string, host: { ws: () => Promise<any>; mirror: () => any; invoke: (c: string, a?: any) => Promise<any> }) {
  const [mode, token] = [spec.slice(0, spec.indexOf(":")), spec.slice(spec.indexOf(":") + 1)];
  const f = `/sagebrush-persist-${token}.txt`, n = `/sagebrush-persist-${token}.ipynb`, b = `/sagebrush-persist-${token}.board.json`;
  const SETTING = "sagebrush-files-sort", dec = (c: any) => (typeof c === "string" ? c : new TextDecoder().decode(c));
  let ok = false, line = "";
  const caps = async () => {
    const worker = await new Promise<string>((res) => { const w = new Worker(URL.createObjectURL(new Blob(["postMessage(typeof SharedArrayBuffer)"], { type: "text/javascript" }))); w.onmessage = (e: MessageEvent) => { res(e.data); w.terminate(); }; w.onerror = () => res("error"); setTimeout(() => res("no answer"), 5000); });
    let opfs = "none";
    try { const d = await navigator.storage.getDirectory(), h = await d.getFileHandle("sb-probe", { create: true }), w = await (h as any).createWritable(); await w.write("x"); await w.close(); opfs = (await (await h.getFile()).text()) === "x" ? "ok" : "read back wrong"; } catch (e: any) { opfs = "error: " + (e?.name ?? e); }
    const need = window.crossOriginIsolated === true && typeof SharedArrayBuffer === "function" && worker === "function";
    return { need, text: `isolated=${window.crossOriginIsolated} sab=${typeof SharedArrayBuffer} worker-sab=${worker} opfs=${opfs}` };
  };
  const settled = async (m: any) => {
    if (!(await m.drain(60000))) throw new Error(`the disk didn't take ${m.pending} changes within 60 s${m.failing ? `: ${m.failing[1]?.message ?? m.failing[1]}` : ""}`);
    await (window as any).__sbSettingsFlush?.();
  };
  try {
    const ws = await host.ws(), m = host.mirror();
    if (!ws) throw new Error("the workspace didn't open");
    if (!m) throw new Error("no disk workspace");
    if (mode === "write") {
      await ws.create(f, { content: token });
      await ws.create(n, { content: { nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [{ cell_type: "code", source: `token = "${token}"`, metadata: {}, outputs: [], execution_count: null }] } });
      await ws.create(b);
      localStorage.setItem(SETTING, "probe-" + token);
      await settled(m);
      // (the write-through's time for large ones: a notebook of 2,000 cells, a board of 2,000 notes, 20 MiB of data)
      const big = [
        [`/sagebrush-big-${token}.ipynb`, { nbformat: 4, nbformat_minor: 5, metadata: {}, cells: Array.from({ length: 2000 }, (_, i) => ({ cell_type: "code", source: `x${i} = ${i} * 2\nprint(x${i})`, metadata: {}, outputs: [], execution_count: null })) }],
        [`/sagebrush-big-${token}.board.json`, { nodes: Array.from({ length: 2000 }, (_, i) => ({ id: `n${i}`, text: `note ${i} `.repeat(20) })), edges: [] }],
        [`/sagebrush-big-${token}.bin`, new Uint8Array(20 * 2 ** 20).fill(7)],
      ] as const;
      const times: string[] = [];
      for (const [p, content] of big) {
        const t0 = performance.now();
        await ws.create(p, { content });
        await settled(m);
        const st = await host.invoke("disk_stat", { path: p });
        times.push(`${p.slice(p.lastIndexOf("."))} ${st ? Math.round(st.size / 1024) + " KiB" : "NOT on disk"} in ${Math.round(performance.now() - t0)} ms`);
      }
      for (const [p] of big) { const t = await ws.remove(p); await ws.emptyTrash([t.path]); }
      await settled(m);
      const c = await caps(), where = await host.invoke("disk_where");
      ok = c.need;
      line = `made ${f}, ${n}, ${b} and a setting at ${location.origin}, in ${where}; write-through: ${times.join(", ")}; ${c.text}`;
    } else if (mode === "check") {
      const text = dec((await ws.read(f)).content);
      const nbOk = JSON.stringify((await ws.read(n)).content).includes(token);
      const bOk = !!(await ws.stat(b));
      const setting = localStorage.getItem(SETTING);
      for (const p of [f, n, b]) { const t = await ws.remove(p); await ws.emptyTrash([t.path]); }
      localStorage.removeItem(SETTING);
      await settled(m);
      const left = [];
      for (const p of [f, n, b]) if ((await host.invoke("disk_stat", { path: p })) !== null) left.push(p);
      const c = await caps();
      ok = text === token + "-edited" && nbOk && bOk && setting === "probe-" + token && !left.length && c.need;
      line = `found at ${location.origin}: the data file ${text === token + "-edited" ? "as changed on disk between the launches" : `holding ${JSON.stringify(text.slice(0, 40))}`}, the notebook ${nbOk ? "with its cell" : "WITHOUT its cell"}, the board ${bOk ? "" : "NOT "}there, the setting ${setting === "probe-" + token ? "kept" : `${JSON.stringify(setting)}`}; deleted, and ${left.length ? `STILL on disk: ${left.join(", ")}` : "all three gone"} from disk; ${c.text}`;
    } else if (mode === "nav") {
      // "nav:<origin>": who can reach the app's commands (its window's capability gives them to the page's exact
      // origin, http://127.0.0.1:<the port the app holds>, app/src-tauri/src/nav.rs).  The token is another local server's origin
      // (run.mjs's), whose pages, if they ever load here, try the commands and say so to that server.
      //  1. a notebook output's frame, as the page makes one (sandbox="allow-scripts", srcdoc: an opaque origin,
      //     and on Windows the app's invoke bootstrap is in it too): a harmless command of the app's (disk_where)
      //     and the fs plugin's exists, through every way it has (window.__TAURI__, __TAURI_INTERNALS__, a request
      //     of its own to the IPC endpoints): each must be refused;
      //  2. the same from this page: its own command must succeed (the control), and the fs plugin must be refused there
      //     too, as it isn't the page's (the person's files reach it only by the app's grants, disk.rs);
      //  3. a frame and a window of the other origin, then this window sent there: the window must stay on this
      //     page (app/src-tauri/src/nav.rs), its commands still working.  What the other origin's pages reached is
      //     run.mjs's to judge, from its server.
      const other = token;
      const where = await host.invoke("disk_where");
      // (this page's own: its commands work (disk_where), and the fs plugin isn't its: no __TAURI__.fs, and plugin:fs
      // refused when asked directly (app/src-tauri/capabilities/default.json; the person's files by the app's grants)
      const fsOk = await (window as any).__TAURI_INTERNALS__.invoke("plugin:fs|exists", { path: where }).then((x: any) => `REACHED ${x}`, (e: any) => `refused: ${e?.message ?? e}`);
      const fsGlobal = typeof (window as any).__TAURI__?.fs;
      const mainOk = typeof where === "string" && where.length > 0 && fsOk.startsWith("refused") && fsGlobal === "undefined";
      const probe = `<script>(async () => {
        const out = {}, say = () => parent.postMessage({ sbIpcProbe: out }, "*");
        const tryIt = async (k, f) => { try { const v = await f(); out[k] = "REACHED " + String(v).slice(0, 40); } catch (e) { out[k] = "refused: " + String(e && e.message || e).slice(0, 80); } };
        out.bootstrap = typeof window.__TAURI_INTERNALS__ === "object" ? "present" : "absent";
        await tryIt("core.disk_where", () => window.__TAURI__.core.invoke("disk_where"));
        await tryIt("internals.disk_where", () => window.__TAURI_INTERNALS__.invoke("disk_where"));
        await tryIt("fs.exists", () => window.__TAURI__.fs.exists(${JSON.stringify(where)}));
        await tryIt("internals.fs.exists", () => window.__TAURI_INTERNALS__.invoke("plugin:fs|exists", { path: ${JSON.stringify(where)} }));
        for (const u of ["ipc://localhost/disk_where", "http://ipc.localhost/disk_where"])
          await tryIt("fetch " + u, async () => { const r = await fetch(u, { method: "POST", body: "{}", headers: { "Content-Type": "application/json", "Tauri-Callback": "1", "Tauri-Error": "2" } }); if (!r.ok) throw new Error("HTTP " + r.status + " " + (await r.text()).slice(0, 60)); return await r.text(); });
        say();
      })();<\/script>`;
      const frameOut: any = await new Promise((res) => {
        const f = document.createElement("iframe");
        f.setAttribute("sandbox", "allow-scripts");
        f.style.display = "none";
        const done = (v: any) => { removeEventListener("message", on); f.remove(); res(v); };
        const on = (e: MessageEvent) => { if (e.source === f.contentWindow && e.data?.sbIpcProbe) done(e.data.sbIpcProbe); };
        addEventListener("message", on);
        setTimeout(() => done(null), 20000);
        f.srcdoc = probe;
        document.body.append(f);
      });
      const reached = frameOut ? Object.entries(frameOut).filter(([, v]) => String(v).startsWith("REACHED")).map(([k]) => k) : ["(no answer from the frame)"];
      // (3: the other origin, as a frame, a window, then this window itself)
      const ff = document.createElement("iframe");
      ff.style.display = "none";
      ff.src = other + "/frame";
      document.body.append(ff);
      try { window.open(other + "/open", "_blank"); } catch {}
      await new Promise((r) => setTimeout(r, 3000));
      const here = location.href;
      location.href = other + "/top";
      await new Promise((r) => setTimeout(r, 5000));
      const stayed = location.href === here;
      const stillOk = await host.invoke("disk_where").then((w: any) => w === where, () => false);
      ok = mainOk && !!frameOut && !reached.length && stayed && stillOk;
      line = `nav at ${location.origin}: this page's commands ${mainOk ? "work" : `FAIL (disk_where ${JSON.stringify(where)}, the page's plugin:fs ${fsOk}, __TAURI__.fs ${fsGlobal})`}; an output frame (bootstrap ${frameOut?.bootstrap ?? "?"}): ${reached.length ? `REACHED ${reached.join(", ")}` : "every way refused"} ${JSON.stringify(frameOut)}; sent to ${other}: ${stayed ? "stayed on this page" : "LEFT this page"}, its commands ${stillOk ? "still work" : "FAIL"}`;
    } else line = `no such mode ${JSON.stringify(mode)}`;
  } catch (e: any) { line = `${mode} at ${location.origin}: ${e?.message ?? e}`; }
  await host.invoke("selftest_report", { report: `${ok ? "ok" : "FAIL"} persist: ${line}`, ok });
}
