// The desktop app's self-test probe of its workspace on disk (part of sagebrush-desktop.js, web/workspace/desktop-entry.ts).
// The two-launch check (SAGEBRUSH_APP_PERSIST, app/selftest/run.mjs; the workspace on disk,
// web/workspace/disk-mirror.ts): "write:<token>" makes a data file, a notebook and a board in the workspace and a
// setting, and waits for them to be on disk; "check:<token>", in the next launch (on another port: another origin,
// and a web view that kept nothing), finds them all, the data file as another program changed it on disk between
// the launches, then deletes them for good and finds them gone from disk.  Also said: what the page has in this
// web view (cross-origin isolation, SharedArrayBuffer, a worker, OPFS).  One report line, then the app exits.
export async function persistProbe(spec: string, host: { ws: () => Promise<any>; mirror: () => any; invoke: (c: string, a?: any) => Promise<any> }) {
  const [mode, token] = [spec.slice(0, spec.indexOf(":")), spec.slice(spec.indexOf(":") + 1)];
  const f = `/sagebrush-persist-${token}.txt`, n = `/sagebrush-persist-${token}.ipynb`, b = `/sagebrush-persist-${token}.board.json`;
  const SETTING = "sagebrush-files-sort", dec = (c: any) => (typeof c === "string" ? c : new TextDecoder().decode(c));
  let ok = false, line = "";
  const caps = async () => {
    const worker = await new Promise<string>((res) => { const w = new Worker(URL.createObjectURL(new Blob(["postMessage(typeof SharedArrayBuffer)"], { type: "text/javascript" }))); w.onmessage = (e: MessageEvent) => { res(e.data); w.terminate(); }; w.onerror = () => res("error"); setTimeout(() => res("no answer"), 5000); });
    let opfs = "none";
    try { const d = await navigator.storage.getDirectory(), h = await d.getFileHandle("sb-probe", { create: true }), w = await (h as any).createWritable(); await w.write("x"); await w.close(); opfs = (await (await h.getFile()).text()) === "x" ? "ok" : "read back wrong"; } catch (e: any) { opfs = "error: " + (e?.name ?? e); }
    return `isolated=${window.crossOriginIsolated} sab=${typeof SharedArrayBuffer} worker-sab=${worker} opfs=${opfs}`;
  };
  try {
    const ws = await host.ws(), diskMirror = host.mirror();
    if (!ws) throw new Error("the workspace didn't open");
    if (!diskMirror) throw new Error("no disk workspace");
    if (mode === "write") {
      await ws.create(f, { content: token });
      await ws.create(n, { content: { nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [{ cell_type: "code", source: `token = "${token}"`, metadata: {}, outputs: [], execution_count: null }] } });
      await ws.create(b);
      localStorage.setItem(SETTING, "probe-" + token);
      await diskMirror.flushed();
      await new Promise((r) => setTimeout(r, 500));
      const where = await host.invoke("disk_where");
      [ok, line] = [true, `made ${f}, ${n}, ${b} and a setting at ${location.origin}, in ${where}; ${await caps()}`];
    } else if (mode === "check") {
      const text = dec((await ws.read(f)).content);
      const nbOk = JSON.stringify((await ws.read(n)).content).includes(token);
      const bOk = !!(await ws.stat(b));
      const setting = localStorage.getItem(SETTING);
      for (const p of [f, n, b]) { const t = await ws.remove(p); await ws.emptyTrash([t.path]); }
      localStorage.removeItem(SETTING);
      await diskMirror.flushed();
      const gone = (await host.invoke("disk_stat", { path: f })) === null;
      ok = text === token + "-edited" && nbOk && bOk && setting === "probe-" + token && gone;
      line = `found at ${location.origin}: the data file ${text === token + "-edited" ? "as changed on disk between the launches" : `holding ${JSON.stringify(text.slice(0, 40))}`}, the notebook ${nbOk ? "with its cell" : "WITHOUT its cell"}, the board ${bOk ? "" : "NOT "}there, the setting ${setting === "probe-" + token ? "kept" : `${JSON.stringify(setting)}`}; deleted, and ${gone ? "gone" : "STILL"} on disk; ${await caps()}`;
    } else line = `no such mode ${JSON.stringify(mode)}`;
  } catch (e: any) { line = `${mode} at ${location.origin}: ${e?.message ?? e}`; }
  await host.invoke("selftest_report", { report: `${ok ? "ok" : "FAIL"} persist: ${line}`, ok });
}

