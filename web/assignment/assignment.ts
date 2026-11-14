// An assignment opened from a course, on the notebook page (/#assignment=<key>): the student's copy, made in their
// own account and opened from it on any computer.  The assignment's page (/s/#lti=…) hands over in this tab
// (share-client/handover.ts); this module takes it from there, one step at a time, each said in plain words:
//
//   1. the hand-over: gone or expired, "Open the assignment again from your course";
//   2. signed out: Sign in (CoCalc), in this tab, back to this same address; the hand-over is kept meanwhile;
//   3. signed in, sync not available for the account: said in the server's words; no copy anywhere else;
//   4. signed in, sync off in this browser: the consent screen (the account, what of this browser's goes into it,
//      the shared-computer choice), and sync turned on only by the person's press;
//   5. sync on: "Finding your work…", then the copy is started or found (startAssignmentCopy, which waits until this
//      browser has everything the account holds, and makes one copy across devices); "arriving" waits for the other
//      device's copy; a refusal (storage full, …) in the server's words;
//   6. made or found: the hand-over is dropped, the first notebook opens, and once its creation is acknowledged by the
//      server the course's tool is told it was started (no account id, no content).
//
// Everything outside (the status call, sign-in's address, turning sync on, the copy, opening a notebook, the tool's
// call) is passed in, so the steps are tested on their own (test-assignment.mjs).

import { dropHandover, readHandover, type Handover } from "../share-client/handover";
import type { CopyFile, CopyResult, EnableResult } from "../workspace";

export type { CopyFile, CopyResult };
export type SyncStatus =
  | { signedIn: false }
  | { signedIn: true; account: string; available: boolean; reason?: string; on: boolean };

export interface Deps {
  key: string;
  storage?: Storage;
  now?: () => number;
  /** where the steps are shown (an element above the notebook) */
  ui: HTMLElement;
  status(signal: AbortSignal): Promise<SyncStatus>;
  /** sign-in's address, returning to `back` */
  signInUrl(back: string): string;
  navigate(url: string): void;
  /** this browser's local files, for the consent screen */
  localUsage(): Promise<{ files: { count: number; bytes: number } }>;
  enableSync(signal: AbortSignal): Promise<EnableResult>;
  /** the handout's files, checked against the bundle's SHA-256 (the hand-over's link); a notebook's content is its document */
  handout(h: Handover, signal: AbortSignal): Promise<CopyFile[]>;
  startCopy(a: { copyId: string; revision: string; title: string; files: CopyFile[]; signal: AbortSignal }): Promise<CopyResult>;
  onCopyReady(ref: string, cb: () => void): () => void;
  openNotebook(path: string): Promise<void>;
  /** true once everything of the copy's folder is acknowledged by the server */
  settled(folder: string, signal: AbortSignal): Promise<boolean>;
  /** the course's tool, told the copy was started (capability-bound; nothing about the account) */
  started(h: Handover): Promise<void>;
  /** the shared-computer choice, for this tab's session (sign-out then clears this browser's copy) */
  setShared(shared: boolean): void;
  /** the hand-over used (made, found or arriving): the page's address loses its #assignment= */
  left?(): void;
}

export const WORDS = {
  expired: "This assignment link has expired. Open the assignment again from your course.",
  signIn: "Sign in to make your copy in your CoCalc account. You can then open it from any computer.",
  noAccount: "No CoCalc account yet? Create a free one, then come back to this tab and sign in.",
  unavailable: (why: string) => `Your copy can't be kept in your account: ${why}`,
  finding: "Finding your work…",
  arriving: "Your copy is arriving from another computer where you started it…",
  refused: (why: string) => `Your copy couldn't be made in your account: ${why}`,
  off: "Sync was turned off in this browser, so your copy wasn't made. Turn it on again to go on.",
  timeout: "Sagebrush couldn't reach your account just now. Your copy wasn't made yet.",
  consent: (account: string) => `Your copy goes into your CoCalc account, ${account}, and you can open it from any computer.`,
  local: (files: number, sz: string) => `Turning on sync also puts this browser's Sagebrush files into that account: ${files} ${files === 1 ? "file" : "files"}, ${sz}.`,
  shared: "This is a shared computer: when I sign out, clear this browser's copy.",
};
const size = (n: number) => (n < 1e3 ? `${n} B` : n < 1e6 ? `${(n / 1e3).toFixed(1)} kB` : n < 1e9 ? `${(n / 1e6).toFixed(1)} MB` : `${(n / 1e9).toFixed(2)} GB`);

