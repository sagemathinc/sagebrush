// This browser's E2E device for the signed-in account (design/e2e-encryption.md §2, §3.4; plan notes m1-page-keys-plan
// M1a): its keys and chain pin in IndexedDB, the account's key chain verified from the server's entries, and the epoch
// keys its wrappers carry. It gives the sync client its OpKeys (sync-seal.ts). Adding devices, removal and provisioned
// machines come next (M1b, M1c), on this module.
//
// - The keys: an Ed25519 signing pair and an X25519 pair, made by WebCrypto with `extractable: false` and kept as
//   CryptoKeys in this origin's IndexedDB (PROD and DEV are separate origins). Their private halves never leave
//   WebCrypto: nothing here can read them.
// - The pin: the chain position this device last verified, {seq, hash, generation}. Each load replays the server's
//   chain under it (replayFrom with the pin), so a chain that rolls back or forks from it is refused, and the account
//   is then marked forked here, for good: a forked device signs nothing and opens nothing until "Reset this device".
//   The pin only moves forward, in one transaction (a compare-and-set, so two tabs can't interleave).
// - Epoch secrets: opened from the device's wrapper and, for older epochs, from the chained keyrings; held in this
//   object's memory only, never stored. The derived keys are non-extractable.
// - A chain that starts at a reset (compacted) needs an anchor; that comes with recovery (M1b), and is refused here.
import { e2eCore } from "./core-ready.ts";
import { hpke } from "./hpke.ts";
import { deriveEpochKeys, type EpochKeys } from "./keys.ts";
import { fleetCore } from "../fleet/install.ts";
import type { ChainView, OpKeys } from "../sync-seal.ts";

// (the fleet core's bytes and Ed25519 helpers, through the page's one way into it: fleet/install.ts)
const b64 = (b: Uint8Array): string => fleetCore().b64(b);
const unb64 = (s: string): Uint8Array => fleetCore().unb64(s);
const newId = (): string => fleetCore().newId();
const asKey = (...a: Parameters<ReturnType<typeof fleetCore>["asKey"]>): ReturnType<ReturnType<typeof fleetCore>["asKey"]> => fleetCore().asKey(...a);

const DB = "sagebrush-e2e-v1";
/** After a lost genesis answer with no entry yet, how long before the chain is read once more */
export const GENESIS_RECHECK_MS = 1500;
const API = "/api/sync/v1/e2e";

