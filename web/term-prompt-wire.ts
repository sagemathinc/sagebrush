// A Terminal prompt's two channel operations (web/term-sync.ts carries them as it carries every file operation; the
// state machine is unchanged): the worker's side encodes, the page's side checks, both with these functions.
//
// - `out`: output only, never a request for input.  A write: its header {op: "out", args: {segs, bytes}} with the
//   body's length, then the body in the channel's windows, then the page's answer {ok: true}, sent only after the
//   panel's writer has taken the segments.  The worker blocks on it, so one flush is in flight.  The body is the
//   segments in written order, each [fd: u8 (1 stdout | 2 stderr)][len: u32 LE][len bytes of UTF-8]: non-empty,
//   valid UTF-8, adjacent segments to the same fd already merged.
// - `line`: a request for one line of input, carrying no output.  Header only: {op: "line", args: {kind, cont,
//   prompt, bytes, lines}}; `kind` "prompt" (the prompt's own ps1/ps2) or "input" (input() is waiting); `cont`
//   whether lines of an unfinished input are held; `prompt` at most PROMPT_MAX UTF-8 bytes (input()'s own prompt
//   text is output, sent by `out` first); `bytes` and `lines` what the input may still take (r1 §7.1): each line
//   answered, or held by the page for the requests after, costs its UTF-8 bytes and one for its newline, and one
//   line.  A prompt's are what its statement has left (a paste the page holds counts whole against them, and one
//   that doesn't fit is refused whole, its tail never sent); input()'s are its own answer's, one line, never the
//   statement's.  Its answer is one of {line} | {eof: true} | {refused: "too-long"} | {interrupt: true}.

export const SEGS_MAX = 4096;
export const PROMPT_MAX = 256;
/** A segment's framing bytes: fd (1) and length (4). */
export const FRAME = 5;

export type Fd = 1 | 2;
export type Segment = { fd: Fd; text: string };
export type LineArgs = { kind: "prompt" | "input"; cont: boolean; prompt: string; bytes: number; lines: number };
export type LineAnswer = { line: string } | { eof: true } | { refused: "too-long" } | { interrupt: true };

const enc = new TextEncoder();
const utf8Len = (s: string) => enc.encode(s).length;

/** The body of an `out`: the segments framed, in order. */
export function encodeSegments(segs: readonly Segment[]): Uint8Array {
  const parts = segs.map((s) => enc.encode(s.text));
  const out = new Uint8Array(parts.reduce((n, p) => n + FRAME + p.length, 0));
  const dv = new DataView(out.buffer);
  let off = 0;
  for (let i = 0; i < segs.length; i++) {
    out[off] = segs[i].fd;
    dv.setUint32(off + 1, parts[i].length, true);
    out.set(parts[i], off + FRAME);
    off += FRAME + parts[i].length;
  }
  return out;
}

/** An `out` header's arguments, checked before anything is admitted: null when they aren't the protocol's. */
export function outArgs(args: unknown, length: number | undefined, allowance: number): { segs: number; bytes: number } | null {
  const a = args as any;
  if (!a || typeof a !== "object" || Object.keys(a).length !== 2) return null;
  const { segs, bytes } = a;
  if (!Number.isSafeInteger(segs) || segs < 1 || segs > SEGS_MAX) return null;
  if (!Number.isSafeInteger(bytes) || bytes !== length) return null;
  // (each segment at least one byte of text past its frame; the text within what the statement may still deliver)
  if (bytes < segs * (FRAME + 1) || bytes - segs * FRAME > allowance) return null;
  return { segs, bytes };
}

/** An `out` body, read whole and checked: the segments, or null when the body isn't the protocol's. */
export function decodeSegments(body: Uint8Array, segs: number): Segment[] | null {
  const dec = new TextDecoder("utf-8", { fatal: true });
  const dv = new DataView(body.buffer, body.byteOffset, body.byteLength);
  const out: Segment[] = [];
  let off = 0;
  while (off < body.length) {
    if (out.length >= segs || off + FRAME > body.length) return null;
    const fd = body[off], len = dv.getUint32(off + 1, true);
    if ((fd !== 1 && fd !== 2) || len === 0 || off + FRAME + len > body.length) return null;
    let text: string;
    try {
      text = dec.decode(body.subarray(off + FRAME, off + FRAME + len));
    } catch {
      return null;
    }
    // (adjacent segments to one fd are merged by the sender)
    if (out.length && out[out.length - 1].fd === fd) return null;
    out.push({ fd, text });
    off += FRAME + len;
  }
  return out.length === segs ? out : null;
}

/** A `line` header's arguments, checked: null when they aren't the protocol's, or say more is left than the prompt's
 * bounds allow (a statement's sourceBytes and lines; input()'s one line of sourceBytes, its newline counted). */
export function lineArgs(args: unknown, length: number | undefined, bounds: { sourceBytes: number; lines: number }): LineArgs | null {
  const a = args as any;
  if (length !== undefined || !a || typeof a !== "object" || Object.keys(a).length !== 5) return null;
  if ((a.kind !== "prompt" && a.kind !== "input") || typeof a.cont !== "boolean" || typeof a.prompt !== "string") return null;
  if (utf8Len(a.prompt) > PROMPT_MAX) return null;
  // (at least a line's newline and one line left: the worker never asks for a line that can't fit)
  if (!Number.isSafeInteger(a.bytes) || a.bytes < 1 || !Number.isSafeInteger(a.lines) || a.lines < 1 || (a.kind === "input" && a.lines !== 1)) return null;
  if (a.bytes > bounds.sourceBytes + (a.kind === "input" ? 1 : 0) || a.lines > bounds.lines) return null;
  return { kind: a.kind, cont: a.cont, prompt: a.prompt, bytes: a.bytes, lines: a.lines };
}

/** What lines cost against a request's `bytes` and `lines`: their UTF-8 bytes and a newline each, and their count. */
export function linesCost(lines: readonly string[]): { bytes: number; lines: number } {
  let bytes = 0;
  for (let i = 0; i < lines.length; i++) bytes += utf8Len(lines[i]) + 1;
  return { bytes, lines: lines.length };
}

/** A `line` answer as the worker receives it, checked against the bytes its text may take: null when it isn't one. */
export function lineAnswer(v: unknown, maxBytes: number): LineAnswer | null {
  const a = v as any;
  if (!a || typeof a !== "object") return null;
  const keys = Object.keys(a);
  if (keys.length !== 1) return null;
  if (keys[0] === "line") return typeof a.line === "string" && !a.line.includes("\n") && utf8Len(a.line) <= maxBytes ? { line: a.line } : null;
  if (keys[0] === "eof") return a.eof === true ? { eof: true } : null;
  if (keys[0] === "refused") return a.refused === "too-long" ? { refused: "too-long" } : null;
  if (keys[0] === "interrupt") return a.interrupt === true ? { interrupt: true } : null;
  return null;
}
