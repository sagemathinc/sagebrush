// @ts-check
// astra2 T1-LEX: a division after a postfix ++ (tsc accepts it; the policy must refuse the any or fail closed)
let a = 1; const b = 2;
export const q = a++ / b; /** @type {any} */ export const x = JSON.parse("1");
