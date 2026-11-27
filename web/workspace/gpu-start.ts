// "Run on a GPU": starting a course GPU machine from the page (provisioned-machine-enrollment r12.1, approval at
// Start). One click: the consent words sit under the Start button and pressing it is the approval. With E2E on, the
// page makes a Start intent, sends its id with the start, binds the reservation from the answer, and auto-signs the
// first matching machine key; anything else shows the approval card or a warning. Without E2E it just starts.
// The keys (PageKeys) and the GPU routes (same-origin /api/gpu/*) are injected, so the logic is tested with fakes.

import type { PageKeys, PendingEnrollment, RefusedWhy, StartIntent, TokenUsedWarning } from "./e2e/page-keys-interface.ts";

/** The consent shown under the Start button whenever E2E is on (r3's card words). */
export const CONSENT =
  "Starting it lets this machine read and change everything in your end-to-end workspace until it's removed. " +
  "Sagebrush's service sets it up and adds it for you; it's removed automatically when it stops.";
export const APPROVE_MYSELF = "Approve it myself instead";

/** Why a key wasn't added automatically, in the card's words. */
export const WHY_WORDS: Readonly<Record<RefusedWhy, string>> = {
  "no-intent": "This machine wasn't started from this page.",
  "other-page": "This machine was started from another tab or device.",
  expired: "More than 10 minutes passed since you pressed Start.",
  used: "This Start already added a machine.",
  "other-reservation": "This key belongs to a different machine.",
  "not-provisioned": "This isn't a course GPU machine.",
  "not-h1": "This key didn't arrive over the secure channel.",
  "not-first": "Another key for this machine arrived first.",
  "not-bound": "The machine isn't fully registered yet.",
};
/** A second key, or one after this Start already added a machine: never offered for approval. */
export const SECOND_KEY =
  "Another machine tried to use this machine's setup. It was not added. Stop this machine and start a new one.";

export interface GpuStartApi {
  /** POST /api/gpu/projects/:p/machines; throws GpuRefused with the words to show when the start is refused */
  start(body: { gpuType: string; intent: string | null }): Promise<{ machineId: string; reservation: string }>;
}
export class GpuRefused extends Error {}

export interface Added {
  readonly device: string;
  readonly name: string;
  readonly fingerprint: string;
  readonly atStart: boolean;
}

export type GpuStartState =
  | { readonly phase: "idle" }
  | { readonly phase: "starting" }
  | { readonly phase: "refused"; readonly text: string }
  /** waiting for the machine's key (E2E on) */
  | { readonly phase: "connecting"; readonly machineId: string; readonly reservation: string }
  /** the approval card: manual by choice (why null) or because the auto path refused */
  | { readonly phase: "approve"; readonly machineId: string; readonly reservation: string; readonly pending: PendingEnrollment; readonly why: string | null }
  /** started; `added` is the machine's device in the chain (null without E2E or after removal) */
  | { readonly phase: "ready"; readonly machineId: string; readonly reservation: string; readonly added: Added | null }
  | { readonly phase: "warning"; readonly machineId: string | null; readonly text: string };

export class GpuStart {
  state: GpuStartState = { phase: "idle" };
  /** ms from the Start click to "ready" (the startup-time number we track), or null */
  startupMs: number | null = null;
  readonly #keys: PageKeys | null;
  readonly #api: GpuStartApi;
  readonly #now: () => number;
  readonly #listeners = new Set<(s: GpuStartState) => void>();
  #intent: StartIntent | null = null;
  #manual = false;
  #clickAt = 0;
  #machineId: string | null = null;
  #reservation: string | null = null;
  /** keys that arrived before the reservation was known or bound */
  #held: PendingEnrollment[] = [];
  #decided = false;
  #unsubs: Array<() => void> = [];

  constructor(keys: PageKeys | null, api: GpuStartApi, now: () => number = Date.now) {
    this.#keys = keys;
    this.#api = api;
    this.#now = now;
    if (keys != null) {
      this.#unsubs.push(keys.onPending((p) => void this.#arrived(p)));
      this.#unsubs.push(keys.onTokenUsed((w) => this.#tokenUsed(w)));
    }
  }

  /** Whether to show CONSENT and APPROVE_MYSELF under the Start button. */
  get consentShown(): boolean {
    return this.#keys != null;
  }

  subscribe(cb: (s: GpuStartState) => void): () => void {
    this.#listeners.add(cb);
    return () => this.#listeners.delete(cb);
  }

  #set(s: GpuStartState): void {
    this.state = s;
    if (s.phase === "ready" && this.startupMs == null) this.startupMs = this.#now() - this.#clickAt;
    for (const cb of this.#listeners) cb(s);
  }

