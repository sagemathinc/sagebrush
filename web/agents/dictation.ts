// Dictation into the Agents page's composer (#1791): a mic button by Send, where the browser can turn speech into
// text (SpeechRecognition). It is off until the person turns it on: the first click says, next to the mic, that the
// voice goes to the browser's speech service (Google's, in Chrome) and asks; the answer is kept in this browser, and
// Turn off (while listening) takes it back. Then a click starts listening, a second stops it; what is heard is added
// to the draft as it is recognized, after whatever was typed. Sending stops it. Where the browser can't, no button.

export const DICTATION_COPY = {
  start: "Dictate",
  stop: "Stop dictating",
  title: "Dictate: speak, and your words are added to the message",
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
  value(): string;
  setValue(v: string): void;
  toast(text: string, ms?: number): void;
  /** the chat whose draft the composer holds: dictation belongs to the one it started in */
  conversation(): string;
}

// (the person turned dictation on in this browser: "1"; absent, it asks first)
const ON_KEY = "sb-dictation-on-v1";
const isOn = () => { try { return localStorage.getItem(ON_KEY) === "1"; } catch { return false; } };
const setOn = (on: boolean) => { try { on ? localStorage.setItem(ON_KEY, "1") : localStorage.removeItem(ON_KEY); } catch {} };

export function mountDictation(h: DictationHost) {
  const Ctor = ((globalThis as any).SpeechRecognition ?? (globalThis as any).webkitSpeechRecognition) as (new () => Recognition) | undefined;
  if (!Ctor) return { stop() {}, available: false };
  const btn = Object.assign(document.createElement("button"), { id: "mic", type: "button", title: DICTATION_COPY.title, textContent: "🎤" });
  btn.setAttribute("aria-label", DICTATION_COPY.start);
  btn.setAttribute("aria-pressed", "false");
  const status = Object.assign(document.createElement("span"), { id: "mic-status", className: "mic-status" });
  status.setAttribute("role", "status");
  status.hidden = true;
  // (asked next to the mic, before anything is heard: where the voice goes, Turn on or Not now)
  const ask = Object.assign(document.createElement("span"), { id: "mic-ask", className: "mic-ask" });
  ask.hidden = true;
  const on = Object.assign(document.createElement("button"), { type: "button", textContent: DICTATION_COPY.turnOn });
  const not = Object.assign(document.createElement("button"), { type: "button", textContent: DICTATION_COPY.notNow });
  ask.append(Object.assign(document.createElement("span"), { textContent: DICTATION_COPY.ask }), " ", on, " ", not);
  const off = Object.assign(document.createElement("button"), { type: "button", className: "link", textContent: DICTATION_COPY.turnOff });
  const discard = Object.assign(document.createElement("button"), { type: "button", className: "link", textContent: DICTATION_COPY.discard });
  h.before.before(btn, ask, status);

  // (the status line: its words, and its two controls, mounted once so the keyboard stays on them as words arrive)
  const words = document.createElement("span");
  status.append(words, " ", discard, " · ", off);

  let rec: Recognition | null = null;
  // (the chat it started in, and the pieces it has added to that chat's draft, in order: Discard takes those out and
  //  nothing else, whatever the person typed meanwhile)
  let conv = "";
  let added: string[] = [];
  const join = (a: string, b: string) => (!a ? b : !b ? a : /\s$/.test(a) ? a + b : a + " " + b);

  function draw(on: boolean, interim = "") {
    btn.classList.toggle("rec", on);
    btn.setAttribute("aria-pressed", String(on));
    btn.setAttribute("aria-label", on ? DICTATION_COPY.stop : DICTATION_COPY.start);
    status.hidden = !on;
    words.textContent = on ? (interim ? `${DICTATION_COPY.listening} ${interim}` : DICTATION_COPY.listening) : "";
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
    added = [];
    r.onresult = (e) => {
      if (rec !== r) return;
      // (another chat's draft in the composer now: this one stops, adding nothing there)
      if (h.conversation() !== conv) return stop();
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        const text = (res[0]?.transcript ?? "").trim();
        if (!text) continue;
        if (res.isFinal) {
          // (added to the draft as it is now, after whatever the person has typed meanwhile)
          const now = h.value();
          const next = join(now, text);
          added.push(next.slice(now.length));
          h.setValue(next);
        } else interim = join(interim, text);
      }
      draw(true, interim);
    };
    r.onerror = (e) => {
      if (rec !== r) return;
      // (no speech heard, or stopped here: nothing to say)
      if (e.error === "no-speech" || e.error === "aborted") return;
      h.toast(e.error === "not-allowed" || e.error === "service-not-allowed" ? DICTATION_COPY.denied : e.error === "audio-capture" ? DICTATION_COPY.noMic : e.error === "network" ? DICTATION_COPY.network : `${DICTATION_COPY.failed}: ${e.error}`, 8000);
    };
    r.onend = () => {
      if (rec !== r) return;
      rec = null;
      draw(false);
    };
    rec = r;
    try {
      r.start();
    } catch (err) {
      rec = null;
      draw(false);
      h.toast(`${DICTATION_COPY.failed}: ${(err as Error)?.message ?? err}`, 8000);
      return;
    }
    draw(true);
  }
  /** Stops listening. Words still being recognized are dropped (the message may already be on its way). */
  function stop() {
    const r = rec;
    if (!r) return;
    rec = null;
    try { r.abort(); } catch {}
    draw(false);
  }
  /** Discard: listening stops, and the pieces it added to this chat's draft come out (the last of each, from the end),
   *  what the person typed staying. */
  function discardAll() {
    const mine = h.conversation() === conv;
    stop();
    if (!mine) return;
    let v = h.value();
    for (const piece of [...added].reverse()) {
      const at = v.lastIndexOf(piece);
      if (at >= 0) v = v.slice(0, at) + v.slice(at + piece.length);
    }
    added = [];
    h.setValue(v);
  }
  btn.onclick = () => {
    if (rec) return stop();
    if (isOn()) return start();
    ask.hidden = !ask.hidden; // (asked; a second click on the mic puts the question away)
    if (!ask.hidden) setTimeout(() => on.focus(), 0); // (after the click's own handling, which may move focus)
  };
  on.onclick = () => { setOn(true); ask.hidden = true; btn.focus(); start(); };
  not.onclick = () => { ask.hidden = true; btn.focus(); };
  off.onclick = () => { stop(); setOn(false); btn.focus(); };
  discard.onclick = () => { discardAll(); btn.focus(); };
  // (never in the background: a hidden tab stops listening)
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") stop(); });
  return { stop, available: true };
}
