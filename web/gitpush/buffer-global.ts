// isomorphic-git uses Node's Buffer. This worker's own global, set before the library is evaluated (imports run in
// order): the page never gets one, so nothing there that asks `typeof Buffer` is fooled.
import { Buffer } from "buffer";
(globalThis as any).Buffer ??= Buffer;
