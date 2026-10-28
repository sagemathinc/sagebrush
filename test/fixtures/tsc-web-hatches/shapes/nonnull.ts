// astra2 T1-LEX: a division after a TypeScript non-null assertion (tsc accepts it; the policy must refuse the any or fail closed)
const a: number | undefined = 4; const b = 2;
export const q = a! / b; /** @type {any} */ export const x = JSON.parse("1");
