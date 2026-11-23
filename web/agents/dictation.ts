// Dictation into the Agents page's composer (#1791): a mic button by Send, where the browser can turn speech into
// text (SpeechRecognition). It is off until the person turns it on: the first click says, next to the mic, that the
// voice goes to the browser's speech service (Google's, in Chrome) and asks; the answer is kept in this browser, and
// Turn off (while listening) takes it back. While it listens, what is heard collects in the line by the mic, never in
// the draft: the draft stays the person's alone. Stop (the mic again) puts what was heard at the end of the draft;
// Discard drops it. Sending, another chat, a hidden tab or a failure stop it, and what was heard goes into the draft
// it was spoken for: nothing heard is sent, and nothing is lost without the person's Discard. Where the browser
// can't turn speech into text, there is no mic at all.

export const DICTATION_COPY = {
  start: "Dictate",
  stop: "Stop dictating and add the words to the message",
  title: "Dictate: speak, then click again to add your words to the message",
  ask: "Dictation sends your voice to your browser's speech service (Google's, in Chrome) to turn it into text.",
  turnOn: "Turn on",
  notNow: "Not now",
  listening: "Listening (your browser's speech service)…",
  turnOff: "Turn off",
  discard: "Discard",
  denied: "The microphone isn't allowed for this page. Allow it in the browser's site settings to dictate.",
  noMic: "No microphone was found.",
  network: "Dictation needs the browser's speech service, which couldn't be reached.",
  failed: "Dictation stopped",
} as const;

type Recognition = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
};

export interface DictationHost {
  /** where the button goes: before this element */
  before: HTMLElement;
  /** the chat whose draft the composer holds: dictation belongs to the one it started in */
  conversation(): string;
  /** adds words at the end of a chat's draft (the composer's, if that chat is shown) */
  append(conversation: string, text: string): void;
  toast(text: string, ms?: number): void;
}

// (the person turned dictation on in this browser: "1"; absent, it asks first)
const ON_KEY = "sb-dictation-on-v1";
const isOn = () => { try { return localStorage.getItem(ON_KEY) === "1"; } catch { return false; } };
const setOn = (on: boolean) => { try { on ? localStorage.setItem(ON_KEY, "1") : localStorage.removeItem(ON_KEY); } catch {} };
const join = (a: string, b: string) => (!a ? b : !b ? a : a + " " + b);

export function mountDictation(h: DictationHost) {
  const Ctor = ((globalThis as any).SpeechRecognition ?? (globalThis as any).webkitSpeechRecognition) as (new () => Recognition) | undefined;
  if (!Ctor) return { finish() {}, available: false };
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}) => Object.assign(document.createElement(tag), props);
  const btn = el("button", { id: "mic", type: "button", title: DICTATION_COPY.title, textContent: "🎤" });
  btn.setAttribute("aria-label", DICTATION_COPY.start);
  btn.setAttribute("aria-pressed", "false");
  // (asked next to the mic, before anything is heard: where the voice goes, Turn on or Not now)
  const ask = el("span", { id: "mic-ask", className: "mic-ask", hidden: true });
  const on = el("button", { type: "button", textContent: DICTATION_COPY.turnOn });
  const not = el("button", { type: "button", textContent: DICTATION_COPY.notNow });
  ask.append(el("span", { textContent: DICTATION_COPY.ask }), " ", on, " ", not);
  // (while listening: what is heard so far, and Discard and Turn off; mounted once, so the keyboard stays on them)
  const status = el("span", { id: "mic-status", className: "mic-status", hidden: true });
  status.setAttribute("role", "status");
  const label = el("span", { className: "mic-label", textContent: DICTATION_COPY.listening });
  const heardEl = el("span", { className: "mic-heard" });
  const off = el("button", { type: "button", className: "link", textContent: DICTATION_COPY.turnOff });
  const discard = el("button", { type: "button", className: "link", textContent: DICTATION_COPY.discard });
  status.append(label, " ", heardEl, " ", discard, " · ", off);
  h.before.before(btn, ask, status);

  let rec: Recognition | null = null;
  // (the chat it is listening for, and what has been heard for it: final words, and the part still being recognized)
  let conv = "";
  let heard = "";
  let interim = "";

  function draw() {
    const listening = !!rec;
    btn.classList.toggle("rec", listening);
    btn.setAttribute("aria-pressed", String(listening));
    btn.setAttribute("aria-label", listening ? DICTATION_COPY.stop : DICTATION_COPY.start);
    status.hidden = !listening;
    heardEl.textContent = listening ? join(heard, interim) : "";
  }
  function start() {
    if (rec) return; // (one at a time)
    let r: Recognition;
    try {
      r = new Ctor!();
      r.continuous = true;
      r.interimResults = true;
      r.lang = navigator.language || "en-US";
    } catch (err) {
      h.toast(`${DICTATION_COPY.failed}: ${(err as Error)?.message ?? err}`, 8000);
      return;
    }
    conv = h.conversation();
    heard = "";
    interim = "";
    r.onresult = (e) => {
      if (rec !== r) return;
      interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        const text = (res[0]?.transcript ?? "").trim();
        if (!text) continue;
        if (res.isFinal) heard = join(heard, text);
        else interim = join(interim, text);
      }
      draw();
    };
    r.onerror = (e) => {
      if (rec !== r) return;
      // (no speech heard, or stopped here: nothing to say)
      if (e.error === "no-speech" || e.error === "aborted") return;
      h.toast(e.error === "not-allowed" || e.error === "service-not-allowed" ? DICTATION_COPY.denied : e.error === "audio-capture" ? DICTATION_COPY.noMic : e.error === "network" ? DICTATION_COPY.network : `${DICTATION_COPY.failed}: ${e.error}`, 8000);
    };
    // (it ended by itself (silence, a failure): what was heard goes into its draft, never sent)
    r.onend = () => { if (rec === r) finish(); };
    rec = r;
    try {
      r.start();
    } catch (err) {
      rec = null;
      draw();
      h.toast(`${DICTATION_COPY.failed}: ${(err as Error)?.message ?? err}`, 8000);
      return;
    }
    draw();
  }
  /** Stops listening; what was heard (final words only) goes at the end of the draft of the chat it was spoken for. */
  function finish() {
    const r = rec;
    if (!r) return;
    rec = null;
    try { r.abort(); } catch {}
    const words = heard;
    heard = interim = "";
    draw();
    if (words) h.append(conv, words);
  }
  /** Discard: listening stops, and what was heard is dropped; the draft is as it was. */
  function drop() {
    const r = rec;
    if (!r) return;
    rec = null;
    try { r.abort(); } catch {}
    heard = interim = "";
    draw();
  }
  btn.onclick = () => {
    if (rec) return finish();
    if (isOn()) return start();
    ask.hidden = !ask.hidden; // (asked; a second click on the mic puts the question away)
    if (!ask.hidden) setTimeout(() => on.focus(), 0); // (after the click's own handling, which may move focus)
  };
  on.onclick = () => { setOn(true); ask.hidden = true; btn.focus(); start(); };
  not.onclick = () => { ask.hidden = true; btn.focus(); };
  off.onclick = () => { finish(); setOn(false); btn.focus(); };
  discard.onclick = () => { drop(); btn.focus(); };
  // (never in the background: a hidden tab stops listening)
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") finish(); });
  return { finish, available: true };
}
