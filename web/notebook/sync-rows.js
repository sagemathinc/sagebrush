// Sync's own rows in the history databases (plan-sync-slice2-client r4 §4, F1, F2, F8): where the journal keeps its
// state for a document, beside the document's TimeTravel patches and never among them.
//
// Both history databases ("sagebrush-history", "sagebrush-board-history") are keyed [nb, time].  A document's patches
// are under nb = its id; sync's rows are under nb values that begin with "\u0001" (isSyncKey, stores.js), which no
// document id can (stores.js refuses one at every store it opens), so no per-document range ever holds a sync row:
//   - the registry row (SYNC_NB, "d:" + ns + ":" + doc) gives a document its short handle h, a base-36 counter;
//   - a document's rows are under nb = SYNC_NB + h, their time a family letter and its key:
//       l lseq · o outbox · j jseq · p pending · r recovery · g recgen, reconciling · c receipts · m mode · x op
//       s slots, claims · k cursors · z the collapse marker
//     (lseq-ordered rows zero-padded to 16 digits, so string order is numeric order).
// Every key is bounded before it is built: a handle at most 12 characters, a time at most 40 ASCII characters.
// Every row is charged (F8): its key and value as the store measures them (inert JSON, two bytes a character), plus
// 64 B of overhead, written and released in the same transaction as the row (the journal's PRs).
import { SYNC_KEY_PREFIX, isSyncKey, jsonTextSize } from "./stores.js";

export { isSyncKey };
/** The nb of sync's rows: the registry, and every document's (with its handle after it). */
export const SYNC_NB = SYNC_KEY_PREFIX + "s:";
/** The bounds of a key (F1). */
export const SYNC_KEY_BOUNDS = { handle: 12, time: 40 };
/** The fixed overhead a sync row is charged beside its key and value (F8). */
export const SYNC_ROW_OVERHEAD = 64;
/** The key families: a row's time begins with its family's letter (F2). */
export const FAMILIES = Object.freeze({ lseq: "l", outbox: "o", jseq: "j", pending: "p", recovery: "r", recgen: "g", receipt: "c", mode: "m", op: "x", slot: "s", cursor: "k", collapse: "z" });
const LETTERS = new Set(Object.values(FAMILIES));
const MAX_SAFE = Number.MAX_SAFE_INTEGER;

/** A handle from the registry's counter: base 36, at most 12 characters. */
export function handleOf(n) {
  if (!Number.isSafeInteger(n) || n < 0) throw new RangeError("sync rows: a handle's counter is a safe integer >= 0");
  const h = n.toString(36);
  if (h.length > SYNC_KEY_BOUNDS.handle) throw new RangeError("sync rows: a handle past 12 characters");
  return h;
}
const isHandle = (h) => typeof h === "string" && h.length >= 1 && h.length <= SYNC_KEY_BOUNDS.handle && /^[0-9a-z]+$/.test(h);

/** The nb of a document's rows, from its handle. */
export function docNb(h) {
  if (!isHandle(h)) throw new RangeError("sync rows: a handle is 1 to 12 base-36 characters");
  return SYNC_NB + h;
}

/** The registry row's key for a document of a namespace: [SYNC_NB, "d:" + ns + ":" + doc].  (Its time may be longer
 * than a family key's: it names the document; ns and doc are bounded by their own forms, checked here.) */
export function registryKey(ns, doc) {
  if (typeof ns !== "string" || !/^[0-9A-Za-z_:-]{1,128}$/.test(ns)) throw new RangeError("sync rows: a namespace of 1 to 128 key characters");
  // (every form a document id takes here: a notebook's (a uuid, or where there is none a base-36 time and random part),
  // a board's 12 hex; at most 96 word characters, "-" and ":")
  if (typeof doc !== "string" || !/^[\w:-]{1,96}$/.test(doc)) throw new RangeError("sync rows: a document id of 1 to 96 word characters, - or :");
  return [SYNC_NB, "d:" + ns + ":" + doc];
}

/** A row's key in a document's rows: [docNb(h), letter + rest], at most 40 ASCII characters. */
export function rowKey(h, letter, rest = "") {
  if (!LETTERS.has(letter)) throw new RangeError(`sync rows: an unknown family ${JSON.stringify(letter)}`);
  if (typeof rest !== "string") throw new TypeError("sync rows: a key's rest is a string");
  const time = letter + rest;
  if (time.length > SYNC_KEY_BOUNDS.time || !/^[\x20-\x7e]*$/.test(time)) throw new RangeError("sync rows: a time is at most 40 printable ASCII characters");
  return [docNb(h), time];
}

/** An lseq-ordered row's key (lseq, outbox): the number zero-padded to 16 digits, so string order is numeric. */
export function seqKey(h, letter, n) {
  if (!Number.isSafeInteger(n) || n < 0 || n > MAX_SAFE) throw new RangeError("sync rows: a sequence number is a safe integer >= 0");
  return rowKey(h, letter, String(n).padStart(16, "0"));
}

/** A row's charge (F8): its key and value measured as the store measures (inert JSON, two bytes a character), plus
 * the fixed overhead; -1 for a value that isn't plain JSON data (never written). */
export function rowCharge(key, value) {
  const k = jsonTextSize(key, Infinity), v = jsonTextSize(value, Infinity);
  return k < 0 || v < 0 ? -1 : 2 * (k + v) + SYNC_ROW_OVERHEAD;
}
