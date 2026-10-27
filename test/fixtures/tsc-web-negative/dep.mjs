// A planted type error in a file only IMPORTED by the root, with no @ts-check of its own: it must fail too.
/** @returns {number} */
export function count() { return "planted_dep"; }
