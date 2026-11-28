// The Sync panel's end-to-end encryption section (plan notes m2-e2e-opt-in-plan; DEV only: drawn only where the E2E
// routes answer). What it offers depends on the account's key chain and this browser's sync:
// - no chain, and sync never used for the account: "Turn on encrypted sync…": a confirm (what end-to-end means here,
//   and that losing this browser's keys and the recovery code loses the files), the browser's name, genesis
//   (DeviceKeys.create), the recovery code shown once, then sync turned on by the panel's own flow;
// - no chain, and sync on or used before: no switch, a line saying to delete the synced data first (an account's
//   index is plaintext or sealed, never both: the server refuses genesis over plaintext changes);
// - a chain, and this browser's device: that it is on, and, if its recovery code may never have been saved, so;
// - a chain this browser can't use: the owner's reason, and for a refused chain (forked, another account's), "Reset
//   this device…", whose confirm says plainly what is lost.
// The recovery code lives only in the dialog's closure while it is open: never stored, logged or kept in the DOM
// after it closes (a JS string can't be zeroed; the reference is dropped).
import { e2eAccountOf } from "./e2e-here";
import { FORKED, NO_DEVICE, WRONG_ACCOUNT, type E2EChunk } from "./sync-e2e";

export type E2EPanelDeps = {
  /** the account's key chain as the server answers it (its status, and its entries when 200) */
  chain(): Promise<{ status: number; entries?: unknown }>;
  /** the E2E chunk (sagebrush-e2e.js) */
  chunk(): Promise<Pick<E2EChunk, "DeviceKeys" | "resetDevice">>;
  /** the signed-in account's hash (its sync namespace's first part), or null when unknown */
  hash(): Promise<string | null>;
  /** this browser's sync for the account: whether on, and whether it was used here or for the account before */
  sync(): { on: boolean; used: boolean };
  /** turn sync on, by the panel's own flow (its lease and first sync) */
  enable(): Promise<void>;
  /** the owner's reason when it started no client for an end-to-end account (sync-e2e.ts), if any */
  reason(): string | undefined;
  /** the owner asked to decide again (after genesis or a reset) */
  reconcile(): void;
  confirm(text: string): boolean;
  prompt(text: string, value: string): string | null;
  /** where the recovery code's dialog is shown (the page's body) */
  modalHost?: HTMLElement;
};

function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) (el as unknown as Record<string, unknown>)[k] = v;
  el.append(...kids);
  return el;
}
const btn = (text: string, onclick: () => void, cls = "") => { const b = h("button", { textContent: text, className: cls }); b.onclick = onclick; return b; };

export const TURN_ON_CONFIRM = "Turn on end-to-end encrypted sync for your account?\n\nYour files will be encrypted in this browser before they are synced: the server can't read them. This browser gets its own keys, and you get a recovery code, shown once. If you lose both this browser's keys and the recovery code, your encrypted files can't be recovered by anyone.";
export const RESET_CONFIRM = "Reset this device?\n\nThis browser's encryption keys for your account will be deleted. To sync here again you'll need another of your devices or your recovery code. If you have neither, your encrypted files can't be recovered: not by you, and not by Sagebrush.";
export const USED_LINE = "To encrypt this account's sync end to end, first delete your synced data (above), then turn on encrypted sync.";
export const UNCONFIRMED_LINE = "This browser's recovery code may never have been saved. Until you can make a new one, keep this browser: if you lose it, your encrypted files can't be recovered.";
export const ON_LINE = "End-to-end encryption is on for your account, in this browser.";
const LABEL_MAX = 64;

/** Words for a turn-on that failed, by DeviceKeys' code. */
function failWords(e: unknown): string {
  const code = (e as { code?: string })?.code, message = (e as Error)?.message ?? String(e);
  if (code === "exists") return "End-to-end encryption is already on for this account.";
  if (code === "plaintext_log") return USED_LINE;
  if (code === "wrong_account") return WRONG_ACCOUNT;
  if (code === "no_crypto") return "This browser can't keep end-to-end keys safely, so encryption can't be turned on here.";
  return `End-to-end encryption couldn't be turned on: ${message}.`;
}

/**
 * The recovery code's dialog: the code, Copy and Download, and a Close that stays disabled until the person ticks
 * that they saved it. Resolves once closed, the code's text gone from the DOM and its reference dropped.
 */
