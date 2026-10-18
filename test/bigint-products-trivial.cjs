// (preloaded by test/bigint-products.test.ts: the digits of a big integer,
// past 100000 bits, in any base, are refused, so that comb and perm are
// seen to bound their sizes without making n's digits, n may be near the
// largest BigInt: daybreak2's LIMIT-PTREE-1 and LIMIT-AF5-1)
const toString = BigInt.prototype.toString;
const BIG = 1n << 100000n;
BigInt.prototype.toString = function (radix) {
  if (this > BIG || this < -BIG) throw new Error("digits of a big integer read");
  return toString.call(this, radix);
};
