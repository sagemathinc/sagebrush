// The agents page in the desktop app (design/app-agent-host.md): the app connects an agent only through its own
// commands (agent_connect, agent_pair_code, agent_disconnect, agent_status), never from the address bar. So in the
// app, before any other module of the page reads the URL, a pairing link in it, the query form ?pair=CODE&port=N
// (workspace/pair-link.ts) or a #pair= fragment, is taken out of the address and dropped: pair-link.ts then finds
// none (its shared key already set), and no socket or dialog is ever opened for it. Off the app this does nothing.
// Imported first by the page.

/** Whether the page runs in the desktop app (its init script sets __SB_DESKTOP_APP__ before the page's scripts). */
export const inApp = typeof window !== "undefined" && (window as any).__SB_DESKTOP_APP__ === true;

const LINK_KEY = Symbol.for("sagebrush.pairLink");

if (inApp && typeof location !== "undefined") {
  const q = new URLSearchParams(location.search);
  const hadQuery = q.has("pair") || q.has("port");
  q.delete("pair");
  q.delete("port");
  const hash = /^#.*\bpair=/.test(location.hash) ? "" : location.hash;
  if (hadQuery || hash !== location.hash) {
    const search = q.toString();
    try {
      history.replaceState(history.state, "", location.pathname + (search ? "?" + search : "") + hash);
    } catch { /* (an address that can't be rewritten: the link is still never used, below) */ }
  }
  // (pair-link.ts reads the link once, under this key: set to none, it never takes one in the app)
  (globalThis as any)[LINK_KEY] = null;
}