/** Run the steps.  Answers the step it ended at (for tests and the page). */
export async function runAssignment(d: Deps): Promise<string> {
  const storage = d.storage ?? sessionStorage, now = d.now ?? Date.now;
  const ui = d.ui;
  const el = (tag: string, text = "", cls = "") => {
    const e = document.createElement(tag);
    if (text) e.textContent = text;
    if (cls) e.className = cls;
    return e;
  };
  const show = (...parts: Node[]) => {
    ui.replaceChildren(...parts);
    ui.hidden = false;
  };
  const button = (text: string, primary: boolean, on: () => void) => {
    const b = el("button", text, primary ? "primary" : "") as HTMLButtonElement;
    b.type = "button";
    b.onclick = on;
    return b;
  };
  const again = () => button("Try again", true, () => void runAssignment(d));
  const ac = new AbortController();

  const h = readHandover(d.key, now(), storage);
  if (!h) {
    show(el("p", WORDS.expired));
    return "expired";
  }
  const title = el("h2", h.title);
  let st: SyncStatus;
  try {
    st = await d.status(ac.signal);
  } catch {
    show(title, el("p", WORDS.timeout), again());
    return "timeout";
  }
  if (!st.signedIn) {
    show(title, el("p", WORDS.signIn), button("Sign in", true, () => d.navigate(d.signInUrl(`/#assignment=${d.key}`))), el("p", WORDS.noAccount, "hint"));
    return "signin";
  }
  if (!st.available) {
    show(title, el("p", WORDS.unavailable(st.reason ?? "sync isn't available for this account.")));
    return "unavailable";
  }
  if (!st.on) {
    const usage = await d.localUsage().catch(() => ({ files: { count: 0, bytes: 0 } }));
    const box = el("label", "", "shared");
    const check = el("input") as HTMLInputElement;
    check.type = "checkbox";
    // (an assignment opened from a course is often on a lab computer: shared is the default answer)
    check.checked = true;
    box.append(check, document.createTextNode(" " + WORDS.shared));
    const parts: Node[] = [title, el("p", WORDS.consent(st.account))];
    if (usage.files.count > 0) parts.push(el("p", WORDS.local(usage.files.count, size(usage.files.bytes))));
    parts.push(box, button("Turn on sync", true, async () => {
      d.setShared(check.checked);
      const r = await d.enableSync(ac.signal);
      if (r.ok === false) {
        // (signed out meanwhile: back to the sign-in step; a network slip or a changed account: try again)
        if (r.why === "signedout") return void runAssignment(d);
        if (r.why === "unavailable") return show(title, el("p", WORDS.unavailable(r.message ?? "sync isn't available for this account.")));
        return show(title, el("p", r.why === "refused" ? WORDS.refused(r.message ?? "the server refused it.") : WORDS.timeout), again());
      }
      void runAssignment(d);
    }));
    show(...parts);
    return "consent";
  }

  show(title, el("p", WORDS.finding));
  let files: CopyFile[];
  try {
    files = await d.handout(h, ac.signal);
  } catch {
    show(title, el("p", WORDS.expired));
    return "expired";
  }
  const r = await d.startCopy({ copyId: h.copy, revision: h.revision, title: h.title, files, signal: ac.signal });
  if (r.state === "refused") {
    show(title, el("p", WORDS.refused(r.reason ?? "the server refused it.")), again());
    return "refused";
  }
  if (r.state === "off" || r.state === "timeout") {
    show(title, el("p", r.state === "off" ? WORDS.off : WORDS.timeout), again());
    return r.state;
  }
  // made or found: the hand-over has done its work (a relaunch hands over again)
  dropHandover(d.key, storage);
  d.left?.();
  const first = r.notebooks[0];
  if (r.state === "arriving") {
    show(title, el("p", WORDS.arriving));
    if (first) {
      const off = d.onCopyReady(first.ref, () => {
        off();
        ui.hidden = true;
        void d.openNotebook(first.path);
      });
    }
    return "arriving";
  }
  ui.hidden = true;
  if (first) await d.openNotebook(first.path);
  // (the tool hears of it only once the server has acknowledged the copy's creation)
  if (r.folder && (await d.settled(r.folder, ac.signal).catch(() => false))) await d.started(h).catch(() => {});
  return r.state;
}