export function showRecoveryCode(host: HTMLElement, recoveryCode: string): Promise<void> {
  let code: string | null = recoveryCode;
  return new Promise((done) => {
    const pre = h("pre", { className: "e2e-code", textContent: code });
    const copied = h("span", { className: "note" });
    const copy = btn("Copy", () => {
      if (code === null) return;
      void navigator.clipboard?.writeText(code).then(() => { copied.textContent = " Copied"; }, () => { copied.textContent = " Couldn't copy: select the code instead"; });
    });
    const download = btn("Download as a text file", () => {
      if (code === null) return;
      const url = URL.createObjectURL(new Blob([`Sagebrush recovery code\n\n${code}\n`], { type: "text/plain" }));
      // (no account id in the name; the URL revoked right after the click)
      const a = h("a", { href: url, download: "sagebrush-recovery-code.txt" });
      a.click();
      URL.revokeObjectURL(url);
    });
    const tick = h("input", { type: "checkbox" }) as HTMLInputElement;
    const close = btn("Close", () => {
      if (!tick.checked) return;
      pre.textContent = "";
      code = null;
      box.close();
      box.remove();
      done();
    });
    close.disabled = true;
    tick.onchange = () => { close.disabled = !tick.checked; };
    // (a modal dialog, as the page's others: Escape doesn't close it, only Close once ticked)
    const box = h("dialog", { className: "e2e-code-dialog" },
      h("h4", { textContent: "Your recovery code" }),
      h("p", { textContent: "Save this code somewhere safe, away from this browser. It's shown only now. With it you can set up another device, or get your files back if you lose this browser." }),
      pre, h("p", {}, copy, " ", download, copied),
      h("label", {}, tick, " I've saved my recovery code somewhere safe"), h("p", {}, close));
    box.oncancel = (e) => e.preventDefault();
    host.append(box);
    box.showModal();
  });
}

/** The section, drawn into `into`; refresh() draws it again from what the server and the owner say now. */
export function e2eSection(into: HTMLElement, deps: E2EPanelDeps): { refresh(): Promise<void>; busy(): boolean } {
  let working = false, gen = 0;
  const line = (text: string, cls = "note") => h("p", { className: cls, textContent: text });
  const fail = (text: string) => { into.append(line(text, "note error")); };

  async function turnOn() {
    if (working) return;
    if (!deps.confirm(TURN_ON_CONFIRM)) return;
    const typed = deps.prompt("A name for this browser, so you can tell your devices apart:", "This browser");
    if (typed === null) return;
    const label = (typed.trim() || "This browser").slice(0, LABEL_MAX);
    working = true;
    try {
      const hash = await deps.hash();
      if (!hash) throw new Error("the signed-in account isn't known yet");
      const m = await deps.chunk();
      const made = await m.DeviceKeys.create(label, e2eAccountOf(hash));
      await showRecoveryCode(deps.modalHost ?? document.body, made.recoveryCode);
      // (the device confirmed only now: the person said they saved the code)
      await made.confirm();
      await deps.enable();
      deps.reconcile();
      working = false;
      await refresh();
    } catch (e) {
      working = false;
      await refresh();
      fail(failWords(e));
    }
  }

  async function reset() {
    if (working || !deps.confirm(RESET_CONFIRM)) return;
    working = true;
    try {
      const hash = await deps.hash();
      if (!hash) throw new Error("the signed-in account isn't known yet");
      await (await deps.chunk()).resetDevice(e2eAccountOf(hash));
      deps.reconcile();
      working = false;
      await refresh();
    } catch (e) {
      working = false;
      await refresh();
      fail(`This device couldn't be reset: ${(e as Error)?.message ?? e}.`);
    }
  }

  async function refresh(): Promise<void> {
    const mine = ++gen;
    let chain: { status: number; entries?: unknown };
    try {
      chain = await deps.chain();
    } catch {
      chain = { status: 0 };
    }
    if (mine !== gen) return;
    // (the routes off: nothing of end-to-end encryption here)
    if (chain.status === 404) { into.replaceChildren(); return; }
    const out: Node[] = [h("h4", { textContent: "End-to-end encryption" })];
    const reason = deps.reason();
    if (chain.status !== 200 || !Array.isArray(chain.entries)) out.push(line("Can't check end-to-end encryption right now."));
    else if (reason === FORKED || reason === WRONG_ACCOUNT) out.push(line(reason), btn("Reset this device…", () => void reset(), "danger"));
    else if (reason === NO_DEVICE) out.push(line(reason));
    else if (chain.entries.length > 0) {
      out.push(line(ON_LINE));
      // (whether this browser's code may never have been saved: from its device, loaded and verified as sync does)
      try {
        const hash = await deps.hash();
        const k = hash ? await (await deps.chunk()).DeviceKeys.load(e2eAccountOf(hash)) : null;
        if (mine !== gen) return;
        if (k?.recoveryUnconfirmed) out.push(line(UNCONFIRMED_LINE, "note warn"));
      } catch { /* (the owner's own reason says what is wrong; nothing more here) */ }
      if (reason) out.push(line(reason));
    } else {
      const s = deps.sync();
      if (s.on || s.used) out.push(line(USED_LINE));
      else out.push(line("Encrypt your files in this browser before they are synced, so the server can't read them."), btn("Turn on encrypted sync…", () => void turnOn()));
    }
    if (mine !== gen) return;
    into.replaceChildren(...out);
  }

  return { refresh, busy: () => working };
}
