// For test_remote_agent.py's vendored-agent rows only: the reviewed sagebrush-agent tarball run on its fake model with
// no npm install. Its --stdio mode never uses ws (there is no WebSocket server) and its fake model never reads zod's
// tool schemas, so both imports are answered with stand-ins; every other module is the tarball's own.
import { register } from "node:module";

const hooks = `
const STUBS = {
  ws: "export class WebSocketServer { constructor() { throw new Error('ws stand-in: not used with --stdio'); } } export default {};",
  zod: "const any = new Proxy(function () {}, { get: (t, k) => (k === 'then' ? undefined : any), apply: () => any }); export const z = any; export default any;",
};
export async function resolve(spec, ctx, next) {
  if (Object.hasOwn(STUBS, spec)) return { url: "stub:" + spec, shortCircuit: true };
  return next(spec, ctx);
}
export async function load(url, ctx, next) {
  if (url.startsWith("stub:")) return { format: "module", source: STUBS[url.slice(5)], shortCircuit: true };
  return next(url, ctx);
}
`;
register("data:text/javascript," + encodeURIComponent(hooks));
