// An assignment's hand-over from its page (/s/#lti=…) to the notebook page, in the same tab.  Start writes the
// assignment's identity and its file-list link to this tab's sessionStorage under a random key, and sends the tab to
// /#assignment=<key>.  The key is a handle, not a credential: it resolves only in this tab's sessionStorage (or a copy
// the browser makes of it for a duplicated tab), and what it unlocks is the link itself, with its own expiry and
// budget.  The link never goes into a URL, so never into history, a log, a referrer or a sign-in's return.
//
// The entry is kept while sign-in takes the tab to CoCalc and back, and dropped once the copy is made or found, when
// it expires, or on sign-out.

export interface Handover {
  /** the copy's id: (tool, course, student, placement)'s digest, 32 hex */
  copy: string;
  /** the tool's file list for this assignment, good until `expires` */
  manifest: string;
  expires: number;
  /** the handout's revision (its bundle's SHA-256) */
  revision: string;
  title: string;
}

export const HANDOVER_PREFIX = "sb-assignment:";
const KEY = /^[0-9a-f]{32}$/;
const HEX = (n: number) => new RegExp(`^[0-9a-f]{${n}}$`);
const valid = (h: Partial<Handover> | null): h is Handover =>
  !!h && typeof h.copy === "string" && HEX(32).test(h.copy) && typeof h.manifest === "string" && /^https:\/\//.test(h.manifest) &&
  h.manifest.length <= 2048 && Number.isSafeInteger(h.expires) && typeof h.revision === "string" && HEX(64).test(h.revision) &&
  typeof h.title === "string" && h.title.length <= 255;

/** Store `h` in this tab and answer the address that takes it up: /#assignment=<key>. */
export function putHandover(h: Handover, storage: Storage = sessionStorage): string {
  if (!valid(h)) throw new Error("not an assignment's hand-over");
  const key = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
  storage.setItem(HANDOVER_PREFIX + key, JSON.stringify(h));
  return `/#assignment=${key}`;
}

/** The key in a location hash (#assignment=<key>), or null. */
export const handoverKey = (hash: string): string | null => {
  const m = /^#assignment=([0-9a-f]{32})$/.exec(hash);
  return m ? m[1] : null;
};

/** The hand-over under `key`, still valid now; an expired or malformed one is dropped and answers null. */
export function readHandover(key: string, now = Date.now(), storage: Storage = sessionStorage): Handover | null {
  if (!KEY.test(key)) return null;
  let h: Partial<Handover> | null = null;
  try {
    h = JSON.parse(storage.getItem(HANDOVER_PREFIX + key) ?? "null");
  } catch {}
  if (!valid(h) || h.expires <= now) {
    storage.removeItem(HANDOVER_PREFIX + key);
    return null;
  }
  return h;
}

export const dropHandover = (key: string, storage: Storage = sessionStorage) => storage.removeItem(HANDOVER_PREFIX + key);
