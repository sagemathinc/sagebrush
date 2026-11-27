// The native engine's checked loader for the app's engine threads (app/engine/thread.mjs): the same checks, in
// the same order, with the same reasons, as src/runtime/native-load.ts (#7, design N1 r3 S1), which the CLI and the
// kernel use; test/native-load.test.ts runs both on the same rows. Here the thread passes its own `process`, before
// it removes Node's globals, and hands the interpreter only the result: the addon, or why not (never `process`,
// `fs` or a module of Node's).
//
// Not through Node's module resolution: always the exact absolute path the host gives (SAGEBRUSH_ADDON), and only
// after its bytes match the sha256 the host took from the verified manifest (SAGEBRUSH_ADDON_SHA256).

/** Load the addon at `path` (absolute) whose sha256 must be `sha256` (64 hex digits), with Node's `process` `p`:
 * {ok: true, addon} or {ok: false, why}. */
export function loadNativeAddon(path, sha256, p) {
  const fs = p?.getBuiltinModule?.("node:fs"), crypto = p?.getBuiltinModule?.("node:crypto");
  const os = p?.getBuiltinModule?.("node:os"), pathMod = p?.getBuiltinModule?.("node:path");
  if (!fs || !crypto || typeof p?.dlopen !== "function") return { ok: false, why: "native engines need Node" };
  if (typeof path !== "string" || !pathMod.isAbsolute(path)) return { ok: false, why: "the native engine's path is not absolute" };
  if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256)) return { ok: false, why: "the native engine's expected sha256 is missing or malformed" };
  let fd = -1;
  try {
    fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return { ok: false, why: "the native engine is not a regular file" };
    // (this user's, or root's: an app installed by an administrator or MDM is root's; either way no one
    // else can write it, which the mode check below completes)
    if (typeof p.getuid === "function" && st.uid !== p.getuid() && st.uid !== 0) return { ok: false, why: "the native engine is owned by neither this user nor root" };
    if ((st.mode & 0o022) !== 0) return { ok: false, why: "the native engine is writable by others" };
    const bytes = fs.readFileSync(fd);
    if (crypto.createHash("sha256").update(bytes).digest("hex") !== sha256) return { ok: false, why: "the native engine's sha256 does not match the manifest" };
    const module = { exports: {} };
    if (p.platform === "linux") {
      p.dlopen(module, `/proc/self/fd/${fd}`);
    } else {
      const dir = fs.mkdtempSync(pathMod.join(os.tmpdir(), "sagebrush-native-"));
      fs.chmodSync(dir, 0o700);
      const copy = pathMod.join(dir, "sagebrush-engine.node");
      fs.writeFileSync(copy, bytes, { mode: 0o600, flag: "wx" });
      if (crypto.createHash("sha256").update(fs.readFileSync(copy)).digest("hex") !== sha256) {
        return { ok: false, why: "the native engine's private copy does not match the manifest" };
      }
      fs.chmodSync(copy, 0o500);
      p.dlopen(module, copy);
    }
    return { ok: true, addon: module.exports };
  } catch (e) {
    return { ok: false, why: `the native engine could not be loaded (${e?.code ?? e?.message ?? e})` };
  } finally {
    if (fd >= 0) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
}
