// In place of three packages in Push to GitHub's worker (web/build.ts), so neither they nor their license texts ship:
//   diff3: used only by git.merge, which Push to GitHub never calls;
//   clean-git-ref: used only to suggest a name for an invalid ref (rules.ts BRANCH admits only valid ones);
//   isomorphic-textencoder (with fast-text-encoding): a TextEncoder polyfill for lightning-fs; the browser has one.
export default function diff3Merge(): never {
  throw new Error("merge isn't part of Push to GitHub");
}
export const clean = (ref: string) => ref;
const te = new TextEncoder(), td = new TextDecoder();
export const encode = (s: string) => te.encode(s);
export const decode = (b: Uint8Array) => td.decode(b);
