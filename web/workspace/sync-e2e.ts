// Whether this page's sync runs end to end (plan notes m1-page-keys-plan M1d), decided before the client starts:
// - the server's E2E routes off (404: every site but DEV for now), or the account's key chain empty (it hasn't turned
//   end-to-end encryption on): plain sync, as before;
// - a chain, and this browser has a device for the account, verified under its pin: sealed sync, with the device's
//   keys and the sealing kit (sagebrush-e2e.js, fetched only then);
// - a chain, and no device here (another browser turned it on, or this one was reset): no sync here, and a reason to
//   show. Never plain sync into an account whose index is sealed.
// - the chain unreadable (offline, a 5xx), or this device's chain refused (forked): no sync here either, with a reason.
import type { ClientOptions } from "./sync-client";

export type E2EStart =
  | { kind: "plain" }
  | { kind: "sealed"; e2e: NonNullable<ClientOptions["e2e"]>; recoveryUnconfirmed: boolean }
  | { kind: "blocked"; reason: string; retry: boolean };

/** What the page's E2E chunk gives (e2e-start.ts). */
export type E2EChunk = typeof import("./e2e-start");

export const NO_DEVICE = "This account's sync is end-to-end encrypted. Set up this browser from another of your devices, or with your recovery code, to sync here.";
export const FORKED = "This browser was shown a different history of your account's keys than before, so it stopped syncing to keep your files safe. Reset this device to set it up again.";
export const UNREADABLE = "Sync couldn't check your account's end-to-end keys; it will try again.";

const chunkUrl = () => new URL("/sagebrush-e2e.js", location.href).href;

/** Decide how this page's sync starts. `get` reads a sync API path (the page's same-origin fetch by default), and
 * `chunk` loads the E2E chunk (tests give their own). */
export async function e2eStart(
  get: (path: string) => Promise<{ status: number; json: () => Promise<unknown> }> = (p) => fetch(p, { credentials: "same-origin" }),
  chunk: () => Promise<E2EChunk> = () => import(/* @vite-ignore */ chunkUrl()) as Promise<E2EChunk>,
): Promise<E2EStart> {
  let r: { status: number; json: () => Promise<unknown> };
  try {
    r = await get("/api/sync/v1/e2e/chain?from=0");
  } catch {
    return { kind: "blocked", reason: UNREADABLE, retry: true };
  }
  if (r.status === 404) return { kind: "plain" };
  if (r.status !== 200) return { kind: "blocked", reason: UNREADABLE, retry: true };
  const body = (await r.json().catch(() => null)) as { entries?: unknown } | null;
  if (!body || !Array.isArray(body.entries)) return { kind: "blocked", reason: UNREADABLE, retry: true };
  if (body.entries.length === 0) return { kind: "plain" };
  let m: E2EChunk;
  try {
    m = await chunk();
  } catch {
    return { kind: "blocked", reason: UNREADABLE, retry: true };
  }
  try {
    const keys = await m.DeviceKeys.load();
    if (!keys) return { kind: "blocked", reason: NO_DEVICE, retry: false };
    const kit = { sealOps: m.sealOps, sopsItem: m.sopsItem, envHashOf: m.envHashOf, verifyRow: m.verifyRow, PULL_START: m.PULL_START, SealedHalt: m.SealedHalt };
    return { kind: "sealed", e2e: { keys, kit }, recoveryUnconfirmed: keys.recoveryUnconfirmed };
  } catch (e) {
    const code = (e as { code?: string })?.code;
    if (code === "forked" || code === "chain_fork" || code === "chain_reset" || code === "chain_unanchored" || code === "no_device") return { kind: "blocked", reason: code === "no_device" ? NO_DEVICE : FORKED, retry: false };
    return { kind: "blocked", reason: UNREADABLE, retry: true };
  }
}