  /** The Start button (manual false) or "Approve it myself instead" (manual true). One start per GpuStart. */
  async start(gpuType: string, opts: { manual?: boolean } = {}): Promise<void> {
    if (this.state.phase !== "idle") throw new Error("already started");
    this.#clickAt = this.#now();
    this.#manual = opts.manual === true || this.#keys == null;
    this.#intent = this.#keys != null && !this.#manual ? this.#keys.startIntent() : null;
    this.#set({ phase: "starting" });
    let answer: { machineId: string; reservation: string };
    try {
      answer = await this.#api.start({ gpuType, intent: this.#intent?.id ?? null });
    } catch (e) {
      this.#intent?.cancel();
      this.#intent = null;
      this.#set({ phase: "refused", text: e instanceof GpuRefused ? e.message : "The GPU couldn't be started. Try again." });
      return;
    }
    this.#machineId = answer.machineId;
    this.#reservation = answer.reservation;
    if (this.#keys == null) {
      this.#set({ phase: "ready", machineId: answer.machineId, reservation: answer.reservation, added: null });
      return;
    }
    if (this.#intent != null) {
      try {
        this.#intent.bind(answer.reservation);
      } catch {
        this.#intent = null;
        this.#set({ phase: "warning", machineId: answer.machineId, text: "This machine couldn't be added automatically. Stop it and start a new one." });
        return;
      }
    }
    this.#set({ phase: "connecting", machineId: answer.machineId, reservation: answer.reservation });
    const held = this.#held;
    this.#held = [];
    for (const p of held) await this.#arrived(p);
  }

  async #arrived(p: PendingEnrollment): Promise<void> {
    if (this.#reservation == null) {
      if (this.state.phase === "starting") this.#held.push(p); // before Start's answer: wait for the reservation
      return;
    }
    if (p.reservation !== this.#reservation) return; // another machine's key: not this card's business
    const machineId = this.#machineId!;
    if (this.#decided) {
      // a second key for this machine: never offered for approval (r12.1)
      this.#set({ phase: "warning", machineId, text: SECOND_KEY });
      return;
    }
    if (this.#manual || this.#intent == null) {
      this.#decided = true;
      this.#set({ phase: "approve", machineId, reservation: this.#reservation, pending: p, why: null });
      return;
    }
    const r = await this.#keys!.enrollAtStart(this.#intent, p);
    if (r.ok) {
      this.#decided = true;
      this.#intent = null;
      const atStart = await this.#addedAtStart(r.device);
      this.#set({ phase: "ready", machineId, reservation: this.#reservation, added: { device: r.device, name: p.name, fingerprint: p.fingerprint, atStart } });
      return;
    }
    if (r.why === "not-bound") {
      this.#held.push(p);
      return;
    }
    this.#decided = true;
    if (r.why === "not-first" || r.why === "used") {
      this.#set({ phase: "warning", machineId, text: SECOND_KEY });
      return;
    }
    this.#set({ phase: "approve", machineId, reservation: this.#reservation, pending: p, why: WHY_WORDS[r.why] });
  }

  /** The card's Approve (after the person compared the fingerprint). */
  async approve(): Promise<void> {
    const s = this.state;
    if (s.phase !== "approve") throw new Error("nothing to approve");
    const { device } = await this.#keys!.approve(s.pending);
    const atStart = await this.#addedAtStart(device);
    this.#set({ phase: "ready", machineId: s.machineId, reservation: s.reservation, added: { device, name: s.pending.name, fingerprint: s.pending.fingerprint, atStart } });
  }

  /** "Added at Start" is what this device's replayed chain says (the signed add's provisioned.approved and
   *  reservation), never the Start answer or a server field. */
  async #addedAtStart(device: string): Promise<boolean> {
    const d = (await this.#keys!.devices()).find((x) => x.id === device);
    return d != null && d.addedAtStart && d.reservation === this.#reservation;
  }

  /** The notice's Remove: the device leaves the chain with a new epoch. */
  async remove(): Promise<void> {
    const s = this.state;
    if (s.phase !== "ready" || s.added == null) throw new Error("nothing to remove");
    await this.#keys!.removeDevice(s.added.device, { rotate: true, reason: "person" });
    this.#set({ ...s, added: null });
  }

  #tokenUsed(w: TokenUsedWarning): void {
    // PageKeys has already removed the device and rotated the epoch (P1); the UI withdraws the notice and warns.
    if (this.#reservation == null || w.reservation !== this.#reservation) return;
    this.#intent?.cancel();
    this.#intent = null;
    this.#set({ phase: "warning", machineId: this.#machineId, text: w.text });
  }

  /** The page or panel goes away: stop listening, and spend an intent that never got its key. */
  dispose(): void {
    for (const u of this.#unsubs) u();
    this.#unsubs = [];
    if (this.state.phase === "starting" || this.state.phase === "connecting") this.#intent?.cancel();
    this.#intent = null;
    this.#listeners.clear();
  }
}
