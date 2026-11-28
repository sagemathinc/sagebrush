// Whether this page's sync runs end to end (plan notes m1-page-keys-plan M1d), decided before the client starts:
// - this browser's own E2E state for the account (a device or a pin: e2e-here.ts) read first: with it, the server
//   saying there's no chain (a 404, an empty chain) is never plain sync; it is no sync, with the reason (sec2's H1);
// - none, and the server's E2E routes off (404: every site but DEV for now) or the account's key chain empty (it
//   hasn't turned end-to-end encryption on): plain sync, as before. (A browser with no E2E state can't tell that from a
//   server that lies about it: the residual the plan notes name, closed by M1b's setup of a new browser)
// - a chain, and this browser has a device for the account, verified under its pin: sealed sync,
//   with the device's keys and the sealing kit (sagebrush-e2e.js, fetched only then), once file contents are sealed
//   too (CONTENT_SEALED). Until then (sec2's H2: only the index is sealed; a file's bytes and their SHA-256 would go up
//   as they are) no sync, with the reason;
// - a chain, and no device here (another browser turned it on, or this one was reset): no sync here, and a reason to
//   show. Never plain sync into an account whose index is sealed.
// - the chain or this browser's E2E state unreadable (offline, a 5xx), or this device's chain refused (forked): no sync here either,
//   with a reason.
import type { ClientOptions } from "./sync-client";
import { e2eAccountOf, here as idbHere, type Here } from "./e2e-here";

export type E2EStart =
  | { kind: "plain" }
  | { kind: "sealed"; e2e: NonNullable<ClientOptions["e2e"]>; recoveryUnconfirmed: boolean }
  | { kind: "blocked"; reason: string; retry: boolean };

/** What the page's E2E chunk gives (e2e-start.ts). */
export type E2EChunk = typeof import("./e2e-start");

export const NO_DEVICE = "This account's sync is end-to-end encrypted. Set up this browser from another of your devices, or with your recovery code, to sync here.";
export const FORKED = "This browser was shown a different history of your account's keys than before, so it stopped syncing to keep your files safe. Reset this device to set it up again.";
export const UNREADABLE = "Sync couldn't check your account's end-to-end keys; it will try again.";
export const CONTENTS_PENDING = "This account is end-to-end encrypted, and this browser can't sync encrypted file contents yet, so sync is off here for now. Your files stay in this browser.";
/** Whether the sync client seals file contents (blobs) and notebooks' patches as well as the index: until it does, no
 * page starts a client for an end-to-end account (startSync refuses one too). */
export const CONTENT_SEALED = false;
export const WRONG_ACCOUNT = "The server answered with another account's encryption keys, so this browser stopped syncing to keep your files safe.";
export const DOWNGRADED = "The server says this account isn't end-to-end encrypted, but this browser syncs it encrypted, so it won't sync it in the clear. Reset this device if you turned encryption off.";

const chunkUrl = () => new URL("/sagebrush-e2e.js", location.href).href;

export type StartDeps = {
  /** the signed-in account's hash (the sync namespace's first part) */
  hash: string;
  /** reads a sync API path (the page's same-origin fetch by default) */
  get?: (path: string) => Promise<{ status: number; json: () => Promise<unknown> }>;
  /** loads the E2E chunk */
  chunk?: () => Promise<E2EChunk>;
  /** this browser's E2E state */
  here?: Here;
  /** (tests) whether file contents are sealed: CONTENT_SEALED */
  contentSealed?: boolean;
};

/** Decide how this page's sync starts. */
export async function e2eStart({
  hash,
  get = (p) => fetch(p, { credentials: "same-origin" }),
  chunk = () => import(/* @vite-ignore */ chunkUrl()) as Promise<E2EChunk>,
  here = idbHere,
  contentSealed = CONTENT_SEALED,
}: StartDeps): Promise<E2EStart> {
  const unreadable = { kind: "blocked", reason: UNREADABLE, retry: true } as const;
  let sealedHere: boolean;
  try {
    sealedHere = await here.sealed(hash);
  } catch {
    return unreadable;
  }
  let r: { status: number; json: () => Promise<unknown> };
  try {
    r = await get("/api/sync/v1/e2e/chain?from=0");
  } catch {
    return unreadable;
  }
  // (no chain, as the server says: plain only for an account this browser never synced sealed)
  const none = (): E2EStart => (sealedHere ? { kind: "blocked", reason: DOWNGRADED, retry: false } : { kind: "plain" });
  if (r.status === 404) return none();
  if (r.status !== 200) return unreadable;
  const body = (await r.json().catch(() => null)) as { account?: unknown; entries?: unknown } | null;
  if (!body || !Array.isArray(body.entries) || typeof body.account !== "string") return unreadable;
  // (the chain answer's E2E account is the one this page derives for the signed-in account (sec2's C1): another would
  // put a device where this browser's own check (e2e-here.ts) never looks)
  let expect: string;
  try {
    expect = e2eAccountOf(hash);
  } catch {
    return unreadable;
  }
  if (body.account !== expect) return { kind: "blocked", reason: WRONG_ACCOUNT, retry: false };
  if (body.entries.length === 0) return none();
  let m: E2EChunk;
  try {
    m = await chunk();
  } catch {
    return unreadable;
  }
  try {
    const keys = await m.DeviceKeys.load(undefined, expect);
    if (!keys) return { kind: "blocked", reason: NO_DEVICE, retry: false };
    if (!contentSealed) return { kind: "blocked", reason: CONTENTS_PENDING, retry: false };
    const kit = { sealOps: m.sealOps, sopsItem: m.sopsItem, envHashOf: m.envHashOf, verifyRow: m.verifyRow, PULL_START: m.PULL_START, SealedHalt: m.SealedHalt };
    return { kind: "sealed", e2e: { keys, kit }, recoveryUnconfirmed: keys.recoveryUnconfirmed };
  } catch (e) {
    const code = (e as { code?: string })?.code;
    if (code === "wrong_account") return { kind: "blocked", reason: WRONG_ACCOUNT, retry: false };
    if (code === "forked" || code === "chain_fork" || code === "chain_reset" || code === "chain_unanchored" || code === "no_device") return { kind: "blocked", reason: code === "no_device" ? NO_DEVICE : FORKED, retry: false };
    return unreadable;
  }
}
