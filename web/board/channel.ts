// The frame's side of a host's answer channel (web/board-host-protocol.md):
// the port its parent transferred with the board, and the board it posted
// (its name and revision).  The board's Submit bar sends the page's answers
// on it, and a question's "What do my words show?" asks the host to decide
// among the question's `decide` options.  Only the port's messages are
// answers; each is checked, and taken only for the id it names.

import type { AskAnswer } from "./doc";

/** A page, as the protocol names it: its number from 1, and its id and title if it has them. */
export interface PageRef { number: number; id?: string; title?: string }
/** What a submission sends: the page's answers, the reader's own words, the comment. */
export interface Answers { page: PageRef; answers: Record<string, AskAnswer>; notes: Record<string, string>; comment: string }
export type SubmitResult = { received: true } | { refused: string };
export type DecideResult = { option: string | null } | { refused: string };

/** What the board is given when its host takes answers (BoardHost.answers). */
export interface AnswerChannel {
  /** Send these answers as submission `id` (the same id to send them
   * again); resolves when the host says received or refused that id. */
  submit(id: string, a: Answers): Promise<SubmitResult>;
  /** Ask the host which of a question's decide options the reader's words show; resolves with its answer, or refused. */
  decide(page: PageRef, item: string, note: string): Promise<DecideResult>;
}

// (a decision not answered in this long: said so, the reader can ask again)
const DECIDE_MS = 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const short = (s: unknown) => (typeof s === "string" ? s.slice(0, 500) : "");
/** A new random UUID (version 4): crypto.randomUUID's, or made the same way where it is missing. */
export function uuid(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** The channel over `port`, for the board posted as `name` and `revision`. */
export function answerChannel(port: MessagePort, name: string | null, revision: string | null): AnswerChannel {
  // (each id's waiters: a submission sent again waits with the first)
  const submits = new Map<string, ((r: SubmitResult) => void)[]>();
  const decides = new Map<string, (r: DecideResult) => void>();
  port.onmessage = (e) => {
    const m = e.data;
    if (!m || typeof m !== "object" || m.version !== 1 || typeof m.id !== "string" || !UUID.test(m.id)) return;
    if (m.sagebrush === "received" || (m.sagebrush === "refused" && submits.has(m.id))) {
      const ws = submits.get(m.id);
      if (!ws) return;
      submits.delete(m.id);
      const r: SubmitResult = m.sagebrush === "received" ? { received: true } : { refused: short(m.message) || "refused" };
      for (const w of ws) w(r);
    } else if (m.sagebrush === "decided" || m.sagebrush === "refused") {
      const w = decides.get(m.id);
      if (!w) return;
      decides.delete(m.id);
      if (m.sagebrush === "refused") w({ refused: short(m.message) || "refused" });
      else if (m.option === null || (typeof m.option === "string" && m.option.length <= 80)) w({ option: m.option });
      else w({ refused: "the host's answer was not one of the options" });
    }
  };
  return {
    submit(id, a) {
      return new Promise((resolve) => {
        const ws = submits.get(id);
        if (ws) ws.push(resolve);
        else submits.set(id, [resolve]);
        port.postMessage({ sagebrush: "answers", version: 1, id, name, revision, page: a.page, answers: a.answers, notes: a.notes, comment: a.comment });
      });
    },
    decide(page, item, note) {
      return new Promise((resolve) => {
        const id = uuid();
        const timer = setTimeout(() => { if (decides.delete(id)) resolve({ refused: "no answer from the host" }); }, DECIDE_MS);
        decides.set(id, (r) => { clearTimeout(timer); resolve(r); });
        port.postMessage({ sagebrush: "decide", version: 1, id, name, revision, page, item, note });
      });
    },
  };
}
