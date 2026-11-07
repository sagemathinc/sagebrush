// The host side of the isolated output renderer (OUT-ISO plan r3, phase 1): one lazily
// mounted, sandboxed frame per cell output area, a bounded number of them live, each
// driven over its own MessagePort with the closed schema of web/output-shell/protocol.js.
// Phase 1 migrates no output: nothing calls this yet but its harness
// (web/test-output-frames.mjs); phase 2 moves HTML and Markdown here.
//
// What it guarantees (the plan's contracts):
// - The frame is <iframe sandbox="allow-scripts">: never allow-same-origin, forms,
//   popups, downloads or navigation.  Its document is the packaged srcdoc (local,
//   desktop, export) or, hosted, the pinned shell URL; no output is ever put in the
//   page's own DOM, and a failure shows text, never inline rich content.
// - The port goes once to that frame's own window, after it loads; only that port is
//   listened to, so a message from any other window or an old frame is never seen.
// - RENDER-COMMIT-1: each render has a generation; it ends exactly once, committed
//   (the frame says so for that generation and the outputs sent) or error (the frame
//   says so, or the shell doesn't load within LOAD_MS, or the commit doesn't come within
//   COMMIT_MS of being sent).  A render is accepted, and pending, from render() on, so a
//   renderer that never starts still ends it.  A newer render, a clear or a dispose ends the old one at once, here,
//   without waiting for the frame.  Heights after the commit only resize, at most
//   heightHz a second here at the host, whatever the frame sends: the latest one is kept
//   and applied when the interval allows, and dropped if the area's generation, frame or
//   render changes first (OUTISO-RATE-1).  Disposing the
//   whole set ends every pending render (live, starved of a frame or offscreen) as
//   "disposed", once, and leaves no frame, box content, timer or observer (RENDER-COMMIT-2).
// - EVICT-LAYOUT-1: at most `cap` frames live in the page.  An area asks for a frame when
//   it is visible (or deliberately, show()); the focused or asked-for area first, then
//   the visible ones nearest the viewport, document order breaking ties.  Asking is
//   one admission's priority, not a pin: once mounted, an asked-for area is evictable
//   like any other when it is offscreen, unfocused and committed (EVICT-LAYOUT-2).  If none is
//   free, the unfocused area seen least recently offscreen gives its frame back; if none
//   may, the area stays a placeholder.  An area with a render in flight is never
//   evicted.  A placeholder keeps the last height (or INITIAL_PX before any).
//   Remounting replays the latest outputs, as a new generation to a fresh renderer.
//
// The bounds are phase-1 measurement candidates (frozen with their provenance from the
// 50/200-area measurements, daybreak3's ruling, Nov 7), not approved defaults.
import { LIMITS, decode, encode } from "../output-shell/protocol.js";

// (loadMs: the shell must say ready within this; commitMs: a render must commit within this after it is sent;
// initialPx: a placeholder's height before any commit; cap: live frames a page, the frozen initial value (daybreak3,
// Nov 7) from the dense 50/200 measurements of web/test-output-frames.mjs: about 32-34 MB and 0.3-0.36 s at most in
// Chromium and Firefox; WebKit's figures come before any raise)
export const FRAME_LIMITS = Object.freeze({ loadMs: 10000, commitMs: 6000, initialPx: 120, cap: 24, heightHz: 30 });
export const LOAD_MS = FRAME_LIMITS.loadMs;
export const COMMIT_MS = FRAME_LIMITS.commitMs;
export const INITIAL_PX = FRAME_LIMITS.initialPx;
export const DEFAULT_CAP = FRAME_LIMITS.cap;
export const HEIGHT_HZ = FRAME_LIMITS.heightHz;
// (the packaged shell page, web/output-shell/build.mts: every bundle's __SB_OUTPUT_SHELL__, web/build.ts)
export const PACKAGED_SHELL = typeof __SB_OUTPUT_SHELL__ === "string" ? __SB_OUTPUT_SHELL__ : "";

/**
 * `srcdoc`: the packaged shell page (or null); `url`: the hosted shell's pinned URL (or null): exactly one.
 * `cap`: live frames at most.  `root`: the scrolling element areas live in (for visibility).
 * `onEvent(e)`: told every transition (tests and diagnostics; never authority).
 * `loadMs`, `commitMs`: the two deadlines (shorter in tests).
 */
