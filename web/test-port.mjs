// Ports for the browser tests, so that any number of test runs can share a
// machine (the shared test VM runs several CI runs at once): a test's
// Chrome is started with --remote-debugging-port=0, or CDP_PORT when it is
// set, and devtoolsPort() reads the port Chrome chose from its profile's
// DevToolsActivePort file; a server a test starts listens where freePort()
// says (port 0: the system's choice), or on port 0 itself.
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";

/** The DevTools port of a Chrome started with --remote-debugging-port=0 and
 * --user-data-dir=profile, once it is listening (within `ms`). */
export async function devtoolsPort(profile, ms = 60_000) {
  const t = Date.now();
  for (;;) {
    try {
      const port = Number(readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")[0]);
      if (port > 0) return port;
    } catch {}
    if (Date.now() - t > ms) throw new Error(`Chrome did not say its DevTools port within ${ms / 1000} s (${profile})`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** A port free now (the system's choice), for a server that must be told one. */
export function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}
