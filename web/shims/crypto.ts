export const randomBytes = (n: number) => crypto.getRandomValues(new Uint8Array(n));
export default { randomBytes };
