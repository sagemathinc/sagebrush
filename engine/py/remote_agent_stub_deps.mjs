// For test_remote_agent.py's vendored-agent rows only: the reviewed sagebrush-agent tarball run on its fake model with
// no npm install. Its two npm imports are answered with stand-ins that fail loudly if they are actually used:
//   - ws: --stdio starts no WebSocket server; constructing one, or reading the module's default, throws.
//   - zod: the agent builds its tool schemas when a turn starts (z.string().describe(...), ...), and those building
//     calls chain on a stand-in; the fake model never reads a schema, so anything that would validate or look inside
//     one (parse, safeParse, shape, _def, a conversion to text or JSON) throws.
// Every other module is the tarball's own. So the vendored rows passing shows the clamp and the pipe are the agent's
// own code, with neither stand-in doing anything.
import { registerHooks } from "node:module";

const STUBS = {
  ws: `export class WebSocketServer { constructor() { throw new Error("ws stand-in: used"); } }
export default new Proxy({}, { get() { throw new Error("ws stand-in: used"); } });`,
  zod: `const USE = new Set(["parse", "safeParse", "parseAsync", "safeParseAsync", "spa", "shape", "_def", "_parse", "toJSON", "valueOf", "toString"]);
const any = new Proxy(function () {}, {
  get(t, k) {
    if (k === "then") return undefined;
    if (k === Symbol.toPrimitive || USE.has(k)) throw new Error("zod stand-in: used (" + String(k) + ")");
    return any;
  },
  apply() { return any; },
});
export const z = any;
export default any;`,
};

registerHooks({
  resolve(spec, ctx, next) {
    if (Object.hasOwn(STUBS, spec)) return { url: "stub:" + spec, shortCircuit: true };
    return next(spec, ctx);
  },
  load(url, ctx, next) {
    if (url.startsWith("stub:")) return { format: "module", source: STUBS[url.slice(5)], shortCircuit: true };
    return next(url, ctx);
  },
});
