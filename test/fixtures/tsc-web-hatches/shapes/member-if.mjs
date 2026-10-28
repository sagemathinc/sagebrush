// @ts-check
// astra2 T1-LEX: a division after obj.if(1) (tsc accepts it; the policy must refuse the any or fail closed)
/** @type {any} */ const obj = {}; // any: a test object, its fields unknown
const b = 2;
export const q = obj.if(1) / b; /** @type {any} */ export const x = JSON.parse("1");
