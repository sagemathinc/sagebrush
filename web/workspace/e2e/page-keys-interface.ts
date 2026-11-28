// The page's E2E keys as the UI sees them (interface draft 3, provisioned-machine-enrollment r12.1). The E2E owner's
// web/workspace/e2e/page-keys.ts implements it; until then the UI builds against a fake of the same shape. The UI never
// sees a key or a signature, only these calls.

export interface PageKeys {
  readonly account: string;
  readonly device: { id: string };
  /** A new Start intent: 128 bits from crypto.getRandomValues, held only in page memory, valid 10 minutes, single-use.
   *  Its id goes with the Start request; the reservation in Start's answer is bound to it after. */
  startIntent(): StartIntent;
  pending(): Promise<PendingEnrollment[]>;
  /** Pushed the moment a pending enrollment arrives; returns its unsubscribe. */
  onPending(cb: (p: PendingEnrollment) => void): () => void;
  devices(): Promise<DeviceInfo[]>;
  /** Signs the add entry only if every r12.1 condition holds for this intent, then spends it; otherwise returns why. */
  enrollAtStart(intent: StartIntent, p: PendingEnrollment): Promise<{ ok: true; device: string } | { ok: false; why: RefusedWhy }>;
  /** "Approve it myself": sign the add entry for exactly this pending key, after the person clicked. */
  approve(p: PendingEnrollment): Promise<{ device: string }>;
  removeDevice(id: string, opts: { rotate: boolean; reason: "person" | "reservation-retired" | "token-used" }): Promise<void>;
  /** P1 is done by PageKeys itself; the UI only shows the warning and withdraws the notice. Returns its unsubscribe. */
  onTokenUsed(cb: (w: TokenUsedWarning) => void): () => void;
}

export interface StartIntent {
  readonly id: string;
  /** null until bound */
  readonly reservation: string | null;
  readonly expires: number;
  /** once only, to the reservation in Start's answer; a second bind, or one after expiry or cancel, throws and spends N */
  bind(reservation: string): void;
  /** spend N now: a Start the server refused, or one abandoned before the key arrived */
  cancel(): void;
}

export interface DeviceInfo {
  readonly id: string;
  readonly name: string;
  readonly kind: "browser" | "app" | "cli" | "vm" | "computer" | "provisioned";
  readonly addedAtStart: boolean;
  readonly reservation: string | null;
  readonly fingerprint: string;
  readonly current: boolean;
}

export interface PendingEnrollment {
  readonly session: string;
  readonly intent: string | null;
  readonly reservation: string;
  readonly instance: string | null;
  readonly kind: "provisioned";
  readonly fingerprint: string;
  readonly name: string;
}

export type RefusedWhy = "no-intent" | "other-page" | "expired" | "used" | "other-reservation" | "not-provisioned" | "not-h1" | "not-first" | "not-bound";

export interface TokenUsedWarning {
  readonly reservation: string;
  readonly removed: string | null;
  readonly text: string;
}
