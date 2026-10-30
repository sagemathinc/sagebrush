// Whether this build runs exact merges (plan-merge-align r3.2, P2b).  Every production build defines
// __SB_EXACT_MERGE__ as false (web/build.ts), so the constant is the literal false there and nothing at run time can
// change it; only a test's own build defines it true.  While it is false the client's hello says no `merge` (legacy
// only: no document is made exact for it, and none it can't read reaches it) and its claims ask for none.  It turns on
// with the activation PR, after the store and editor merge for exact documents (P2c), with the workspace barrier.
declare const __SB_EXACT_MERGE__: boolean | undefined;
export const EXACT_MERGE_CLIENT: boolean = typeof __SB_EXACT_MERGE__ !== "undefined" && __SB_EXACT_MERGE__ === true;
/** hello's `merge` for this build, or none. */
export const helloMergeField = (): { merge?: string[] } => (EXACT_MERGE_CLIENT ? { merge: ["legacy", "exact-v1"] } : {});
