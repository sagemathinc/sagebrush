// The remote kernel's UI, as a preview (sagebrush-remote.js, loaded only by
// a page opened with ?remote=1; web/build.ts builds it for the web site, not
// for the CLI or the app).  It joins what P1a and P1b built: a RemoteKernel
// (remote-kernel.js) on a RemoteClient (remote-client.js, DPoP), with every
// run approved by a RemoteGate (remote-gate.js), to a gateway.
//
// There is no gateway yet, so the preview's is simulated, in this page: the
// in-memory gateway of the tests (remote-fake.js), whose runs execute on a
// second interpreter in this browser, apart from the notebook's own (as a
// remote kernel's variables are apart).  Everything up to the gateway is the
// real path: the Connect sheet, the person's consent at each Run, each run
// checked and admitted right before it is sent, DPoP-signed requests, the
// event stream and the notes.  Nothing leaves the page, and nothing is billed.
//
//   const remote = await import("sagebrush-remote.js");
//   if (await remote.connectSheet()) {
//     const r = await remote.startPreview({ notebook: id, local: makeLocalKernel(), onStatus });
//     nb.setKernel(r.kernel);   // the page's createNotebook({remoteGate: remote.gateFor})
//   }

import { RemoteClient } from "./remote-client.js";
import { RemoteKernel } from "./remote-kernel.js";
import { RemoteGate } from "./remote-gate.js";
import { FakeGateway } from "./remote-fake.js";

// (the simulated gateway's address: https, as the client requires; never fetched, its fetch is the fake's)
const PREVIEW_BASE = "https://compute.preview.invalid/api/compute/v1";
const INTERACT_NOTE = "(interactive controls aren't shown from a remote kernel yet)\n";

/** SHA-256, hex: the approvals' hash (remote-approval.ts). */
export async function sha256Hex(text) {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  let s = "";
  for (const b of d) s += b.toString(16).padStart(2, "0");
  return s;
}

/** The page's remote gate for a remote kernel: createNotebook's opts.remoteGate. */
export function gateFor(kernel, page) {
  return new RemoteGate({ kernel, hash: sha256Hex, page });
}

/**
 * The simulated gateway: the tests' fake, whose kernel is `local` (a
 * Kernel, web/notebook/types.ts), each run executed there with exactly the
 * options the run's payload carries, its output streamed as the gateway's
 * events while it runs.  Stop and Restart reach the local interpreter too.
 */
export class PreviewGateway extends FakeGateway {
  constructor(local, opts = {}) {
    super({ base: PREVIEW_BASE, ...opts });
    this.local = local;
    this.payloads = new Map(); // request -> its payload, until its run starts
    this.kernel = (code, run) => this.runLocal(code, run);
  }

  post_runs(b, body) {
    if (body && typeof body.request === "string" && !this.runs.has(body.request) && body.payload) this.payloads.set(body.request, body.payload);
    const res = super.post_runs(b, body);
    // (a run the fake refused never starts: its payload isn't kept)
    if (!this.runs.has(body?.request)) this.payloads.delete(body?.request);
    return res;
  }

  runLocal(code, run) {
    const p = this.payloads.get(run.request) ?? {};
    this.payloads.delete(run.request);
    const opts = {
      mode: typeof p.mode === "string" ? p.mode : "python",
      ...(p.cell ? { cell: String(p.cell) } : {}),
      ...(Array.isArray(p.forget) && p.forget.length ? { forget: [...p.forget] } : {}),
      ...(p.mangle ? { mangle: true } : {}),
      ...(p.seed ? { seed: p.seed } : {}),
      ...(p.scoped && typeof p.scoped === "object" ? { scoped: { ...p.scoped } } : {}),
    };
    // (output after the run's terminal, e.g. once a restart settled it, goes nowhere)
    const emit = (ev) => { if (!run.outcome) this.emitEvent(run, ev); };
    return new Promise((resolve) => {
      let ended = false;
      const end = (outcome) => { if (!ended) { ended = true; resolve({ events: [], outcome }); } };
      this.local.execute(code, opts, {
        start() {},
        out: (text, isError) => emit({ type: "stream", name: isError ? "stderr" : "stdout", text: String(text) }),
        display: (data) => emit({ type: "display", data }),
        interact: () => emit({ type: "stream", name: "stderr", text: INTERACT_NOTE }),
        clear: () => emit({ type: "clear" }),
        done: (ms, info) => end(info?.error ? { status: "error", ms, ...(info.interrupted ? { ename: "KeyboardInterrupt" } : {}) } : { status: "ok", ms }),
        stopped: () => end({ status: "error", ename: "KeyboardInterrupt", ms: 0 }),
        skipped: () => end({ status: "refused", reason: "cancelled" }),
      });
    });
  }

  post_interrupt(b, body) {
    const res = super.post_interrupt(b, body);
    if (body?.epoch === b.epoch) this.local.interrupt();
    return res;
  }

  post_restart(b, body) {
    const before = b.incarnation;
    const res = super.post_restart(b, body);
    if (b.incarnation !== before) this.local.restart();
    return res;
  }
}

/**
 * Start a remote kernel on the simulated gateway, for the notebook `notebook`
 * (its id), running on `local` (a fresh interpreter: its variables are the
 * remote kernel's).  Resolves to {kernel, gateway, close()} once it is bound,
 * or rejects with why.
 */
