// @ts-check
// astra2 T1-LEX: a division after a member access across a comment (tsc accepts it; the policy must refuse the any or fail closed)
/** @type {any} */ const obj = {}; // any: a test object, its fields unknown
const b = 2;
export const q = obj. /* gap */ return / b; /** @type {any} */ export const x = JSON.parse("1");
