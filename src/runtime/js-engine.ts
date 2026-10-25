// The JavaScript engine this runtime runs on, for the memory estimates whose
// object sizes are the engine's (lib/_sage_padic_lseries.py's ledger,
// plan-kedlaya-optin r6 section 2): "v8", "jsc", "spidermonkey" or
// "unknown", which an estimate refuses rather than guess.  The probes are
// gathered once, when this module loads (before any user code), by one
// function, and decided by a pure one, so tests decide injected probe
// vectors with exactly the shipped decision.  A probe that throws, or
// metadata that is absent, counts as no signal.  The user agent is a
// supported-host compatibility signal, not authentication.

export type JsEngine = "v8" | "jsc" | "spidermonkey" | "unknown";

export interface EngineProbes {
  bun: boolean; // process.versions.bun: Bun, built on JavaScriptCore
  denoV8: boolean; // Deno.version.v8
  nodeV8: boolean; // process.versions.node and process.versions.v8
  callSites: boolean; // Error.prepareStackTrace yields an Array of call sites (V8's API)
  internalError: boolean; // typeof InternalError === "function" (SpiderMonkey)
  userAgent: string | null; // navigator.userAgent, when there is one
  nanSignKept: boolean | null; // whether a NaN keeps its sign in a JS value (numpy.ts's NAN_SIGN_KEPT)
}

const probe = <T>(f: () => T, none: T): T => {
  try {
    return f();
  } catch {
    return none;
  }
};

export function gatherEngineProbes(g: any = globalThis): EngineProbes {
  const versions = probe(() => g.process?.versions ?? null, null);
  return {
    bun: probe(() => typeof versions?.bun === "string", false),
    denoV8: probe(() => typeof g.Deno?.version?.v8 === "string", false),
    nodeV8: probe(() => typeof versions?.node === "string" && typeof versions?.v8 === "string", false),
    callSites: probe(() => {
      const E = g.Error;
      const prev = E.prepareStackTrace;
      E.prepareStackTrace = (_: any, cs: any[]) => cs;
      try {
        const s = new E().stack;
        return Array.isArray(s) && s.length > 0 && typeof s[0]?.getFunctionName === "function";
      } finally {
        E.prepareStackTrace = prev;
      }
    }, false),
    internalError: probe(() => typeof g.InternalError === "function", false),
    userAgent: probe(() => (typeof g.navigator?.userAgent === "string" ? g.navigator.userAgent : null), null),
    nanSignKept: probe(() => {
      const f = new g.Float64Array(2), w = new g.Uint32Array(f.buffer);
      w[1] = 0xfff80000;
      f[1] = f[0];
      return w[3] === 0xfff80000;
    }, null),
  };
}

// a WebKit host (Safari, Playwright's WebKit): AppleWebKit, and none of the
// tokens of the browsers that also say AppleWebKit (Chromium, Edge, Opera)
// or wrap another engine's app on iOS (CriOS, FxiOS)
const WEBKIT = /AppleWebKit\//;
const NOT_WEBKIT = /Chrome|Chromium|CriOS|Edg|OPR|Firefox|FxiOS/;

export function decideEngine(v: EngineProbes): JsEngine {
  // 1. a host that names its engine (Bun first: it also honours V8's
  // call-site API)
  if (v.bun) return "jsc";
  if (v.denoV8) return "v8";
  if (v.nodeV8) return "v8";
  // 2. browsers and their workers: exactly one positive family signal
  const webkit = v.userAgent !== null && WEBKIT.test(v.userAgent) && !NOT_WEBKIT.test(v.userAgent);
  if ((v.callSites ? 1 : 0) + (v.internalError ? 1 : 0) + (webkit ? 1 : 0) !== 1) return "unknown";
  if (v.callSites) return "v8";
  if (v.internalError) return "spidermonkey";
  // the WebKit identity, with JavaScriptCore's canonical NaNs agreeing (a
  // consistency check: canonical NaNs alone are no identity)
  return v.nanSignKept === false ? "jsc" : "unknown";
}

// The host that named its engine, else "browser" (a page or its worker):
// an engine's table can be established for one of its hosts and not yet
// for another (JavaScriptCore: Bun, not yet WebKit).
export type JsHost = "bun" | "deno" | "node" | "browser";

export function decideHost(v: EngineProbes): JsHost {
  return v.bun ? "bun" : v.denoV8 ? "deno" : v.nodeV8 ? "node" : "browser";
}

const PROBES = gatherEngineProbes();
export const JS_ENGINE: JsEngine = decideEngine(PROBES);
export const JS_HOST: JsHost = decideHost(PROBES);
