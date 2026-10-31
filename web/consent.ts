// The one consent switch for every measurement this site's pages send (active-users plan r2 §3, r3 §D, r4b): one
// module, one entry point (`measure`), one decision (`mayMeasure`).  Today the default is on (William, Oct 31); a
// banner later sets MEASURE_DEFAULT to "ask" and calls setMeasure.  Browsers that send Global Privacy Control are
// never counted (William, Oct 31: "Yes to both").  No other module may send to a MEASURE_PATHS path (a test scans the
// sources and the built assets).

/** "on": measure unless told not to; "ask": only after a "yes" (a banner's) */
export const MEASURE_DEFAULT: "on" | "ask" = "on";
/** a browser whose Global Privacy Control is on is not counted, and keeps no note */
export const HONOR_GPC = true;
/** every path a measurement is sent to; only measure() may send to them */
export const MEASURE_PATHS = ["/api/active"] as const;
/** the measurement notes this module removes when consent ends */
export const NOTE_KEYS = ["sb-active", "sb-active-b"] as const;
const CONSENT_KEY = "sb-consent";

/** Whether a stored consent value (or its absence) permits measuring. */
export function permits(v: string | null): boolean {
  if (v === "yes") return true;
  if (v === "no") return false;
  return MEASURE_DEFAULT === "on";
}

/** Whether this browser may be measured now: its stored choice, the default, and Global Privacy Control.  Any
 * error (storage blocked, say) means no. */
export function mayMeasure(): boolean {
  try {
    if (HONOR_GPC && (globalThis.navigator as { globalPrivacyControl?: boolean } | undefined)?.globalPrivacyControl === true) return false;
    return permits(globalThis.localStorage.getItem(CONSENT_KEY));
  } catch {
    return false;
  }
}

const removeNotes = () => {
  try {
    for (const k of NOTE_KEYS) globalThis.localStorage.removeItem(k);
  } catch {
    // (storage blocked: there is nothing to remove)
  }
};

/** The page's own choice (a banner's or a setting's, later): false also removes the notes at once. */
export function setMeasure(v: boolean): void {
  try {
    globalThis.localStorage.setItem(CONSENT_KEY, v ? "yes" : "no");
  } catch {
    // (storage blocked: measuring stays off, as mayMeasure says)
  }
  if (v) withdrawn = false;
  else removeNotes();
}

/** Set when another tab withdraws consent: a persist made after it is undone (r3 §D); reset by a permitting change
 * or by this page's own setMeasure(true).  In memory only. */
let withdrawn = false;
export const wasWithdrawn = () => withdrawn;
/** After a write of a note: if consent was withdrawn meanwhile in another tab, the note goes again. */
export function afterNoteWrite(): void {
  if (withdrawn) removeNotes();
}
try {
  globalThis.addEventListener?.("storage", (e: StorageEvent) => {
    if (e.key !== CONSENT_KEY) return;
    if (permits(e.newValue)) withdrawn = false;
    else {
      withdrawn = true;
      removeNotes();
    }
  });
} catch {
  // (no window: a worker or a test runtime)
}

/** The only way to send a measurement: `run` gets a fetch for `path` alone, and runs only if mayMeasure() says
 * yes now; when it says no, the notes go and nothing runs. */
export async function measure(path: (typeof MEASURE_PATHS)[number], run: (send: (init: RequestInit) => Promise<Response>) => Promise<void>): Promise<void> {
  if (!mayMeasure()) {
    removeNotes();
    return;
  }
  await run((init) => fetch(path, init));
}
