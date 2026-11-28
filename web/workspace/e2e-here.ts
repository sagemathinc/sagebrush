// Whether this browser holds end-to-end state for an account (sync-e2e.ts; M1d, the downgrade check): a device or
// a pin for it in this browser's E2E store (e2e/device-keys.ts), a fact the server can't change. Both are written by
// genesis (the device before its append) and by a load, and both go only with "Reset this device". While either is
// here, a server that says the account has no chain (a 404, an empty chain) gets no plain client from this browser.
// Read without the E2E chunk (sagebrush-e2e.js), and never makes the store: a browser that has none keeps none.

const DB = "sagebrush-e2e-v1";
const B32 = "abcdefghijklmnopqrstuvwxyz234567";

/** The account's E2E id, as the server derives it (web/sync/e2e-chain.ts e2eAccount, pinned equal by
 * test-sync-e2e-start.mjs): the first 16 bytes of its account hash, in the id form (26 base32 characters). */
export function e2eAccountOf(hash: string): string {
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error("not an account hash");
  let bits = 0, acc = 0, out = "";
  for (let i = 0; i < 32; i += 2) {
    acc = (acc << 8) | parseInt(hash.slice(i, i + 2), 16); bits += 8;
    while (bits >= 5) { out += B32[(acc >>> (bits - 5)) & 31]; bits -= 5; }
    acc &= (1 << bits) - 1;
  }
  return out + B32[(acc << (5 - bits)) & 31];
}

// (the store as it is, never made: null if there is none (an upgrade asked for is aborted, which is what a missing
// database reads as; sync-old.ts's pattern))
function openAsIs(): Promise<IDBDatabase | null> {
  return new Promise((ok, no) => {
    let absent = false;
    const r = indexedDB.open(DB);
    r.onupgradeneeded = () => { absent = true; r.transaction!.abort(); };
    r.onsuccess = () => ok(r.result);
    r.onerror = (e) => { e.preventDefault?.(); absent ? ok(null) : no(r.error); };
    r.onblocked = () => no(new Error(`${DB} is being upgraded`));
  });
}

export type Here = {
  /** whether this browser has a device or a pin for the account (its hash); throws when that can't be read */
  sealed(hash: string): Promise<boolean>;
};

export const here: Here = {
  sealed: async (hash) => {
    const account = e2eAccountOf(hash);
    const db = await openAsIs();
    if (!db) return false;
    try {
      const stores = ["devices", "pins"].filter((s) => db.objectStoreNames.contains(s));
      if (stores.length !== 2) throw new Error(`${DB} isn't a store this build makes`);
      const tx = db.transaction(stores, "readonly");
      const n = await Promise.all(stores.map((s) => new Promise<number>((ok, no) => { const r = tx.objectStore(s).count(account); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); })));
      return n.some((x) => x > 0);
    } finally {
      db.close();
    }
  },
};
