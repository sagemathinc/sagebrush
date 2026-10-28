// @ts-check
// astra2 T1-LEX: a division after a non-ASCII identifier (tsc accepts it; the policy must refuse the any or fail closed)
const café = 4, b = 2;
export const q = café / b; /** @type {any} */ export const x = JSON.parse("1");