/** How the module reaches the sync server: same-origin requests with the session cookie (tests can give another). */
export type Transport = (method: "GET" | "POST", path: string, body?: unknown) => Promise<{ status: number; json: Record<string, unknown> }>;
export const sameOrigin: Transport = async (method, path, body) => {
  const r = await fetch(path, { method, credentials: "same-origin", headers: body === undefined ? {} : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: ((await r.json().catch(() => ({}))) ?? {}) as Record<string, unknown> };
};

/** A refusal of this module's, by code (the E2E core's codes, and its own: forked, no_device, no_chain, server). */
export class DeviceKeysError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

type Signer = Awaited<ReturnType<typeof asKey>>;
type Kem = { publicRaw: Uint8Array; privateKey: CryptoKey };
type Pin = { seq: number; hash: string; generation: string };
/** `recoveryShown`: false from before genesis's append until the person confirms they saved the recovery code (create's
 * `confirm`, called by the page once they say so). A device found with it false (the append's answer was lost, or the
 * page closed before the person confirmed) has a recovery key nobody may have saved: the caller is told
 * (recoveryUnconfirmed), and recovery's rotation (M1b) replaces the key. No secret in it. */
type DeviceRecord = { id: string; sign: CryptoKeyPair; signRaw: Uint8Array; kem: CryptoKeyPair; kemRaw: Uint8Array; created: number; recoveryShown?: boolean };
type PinRecord = Pin & { forked?: { at: number; code: string } };
/** The verified chain state as chain.mjs makes it (the fields read here). */
type State = {
  readonly head: string; readonly generation: string; readonly seq: number; readonly base: number; readonly hashes: readonly string[];
  readonly epoch: { n: number; commit: string; keyring: { hash: string } | null }; readonly epochs: readonly { n: number; commit: string; seq: number }[];
  readonly devices: ReadonlyMap<string, { id: string; sign: Uint8Array; signKey: string; added: number; removed: number | null }>;
};

const req = <T>(r: IDBRequest<T>) => new Promise<T>((ok, no) => { r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
const done = (tx: IDBTransaction) => new Promise<void>((ok, no) => { tx.oncomplete = () => ok(); tx.onerror = () => no(tx.error); tx.onabort = () => no(tx.error ?? new Error("aborted")); });
let db: Promise<IDBDatabase> | undefined;
function open(): Promise<IDBDatabase> {
  return (db ??= new Promise((ok, no) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => { for (const s of ["devices", "pins"]) r.result.createObjectStore(s); };
    r.onsuccess = () => ok(r.result);
    r.onerror = () => no(r.error);
  }));
}
async function get<T>(store: string, key: string): Promise<T | undefined> {
  const tx = (await open()).transaction(store, "readonly");
  return (await req(tx.objectStore(store).get(key))) as T | undefined;
}

/** A new device's keys, non-extractable (refused in a browser that can't make them so). */
async function newDeviceKeys(): Promise<Omit<DeviceRecord, "id" | "created">> {
  let sign: CryptoKeyPair, kem: CryptoKeyPair;
  try {
    sign = (await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"])) as CryptoKeyPair;
    kem = (await crypto.subtle.generateKey({ name: "X25519" }, false, ["deriveBits"])) as CryptoKeyPair;
  } catch {
    throw new DeviceKeysError("no_crypto", "this browser can't hold end-to-end keys");
  }
  if (sign.privateKey.extractable !== false || kem.privateKey.extractable !== false) throw new DeviceKeysError("no_crypto", "this browser can't hold end-to-end keys");
  const kemRaw = e2eCore().checkKemPublic(new Uint8Array(await crypto.subtle.exportKey("raw", kem.publicKey))) as Uint8Array;
  return { sign, signRaw: new Uint8Array(await crypto.subtle.exportKey("raw", sign.publicKey)), kem, kemRaw };
}

/** Move the pin forward to `next`, which the caller verified as extending the stored pin, in one transaction. */
async function advance(account: string, next: Pin, hashes: readonly string[], base: number): Promise<void> {
  const tx = (await open()).transaction("pins", "readwrite");
  const s = tx.objectStore("pins");
  const cur = (await req(s.get(account))) as PinRecord | undefined;
  // (another tab may have pinned meanwhile: only forward, and only along this chain)
  const onChain = (p: Pin) => p.generation === next.generation && p.seq >= base && hashes[p.seq - base] === p.hash;
  if (cur?.forked) { tx.abort(); throw new DeviceKeysError("forked", "this device saw a forked key chain"); }
  if (cur && !onChain(cur) && cur.seq <= next.seq) {
    s.put({ ...cur, forked: { at: Date.now(), code: "chain_fork" } } satisfies PinRecord, account);
    await done(tx);
    throw new DeviceKeysError("forked", "this device saw a forked key chain");
  }
  if (!cur || cur.seq < next.seq) s.put({ seq: next.seq, hash: next.hash, generation: next.generation } satisfies PinRecord, account);
  await done(tx);
}
async function markForked(account: string, code: string): Promise<void> {
  const tx = (await open()).transaction("pins", "readwrite");
  const s = tx.objectStore("pins");
  const cur = (await req(s.get(account))) as PinRecord | undefined;
  if (cur && !cur.forked) s.put({ ...cur, forked: { at: Date.now(), code } } satisfies PinRecord, account);
  await done(tx);
}

/** Whether `entry` is a genesis for this account that verifies: only that proves another device's genesis came first. */
async function verifiedGenesis(E: ReturnType<typeof e2eCore>, entry: string, ctx: { aud: string; account: string }): Promise<boolean> {
  try {
    await E.applyChainEntry(null, new TextEncoder().encode(entry), ctx);
    return true;
  } catch {
    return false;
  }
}

/** The server's chain for the signed-in account: its E2E account id, audience and entries. */
async function fetchChain(t: Transport, expect: string | null): Promise<{ account: string; aud: string; entries: string[] }> {
  const r = await t("GET", `${API}/chain?from=0`);
  if (r.status !== 200) throw new DeviceKeysError("server", `the key chain couldn't be read (${r.status})`);
  const { account, aud, entries } = r.json as { account?: unknown; aud?: unknown; entries?: unknown };
  const E = e2eCore();
  if (typeof account !== "string" || typeof aud !== "string" || !E.AUDIENCES.includes(aud) || !Array.isArray(entries) || !entries.every((x) => typeof x === "string"))
    throw new DeviceKeysError("server", "the key chain's answer isn't one");
  if (expect !== null && account !== expect) throw new DeviceKeysError("wrong_account", "the key chain's answer is for another account");
  return { account, aud, entries: entries as string[] };
}

/**
 * This browser's E2E device for the signed-in account, its chain verified under its pin: the sync client's OpKeys.
 * `load` returns null when this browser has no device for the account (it hasn't opted in here, or was reset).
 */
export class DeviceKeys implements OpKeys {
  readonly device: { readonly id: string; sign(bytes: Uint8Array): Promise<Uint8Array> };
  /** whether this device's recovery code may never have been saved (see DeviceRecord.recoveryShown) */
  get recoveryUnconfirmed(): boolean { return this.#unconfirmed; }
  #unconfirmed: boolean;
  // (only the current epoch's raw secret is kept: an older one is used once, to derive its keys, which are cached)
  #current: { n: number; S: Uint8Array } | null = null;
  #derived = new Map<number, EpochKeys>();
  #seen = new Set<string>();
  #ended: "forked" | "no_device" | null = null;

  private constructor(
    readonly account: string,
    private readonly ctx: { aud: string; account: string },
    private readonly rec: DeviceRecord,
    private readonly signer: Signer,
    private state: State,
    private readonly t: Transport,
  ) {
    this.device = { id: rec.id, sign: async (b) => { await this.live(); return signer.sign(b); } };
    this.#unconfirmed = rec.recoveryShown === false;
  }

  /** Refuses once the account is marked forked here, or this device is no longer this browser's for the account (Reset
   * this device, in this tab or another), by this object or another: every sign, chain view and epoch key goes through
   * it, and the cached epoch secrets are dropped on the first refusal. */
  private async live(): Promise<void> {
    if (!this.#ended) {
      const tx = (await open()).transaction(["pins", "devices"], "readonly");
      const [pin, rec] = await Promise.all([req(tx.objectStore("pins").get(this.account)), req(tx.objectStore("devices").get(this.account))]) as [PinRecord | undefined, DeviceRecord | undefined];
      if (pin?.forked) this.#ended = "forked";
      else if (rec?.id !== this.rec.id) this.#ended = "no_device";
    }
    if (!this.#ended) return;
    this.#current?.S.fill(0);
    this.#current = null;
    this.#derived.clear();
    throw this.#ended === "forked" ? new DeviceKeysError("forked", "this device saw a forked key chain") : new DeviceKeysError("no_device", "this device was reset in this browser");
  }

  /** The device for the signed-in account, or null if this browser has none. Refuses a forked account, or a chain
   * that doesn't extend this device's pin (marking it forked), or one this device isn't current in. `expect` (required: the
   * account binding): the E2E account id the page derived for the signed-in account (e2e-here.ts e2eAccountOf); a chain answer
   * naming another is refused (wrong_account), so a device is only ever read and stored where the page's own checks look. */
  static async load(expect: string, t: Transport = sameOrigin): Promise<DeviceKeys | null> {
    const E = e2eCore();
    const c = await fetchChain(t, expect);
    const rec = await get<DeviceRecord>("devices", c.account);
    if (!rec) return null;
    const pin = await get<PinRecord>("pins", c.account);
    if (pin?.forked) throw new DeviceKeysError("forked", "this device saw a forked key chain");
    // (with a pin, an empty chain is a rollback to nothing and a compacted one can't be checked against it: each marks the
    // account forked here, as a rollback does; with no pin yet, each is only refused)
    if (c.entries.length === 0) {
      if (pin) await markForked(c.account, "chain_fork");
      throw new DeviceKeysError("no_chain", "the account's key chain is gone");
    }
    const ctx = { aud: c.aud, account: c.account };
    if (!e2eFirstIsGenesis(c.entries[0])) {
      if (pin) await markForked(c.account, "chain_unanchored");
      throw new DeviceKeysError("chain_unanchored", "a compacted key chain needs its anchor (recovery)");
    }
    const state = await DeviceKeys.verify(E, c.entries, ctx, pin ?? null, c.account);
    const signer = await asKey(rec.signRaw, async (m: Uint8Array) => new Uint8Array(await crypto.subtle.sign("Ed25519", rec.sign.privateKey, m as BufferSource)));
    const me = E.currentDevice(state, rec.id);
    if (!me || me.signKey !== signer.key) throw new DeviceKeysError("no_device", "this device isn't one of the account's current devices");
    await advance(c.account, E.pinOf(state), state.hashes, state.base);
    return new DeviceKeys(c.account, ctx, rec, signer, state, t);
  }

  /** Replay entries under the pin; a fork, rollback or reset refuses and marks the account forked here. */
  private static async verify(E: ReturnType<typeof e2eCore>, entries: string[], ctx: { aud: string; account: string }, pin: Pin | null, account: string): Promise<State> {
    const bytes = entries.map((e) => new TextEncoder().encode(e));
    try {
      return (await E.replayFrom(bytes, ctx, { pin: pin ? { seq: pin.seq, hash: pin.hash, generation: pin.generation } : null })) as State;
    } catch (e) {
      const code = (e as { code?: string })?.code ?? "bad_form";
      if (code === "chain_fork" || code === "chain_reset") await markForked(account, code);
      throw new DeviceKeysError(code, "the account's key chain doesn't verify on this device");
    }
  }

  /**
   * Turn end-to-end encryption on for the signed-in account from this browser (genesis, §2): a new device, a new
   * recovery key and epoch 0, appended with their wrappers. Returns the device, the recovery code, which is shown once
   * and never stored (the caller shows it), and `confirm`, which the caller calls once the person says they saved the
   * code: until then the device stays unconfirmed (recoveryUnconfirmed), here and after a reload. Refused if the account
   * already has a chain, or if the chain answer names another E2E account than `expect` (as load).
   */
  static async create(name: string, expect: string, t: Transport = sameOrigin): Promise<{ keys: DeviceKeys; recoveryCode: string; confirm: () => Promise<void> }> {
    const E = e2eCore();
    const c = await fetchChain(t, expect);
    if (c.entries.length > 0) throw new DeviceKeysError("exists", "this account's key chain already exists");
    const ctx = { aud: c.aud, account: c.account };
    const k = await newDeviceKeys();
    const rec: DeviceRecord = { id: newId(), created: Date.now(), ...k };
    const signer = await asKey(rec.signRaw, async (m: Uint8Array) => new Uint8Array(await crypto.subtle.sign("Ed25519", rec.sign.privateKey, m as BufferSource)));
    const seed = E.newRecoverySeed();
    const rk = await E.recoveryKeys(seed, c.account);
    const S = E.newEpochSecret();
    const epoch = { n: 0, suite: 1, commit: await E.epochCommit(S, c.account, 0), keyring: null };
    const device = { id: rec.id, name, kind: "browser", sign: b64(rec.signRaw), kem: b64(rec.kemRaw) };
    const body = E.nextBody(null, ctx, "genesis", { device, recovery: { sign: b64(rk.sign.raw), kem: b64(rk.kem.publicRaw) }, epoch });
    const entry = await E.sealEntry(E.deviceSigner(rec.id, signer), body, signer, { recovery: rk.sign });
    const { state } = await E.applyChainEntry(null, entry, ctx);
    const sender = { id: rec.id, sign: signer };
    const wrappers = [];
    for (const recipient of [{ kind: "device", id: rec.id }, { kind: "recovery", id: c.account }]) wrappers.push(new TextDecoder().decode(await E.wrapEpoch({ hpke, state, ctx, sender, recipient, n: 0, S })));
    // (the device is stored before the append, marked as not having shown its recovery code: if the append's answer is
    // lost and this call ends, a reload finds the device, the chain, and that its code may never have been shown)
    const tx = (await open()).transaction("devices", "readwrite");
    const s = tx.objectStore("devices");
    if ((await req(s.getKey(c.account))) !== undefined) { tx.abort(); throw new DeviceKeysError("exists", "this browser already has a device for the account"); }
    s.add({ ...rec, recoveryShown: false } satisfies DeviceRecord, c.account);
    await done(tx);
    const text = new TextDecoder().decode(entry);
    // (the append's status, or null when its answer was lost on the way)
    let status: number | null = null;
    try {
      status = (await t("POST", `${API}/chain`, { entry: text, keyring: null, wrappers })).status;
    } catch { /* (decided below, from the chain) */ }
    if (status !== 201) {
      // (a failed or lost append: the chain says which. This entry first: it applied, and genesis finishes. Another
      // genesis first that verifies (its form and signatures), or none after a definite refusal (4xx): it didn't, and this
      // device goes, so the person can try again. None after a lost answer or a 5xx, or a first entry that doesn't verify:
      // the chain is read once more after a pause, and if it still says nothing certain the device stays, marked as not
      // having shown its code; a reload then says so)
      const refused = status !== null && status >= 400 && status < 500;
      let applied: "yes" | "no" | "unknown" = "unknown";
      for (let i = 0; i < 2 && applied === "unknown"; i++) {
        if (i > 0) await new Promise((r) => setTimeout(r, GENESIS_RECHECK_MS));
        try {
          const now = await fetchChain(t, null);
          if (now.account !== c.account) break;
          if (now.entries[0] === text) applied = "yes";
          else if (now.entries.length > 0) { if (await verifiedGenesis(E, now.entries[0], ctx)) applied = "no"; }
          else if (refused) applied = "no";
        } catch { /* (the chain couldn't be read: still unknown) */ }
      }
      if (applied === "no") {
        await forget(c.account, rec.id);
        throw new DeviceKeysError("server", "the key chain couldn't be started; try again");
      }
      if (applied === "unknown") throw new DeviceKeysError("server", "the key chain couldn't be started; reload the page");
    }
    await advance(c.account, E.pinOf(state), state.hashes, state.base);
    const keys = new DeviceKeys(c.account, ctx, { ...rec, recoveryShown: false }, signer, state as State, t);
    keys.#current = { n: 0, S };
    const confirm = async () => {
      await shown(c.account, rec.id);
      keys.#unconfirmed = false;
    };
    return { keys, recoveryCode: E.showCode(E.codeOfSeed(seed)), confirm };
  }

  /** The verified chain as a ChainView; `refresh` reads the server's newer entries first, verified under this device's
   * pin (and the pin moves forward). */
  async chain(refresh?: boolean): Promise<ChainView> {
    if (refresh) {
      const E = e2eCore();
      // (the stored pin first, then the chain: a fork mark another tab writes meanwhile is caught by advance's own check,
      // inside its transaction, so it is never overwritten)
      await this.live();
      const pin = await get<PinRecord>("pins", this.account);
      const c = await fetchChain(this.t, null);
      if (c.account !== this.account) throw new DeviceKeysError("server", "the signed-in account changed");
      const next = await DeviceKeys.verify(E, c.entries, this.ctx, pin ?? E.pinOf(this.state), this.account);
      await advance(this.account, E.pinOf(next), next.hashes, next.base);
      this.state = next;
    }
    await this.live();
    return viewOf(this.state);
  }

  /** Epoch n's keys: from the device's wrapper (the current epoch) or the keyrings back from it; null if this device
   * can't reach them (it was added after that epoch's keyring chain began, or removed). */
  async epochKeys(n: number): Promise<EpochKeys | null> {
    if (!Number.isSafeInteger(n) || n < 0) return null;
    await this.live();
    const have = this.#derived.get(n);
    if (have) return have;
    const S = await this.secret(n);
    if (!S) return null;
    const keys = await deriveEpochKeys(S, this.account, n);
    // (and again after the wrapper's fetch: a mark written meanwhile)
    await this.live();
    this.#derived.set(n, keys);
    return keys;
  }

  private async secret(n: number): Promise<Uint8Array | null> {
    const E = e2eCore();
    const cur = this.state.epoch.n;
    if (n > cur) return null;
    if (this.#current?.n !== cur) {
      const r = await this.t("GET", `${API}/wrapper?kind=device&id=${encodeURIComponent(this.rec.id)}`);
      if (r.status !== 200 || typeof r.json.wrapper !== "string") return null;
      const me = { kind: "device", id: this.rec.id, recipient: { publicRaw: this.rec.kemRaw, privateKey: this.rec.kem.privateKey } as Kem };
      const got = await E.openWrapper({ hpke, state: this.state, ctx: this.ctx, bytes: new TextEncoder().encode(r.json.wrapper), me, seen: (id: string) => this.#seen.has(id) });
      this.#seen.add(got.id);
      if (got.n !== cur) return null;
      this.#current = { n: cur, S: got.S };
    }
    if (n === cur) return this.#current!.S;
    // (an older epoch: back along the chained keyrings from the current one, each checked against the chain)
    const commits = new Map(this.state.epochs.map((e: { n: number; commit: string }) => [e.n, e.commit]));
    try {
      // (walkBack's JSDoc types its callbacks loosely)
      const walkBack = E.walkBack as unknown as (a: Record<string, unknown>) => Promise<Uint8Array>;
      const S = await walkBack({
        S: this.#current!.S, n: cur, expect: this.state.epoch.keyring?.hash, to: n, account: this.account,
        row: async (k: number) => {
          const r = await this.t("GET", `${API}/keyring/${k}`);
          if (r.status !== 200) throw new DeviceKeysError("server", "a keyring couldn't be read");
          return { ...(r.json as object), bytes: unb64(String(r.json.keyring)) };
        },
        commit: (k: number) => commits.get(k),
      });
      return S;
    } catch {
      return null;
    }
  }
}

/** Whether a chain's first entry is genesis (a compacted chain starts at a reset, which needs an anchor). */
function e2eFirstIsGenesis(entry: string): boolean {
  try { return (JSON.parse(entry) as { body?: { op?: unknown } })?.body?.op === "genesis"; } catch { return false; }
}

/** A ChainView of a verified state (absolute positions, as the sync client reads them). */
function viewOf(state: State): ChainView {
  const E = e2eCore();
  const position = (h: string) => { const i = state.hashes.indexOf(h); return i < 0 ? null : state.base + i; };
  return Object.freeze({
    head: state.head, generation: state.generation, currentEpoch: state.epoch.n, position,
    signerAt: (h: string, id: string) => {
      const p = position(h), d = state.devices.get(id);
      return p !== null && d && d.added <= p && (d.removed === null || d.removed > p) ? new Uint8Array(d.sign) : null;
    },
    epochAt: (h: string) => { const p = position(h); return p === null ? null : (E.epochAt(state, p)?.n ?? null); },
    device: (id: string) => { const d = state.devices.get(id); return d ? { added: d.added, removed: d.removed } : null; },
  });
}

/** Delete the account's device record, if it is still the one with `id` (one transaction: another tab's never goes). */
async function forget(account: string, id: string): Promise<void> {
  const tx = (await open()).transaction(["devices", "pins"], "readwrite");
  const d = tx.objectStore("devices");
  if (((await req(d.get(account))) as DeviceRecord | undefined)?.id === id) {
    d.delete(account);
    tx.objectStore("pins").delete(account);
  }
  await done(tx);
}
/** Mark the account's device `id` as having returned its recovery code to the caller. */
async function shown(account: string, id: string): Promise<void> {
  const tx = (await open()).transaction("devices", "readwrite");
  const d = tx.objectStore("devices");
  const cur = (await req(d.get(account))) as DeviceRecord | undefined;
  if (cur?.id === id) d.put({ ...cur, recoveryShown: true } satisfies DeviceRecord, account);
  await done(tx);
}

/** "Reset this device": its keys and pin for the account deleted, the fork mark with them (it then enrolls again; and
 * with neither left, this browser no longer refuses plain sync for the account: e2e-here.ts). */
export async function resetDevice(account: string): Promise<void> {
  const tx = (await open()).transaction(["devices", "pins"], "readwrite");
  tx.objectStore("devices").delete(account);
  tx.objectStore("pins").delete(account);
  await done(tx);
}