export async function startPreview({ notebook, local, onStatus = () => {} }) {
  const gateway = new PreviewGateway(local);
  let token = null;
  const client = await RemoteClient.create({ base: gateway.base, token: () => token, fetch: gateway.fetch });
  token = gateway.issueToken(client.jkt);
  local.start?.();
  const kernel = new RemoteKernel({ client, notebook: String(notebook ?? "notebook"), requireGate: true });
  kernel.preview = true;
  const off = kernel.on("status", (text) => onStatus(statusText(text)));
  await kernel.start();
  if (!kernel.ready) {
    off();
    kernel.close();
    local.close?.();
    throw new Error("the remote kernel did not start");
  }
  return {
    kernel,
    gateway,
    close() {
      off();
      kernel.close();
      local.close?.();
    },
  };
}

/** The status line's text for a remote kernel's status (the preview says so). */
export function statusText(text) {
  const t = String(text ?? "");
  return /^ready \(remote\)/.test(t) ? `GPU kernel (preview, simulated) · ${t.replace(/^ready \(remote\)/, "ready")}` : `GPU kernel (preview): ${t}`;
}

// ------------------------------------------------------------- the Connect sheet

const CSS = `
#remotedlg { border: 1px solid var(--line); border-radius: 10px; background: var(--cell); color: var(--fg); padding: 16px 18px; width: min(560px, 92vw); }
#remotedlg::backdrop { background: rgba(0,0,0,.35); }
#remotedlg h2 { margin: 0 0 8px; font-size: 17px; }
#remotedlg .preview { margin: 0 0 10px; padding: 8px 10px; border-radius: 6px; background: var(--code); font-size: 13px; }
#remotedlg ul { margin: 6px 0 10px; padding-left: 20px; font-size: 14px; }
#remotedlg li { margin: 3px 0; }
#remotedlg .cap { display: flex; gap: 8px; align-items: center; font-size: 14px; }
#remotedlg .cap input { width: 5em; font: inherit; }
#remotedlg .note { color: var(--muted); font-size: 12px; margin: 4px 0 12px; }
#remotedlg .acts { display: flex; gap: 8px; justify-content: flex-end; }
`;

/** The Connect sheet's text (the plan's §5 consent copy and §9.1 cap field, marked as a preview). */
export const SHEET = {
  title: "Connect a GPU kernel",
  preview: "Preview: this connects to a simulated gateway in this page. Your cells run through the remote kernel's path, approvals included, but execute in this browser. Nothing is sent anywhere, and nothing is billed.",
  intro: "When it is real, connecting gives Sagebrush:",
  points: [
    "full control of the Sagebrush compute space, which all of your account's notebooks share;",
    "code that runs there can read the sandbox's keys;",
    "you can revoke access in CoCalc at any time; new code stops within a few seconds.",
  ],
  approve: "Only the cells you run are sent, each exactly as it is on screen when you run it. A cell that changes before it is sent isn't run.",
  cap: "Proposed spending cap: $",
  capNote: "You'll confirm the cap on CoCalc's page; that's the one that counts.",
  allow: "Connect",
  cancel: "Cancel",
};

/**
 * Show the Connect sheet; resolves to {cap} if the person connects, or null.
 * `doc` is the page's document (tests give their own).
 */
export function connectSheet(doc = document) {
  if (!doc.getElementById("remotedlgcss")) {
    const st = doc.createElement("style");
    st.id = "remotedlgcss";
    st.textContent = CSS;
    doc.head.append(st);
  }
  doc.getElementById("remotedlg")?.remove();
  const el = (tag, text, props = {}) => Object.assign(doc.createElement(tag), text == null ? {} : { textContent: text }, props);
  const dlg = el("dialog", null, { id: "remotedlg" });
  dlg.setAttribute("aria-labelledby", "remotetitle");
  const ul = el("ul");
  for (const p of SHEET.points) ul.append(el("li", p));
  const capIn = el("input", null, { type: "number", min: "1", max: "1000", step: "1", value: "10", id: "remotecap" });
  capIn.setAttribute("aria-label", "Proposed spending cap in dollars");
  const cap = el("label", null, { className: "cap" });
  cap.append(SHEET.cap, capIn);
  const ok = el("button", SHEET.allow, { className: "primary", id: "remoteallow" });
  const no = el("button", SHEET.cancel, { id: "remotecancel" });
  const acts = el("div", null, { className: "acts" });
  acts.append(no, ok);
  dlg.append(el("h2", SHEET.title, { id: "remotetitle" }), el("p", SHEET.preview, { className: "preview" }), el("div", SHEET.intro), ul, el("p", SHEET.approve), cap, el("p", SHEET.capNote, { className: "note" }), acts);
  doc.body.append(dlg);
  return new Promise((resolve) => {
    let answer = null;
    ok.addEventListener("click", () => {
      const n = Number(capIn.value);
      answer = { cap: Number.isFinite(n) && n >= 1 ? Math.min(1000, Math.floor(n)) : 10 };
      dlg.close();
    });
    no.addEventListener("click", () => dlg.close());
    dlg.addEventListener("close", () => {
      dlg.remove();
      resolve(answer);
    });
    if (typeof dlg.showModal === "function") dlg.showModal();
    else dlg.setAttribute("open", "");
    // (focus on the text first, not on Connect: Enter doesn't connect)
    dlg.tabIndex = -1;
    dlg.focus?.();
  });
}
