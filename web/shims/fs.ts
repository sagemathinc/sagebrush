// Files: none in the browser, except output streams, which go to a hook.
const hooks: { write: (fd: number, s: string) => void } = { write: () => {} };
export const __hooks = hooks;
const nope = (what: string) => {
  const e: any = new Error(`${what}: no file system in the browser`);
  e.code = "ENOENT";
  e.errno = -2;
  throw e;
};
export function writeSync(fd: number, data: any) {
  hooks.write(fd, typeof data === "string" ? data : new TextDecoder().decode(data));
}
export function readSync() {
  return 0;
}
export const existsSync = () => false;
export const readFileSync = (p: string) => nope(`open '${p}'`);
export const writeFileSync = (p: string) => nope(`open '${p}'`);
export const appendFileSync = (p: string) => nope(`open '${p}'`);
export const mkdirSync = (p: string) => nope(`mkdir '${p}'`);
export const readdirSync = (p: string) => nope(`scandir '${p}'`);
export const statSync = (p: string) => nope(`stat '${p}'`);
export const unlinkSync = (p: string) => nope(`unlink '${p}'`);
export const rmdirSync = (p: string) => nope(`rmdir '${p}'`);
export const renameSync = (p: string) => nope(`rename '${p}'`);
export default { writeSync, readSync, existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, readdirSync, statSync, unlinkSync, rmdirSync, renameSync };
