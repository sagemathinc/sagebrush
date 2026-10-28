// @ts-check
// A planted type error in an opted-in root (the negative control: it must fail).
import { count } from "./dep.mjs";
/** @type {number} */
export const planted_root = "not a number";
export const n = count();