export function createOutputFrames({ srcdoc = null, url = null, cap = DEFAULT_CAP, root = null, onEvent = () => {}, loadMs = LOAD_MS, commitMs = COMMIT_MS } = {}) {
  if ((srcdoc === null) === (url === null)) throw new Error("output frames: exactly one of srcdoc and url");
  if (!Number.isSafeInteger(cap) || cap < 1) throw new Error("output frames: a cap of at least one frame");
  const areas = new Map(); // id -> area
  let order = 0, theme = "light", closed = false;
  const live = () => [...areas.values()].filter((a) => a.frame);

  const seen = new IntersectionObserver((entries) => {
    for (const en of entries) {
      const a = [...areas.values()].find((x) => x.el === en.target);
      if (!a) continue;
      a.visible = en.isIntersecting;
      a.seenAt = performance.now();
    }
    admit();
  }, { root, rootMargin: "200px 0px" });

  function distance(a) {
    const r = a.el.getBoundingClientRect(), vh = root ? root.getBoundingClientRect() : { top: 0, bottom: innerHeight };
    return r.bottom < vh.top ? vh.top - r.bottom : r.top > vh.bottom ? r.top - vh.bottom : 0;
  }
  // (who gets a frame: the asked-for or focused first, then visible ones by distance, then document order)
  function admit() {
    if (closed) return;
    const want = [...areas.values()].filter((a) => !a.frame && a.outputs && (a.asked || a.visible))
      .sort((x, y) => (y.asked - x.asked) || (distance(x) - distance(y)) || (x.order - y.order));
    for (const a of want) {
      if (live().length >= cap) {
        const victim = live().filter((v) => !v.asked && !v.focused && !v.visible && !v.pending).sort((x, y) => x.seenAt - y.seenAt)[0];
        if (!victim) break; // (none may give its frame back: the rest stay placeholders)
        unmount(victim, "evicted");
      }
      mount(a);
    }
  }

  function placeholder(a) {
    a.box.replaceChildren();
    const p = document.createElement("div");
    p.className = "sb-out-placeholder";
    p.style.height = `${a.height ?? INITIAL_PX}px`;
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = a.failed ? `Output couldn't be shown (${a.failed}): show again` : "Show output";
    b.onclick = () => { a.failed = null; a.asked = true; admit(); };
    p.append(b);
    a.box.append(p);
  }

  function mount(a) {
    const f = document.createElement("iframe");
    f.setAttribute("sandbox", "allow-scripts");
    f.setAttribute("referrerpolicy", "no-referrer");
    f.setAttribute("allow", "");
    f.title = a.title;
    f.className = "sb-out-frame";
    f.style.cssText = `border:0;width:100%;display:block;height:${a.height ?? INITIAL_PX}px`;
    const ch = new MessageChannel();
    a.frame = f; a.port = ch.port1; a.ready = false;
    a.asked = false; // (admitted: the request is spent, EVICT-LAYOUT-2)
    a.seenAt = performance.now();
    const mine = f;
    a.loadTimer = setTimeout(() => { if (a.frame === mine && !a.ready) fail(a, "the output viewer didn't start"); }, loadMs);
    f.addEventListener("load", () => {
      if (a.frame !== mine || !f.contentWindow) return;
      f.contentWindow.postMessage({ sbOutIso: 1 }, "*", [ch.port2]); // (opaque origin: "*"; the port, not the origin, is the identity)
    }, { once: true });
    ch.port1.onmessage = (e) => receive(a, mine, decode("to-host", e.data));
    if (srcdoc !== null) f.srcdoc = srcdoc; else f.src = url;
    a.box.replaceChildren(f);
    onEvent({ type: "mount", area: a.id, live: live().length });
  }

  function unmount(a, why) {
    clearTimeout(a.loadTimer); clearTimeout(a.commitTimer); retireHeight(a);
    if (a.port) { try { a.port.postMessage(encode("to-frame", "dispose")); } catch {} a.port.close(); }
    a.frame?.remove();
    a.frame = null; a.port = null; a.ready = false;
    if (a.pending) end(a, "error", why); // (never on eviction: an area with a render in flight isn't evicted)
    a.asked = false;
    placeholder(a);
    onEvent({ type: "unmount", area: a.id, why, live: live().length });
  }

  function send(a) {
    if (!a.ready || !a.outputs) return;
    if (a.sent === a.generation) { // (a remount replays the outputs as a new generation, to a fresh renderer)
      a.generation++;
      a.pending = { generation: a.generation, ids: a.outputs.map((o) => o.id) };
    }
    a.sent = a.generation;
    clearTimeout(a.commitTimer);
    const g = a.generation;
    a.commitTimer = setTimeout(() => { if (a.pending?.generation === g) fail(a, "the output viewer didn't finish"); }, commitMs);
    a.port.postMessage(encode("to-frame", "render", { generation: g, area: a.id, outputs: a.outputs }));
  }

  // (a queued height, dropped: a new render, a clear, an unmount or a failure retires it)
  function retireHeight(a) {
    clearTimeout(a.heightTimer);
    a.heightTimer = 0;
    a.nextHeight = null;
  }

  function end(a, result, reason = "") {
    const p = a.pending;
    if (!p) return;
    a.pending = null;
    clearTimeout(a.commitTimer);
    onEvent({ type: result, area: a.id, generation: p.generation, reason });
  }

  function fail(a, reason) {
    a.failed = reason;
    retireHeight(a);
    end(a, "error", reason);
    if (a.frame) { a.asked = false; const f = a.frame; clearTimeout(a.loadTimer); a.port?.close(); a.port = null; a.frame = null; f.remove(); } // (its port closed before it stops being the frame)
    placeholder(a);
  }

  function receive(a, frame, m) {
    if (!m || a.frame !== frame) return; // (an old frame's port, or not the schema: nothing)
    if (m.type === "ready") {
      if (a.ready) return;
      a.ready = true;
      clearTimeout(a.loadTimer);
      onEvent({ type: "ready", area: a.id });
      a.port.postMessage(encode("to-frame", "theme", { theme }));
      return send(a);
    }
    const p = a.pending;
    if (m.type === "committed") {
      if (!p || m.generation !== p.generation || m.area !== a.id || m.ids.join("\n") !== p.ids.join("\n")) return;
      a.height = m.height;
      frame.style.height = `${m.height}px`;
      end(a, "committed");
      return;
    }
    if (m.type === "height") {
      if (p || m.generation !== a.generation) return; // (heights only after its commit, for the latest generation)
      a.nextHeight = m.height; // (the latest kept; applied at most heightHz a second)
      if (a.heightTimer) return;
      const g = a.generation;
      a.heightTimer = setTimeout(() => {
        a.heightTimer = 0;
        const h = a.nextHeight;
        a.nextHeight = null;
        if (a.frame !== frame || a.generation !== g || a.pending || h === null) return; // (retired meanwhile: dropped)
        a.heightAt = performance.now();
        a.height = h;
        frame.style.height = `${h}px`;
        onEvent({ type: "height", area: a.id, generation: g, height: h });
      }, Math.max(0, a.heightAt + 1000 / HEIGHT_HZ - performance.now()));
      return;
    }
    if (m.type === "error" && p && m.generation === p.generation) fail(a, "the output viewer refused it");
  }

  return {
    /** An area for `id` in `box` (an element the caller placed in the document). */
    area(id, box, { title = "Output" } = {}) {
      if (closed) throw new Error("output frames: disposed");
      if (!/^[A-Za-z0-9_.:-]{1,64}$/.test(id) || areas.has(id)) throw new Error(`output area ${id}: not a fresh id`);
      const a = { id, box, el: box, title, order: order++, frame: null, port: null, ready: false, outputs: null, generation: 0, pending: null,
        height: null, sent: -1, visible: false, asked: false, focused: false, seenAt: 0, failed: null, loadTimer: 0, commitTimer: 0,
        heightTimer: 0, nextHeight: null, heightAt: -Infinity };
      areas.set(id, a);
      placeholder(a);
      seen.observe(box);
      const api = {
        /** Show these admitted outputs ([{id, kind, body}]): a new generation; an older one ends now. */
        render(outputs) {
          if (!Array.isArray(outputs) || outputs.length > LIMITS.outputsPerRender) throw new Error("output area: too many outputs");
          if (a.pending) end(a, "error", "replaced");
          retireHeight(a);
          a.outputs = outputs.map((o) => ({ id: o.id, kind: o.kind, body: o.body }));
          a.generation++;
          a.pending = { generation: a.generation, ids: a.outputs.map((o) => o.id) }; // (accepted: it ends exactly once from here)
          a.failed = null;
          if (a.frame) send(a); else { placeholder(a); admit(); }
          return a.generation;
        },
        /** Show it now, if the cap allows (a deliberate request: it goes first). */
        show() { a.asked = true; admit(); },
        focus(on) { a.focused = !!on; },
        clear() { retireHeight(a); if (a.pending) end(a, "error", "cleared"); a.outputs = null; a.height = null; if (a.frame) unmount(a, "cleared"); else placeholder(a); },
        dispose() { retireHeight(a); if (a.pending) end(a, "error", "disposed"); a.outputs = null; if (a.frame) unmount(a, "disposed"); seen.unobserve(box); box.replaceChildren(); areas.delete(id); admit(); },
        get state() { return { live: !!a.frame, ready: a.ready, generation: a.generation, pending: a.pending?.generation ?? null, height: a.height, failed: a.failed }; },
      };
      return api;
    },
    setTheme(t) { theme = t; for (const a of live()) if (a.ready) a.port.postMessage(encode("to-frame", "theme", { theme })); },
    counts() { return { areas: areas.size, live: live().length, ports: live().filter((a) => a.port).length, pending: [...areas.values()].filter((a) => a.pending).length }; },
    dispose() {
      closed = true;
      for (const a of [...areas.values()]) {
        end(a, "error", "disposed"); // (every pending render, live or not, ends here, once)
        a.outputs = null;
        if (a.frame) unmount(a, "disposed");
        clearTimeout(a.loadTimer); clearTimeout(a.commitTimer); retireHeight(a);
        seen.unobserve(a.box);
        a.box.replaceChildren();
      }
      areas.clear();
      seen.disconnect();
    },
  };
}
