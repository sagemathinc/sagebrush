// Transport for test-find.mjs. Every external wait has a deadline; failures
// retain the caller's phase and method instead of leaving board-c silent.
export class CDPError extends Error {}

export async function discoverPage(url, ms = 30_000) {
  const deadline = Date.now() + ms;
  let last;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const targets = await response.json(); // The signal also bounds the body.
      const page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
      last = new Error("no page target");
    } catch (error) { last = error; }
    await new Promise((resolve) => setTimeout(resolve, Math.min(100, Math.max(0, deadline - Date.now()))));
  }
  throw new CDPError(`browser startup: target discovery ${url} timed out after ${ms} ms (${last?.message})`);
}

export function connectCDP(url, { ms = 30_000, onEvent = () => {}, Socket = WebSocket } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new Socket(url), pending = new Map();
    let next = 0, opened = false, failure;
    const fail = (error) => {
      if (failure) return;
      failure = error;
      clearTimeout(openTimer);
      reject(error);
      for (const call of pending.values()) {
        clearTimeout(call.timer);
        call.reject(new CDPError(`${call.label}: ${error.message}`));
      }
      pending.clear();
      try { ws.close(); } catch {} // No close handshake is awaited.
    };
    const openTimer = setTimeout(() => fail(new CDPError(`browser startup: WebSocket open timed out after ${ms} ms`)), ms);
    ws.addEventListener("error", () => fail(new CDPError("CDP WebSocket error")));
    ws.addEventListener("close", (event) => fail(new CDPError(`CDP WebSocket closed (${event.code ?? "unknown"})`)));
    ws.addEventListener("message", (event) => {
      try {
        const message = JSON.parse(event.data);
        const call = pending.get(message.id);
        if (call) {
          pending.delete(message.id);
          clearTimeout(call.timer);
          if (message.error) call.reject(new CDPError(`${call.label}: CDP error ${JSON.stringify(message.error)}`));
          else call.resolve(message.result);
        } else if (message.method) onEvent(message);
      } catch (error) { fail(new CDPError(`CDP message: ${error.message}`)); }
    });
    ws.addEventListener("open", () => {
      if (opened || failure) return;
      opened = true;
      clearTimeout(openTimer);
      resolve({
        send(method, params = {}, phase = "test-find") {
          const label = `${phase}: ${method}`;
          if (failure) return Promise.reject(new CDPError(`${label}: ${failure.message}`));
          return new Promise((resolve, reject) => {
            const id = ++next;
            const timer = setTimeout(() => fail(new CDPError(`${label} timed out after ${ms} ms`)), ms);
            pending.set(id, { resolve, reject, timer, label });
            try { ws.send(JSON.stringify({ id, method, params })); }
            catch (error) { fail(new CDPError(`${label}: send failed (${error.message})`)); }
          });
        },
        close() { fail(new CDPError("test cleanup")); },
      });
    });
  });
}
