export const randomBytes = (n: number) => crypto.getRandomValues(new Uint8Array(n));
// src/compile.ts only hashes for its on-disk cache, which browsers don't have.
export function createHash(_alg: string): never {
  throw new Error("createHash is not available in a browser");
}
export default { randomBytes, createHash };
