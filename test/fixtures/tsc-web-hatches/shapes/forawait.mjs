// @ts-check
// astra2 T1-LEX r5: a REAL regex after a for await (...) head.  tsc accepts it; the policy must refuse the any.
export async function g(/** @type {AsyncIterable<number>} */ it) {
  for await (const v of it) /"/.test(String(v)); /** @type {any} */ const y = JSON.parse("1"); /"/.test("");
  return y;
}
