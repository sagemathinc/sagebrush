// Loading the native engine addon (#7, design N1 r3 S1): never through Node's module resolution, always from the
// exact absolute path the host gives (SAGEBRUSH_ADDON), and only after its bytes match the sha256 the host took
// from the verified manifest (SAGEBRUSH_ADDON_SHA256). Nothing switches the check off: development and CI pass the
// real hash of the addon they just built.
//
// - Linux: the file is opened once (no-follow), checked (a regular file of this user, not group- or
//   world-writable), hashed from that descriptor, and loaded through /proc/self/fd/<n>: the same inode, so a path
//   renamed or replaced after the check can't change what loads.
// - macOS (no /proc/self/fd): the verified bytes are copied into a fresh 0700 directory of this run, re-hashed,
//   made read-only (0500) and loaded from there.
// The remaining window is an in-place write to the file by a process of the same user between the hash and the
// mapping; that user can as well rewrite the bundle, Node or this process, so it is outside this check's threat
// model (stated in the design, as for r3.4's hook).

export type NativeLoad = { ok: true; addon: any } | { ok: false; why: string };

const g = globalThis as any;

/** Load the addon at `path` (absolute) whose sha256 must be `sha256` (64 hex digits), or say why not. */
export function loadNativeAddon(path: string, sha256: string): NativeLoad {
  const p = g.process;
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
    const module = { exports: {} as any };
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
  } catch (e: any) {
    return { ok: false, why: `the native engine could not be loaded (${e?.code ?? e?.message ?? e})` };
  } finally {
    if (fd >= 0) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
}
