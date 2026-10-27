// @ts-check
// astra2 T1-LEX r5: a REAL regex after ASI (debugger, then a newline) that a lexer could read as a division; its quote
// would open a fake string swallowing the real JSDoc.  tsc accepts it; the policy must refuse the any.
export function f() {
  debugger
  /"/; /** @type {any} */ const x = JSON.parse("1"); /"/;
  return x;
}
