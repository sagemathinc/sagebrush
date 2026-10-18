// (preloaded by test/bigint-products.test.ts: the hex digits of a big
// integer, past 100000 bits, are refused, so that comb and perm with k of
// 0 or 1 are seen to return before any size bound reads n's digits,
// daybreak2's LIMIT-PTREE-1)
const toString = BigInt.prototype.toString;
const BIG = 1n << 100000n;
BigInt.prototype.toString = function (radix) {
  if (radix === 16 && (this > BIG || this < -BIG)) throw new Error("hex digits of a big integer read");
  return toString.call(this, radix);
};
