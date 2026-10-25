// Build sagebrush-raster-launch (engine/raster-launch: the static,
// syscall-only executable that starts the PNG engine's process under its
// memory limit, PNG plan r8 §2.3) for x86_64 and aarch64 Linux, and write
// engine/py/python/sagebrush/_bin/raster-launch-<arch>, which are committed
// (as wasm/sagebrush-raster.wasm is) so that a wheel's build needs nothing
// more than maturin.  Each is checked here as the tests check the wheel's:
// an EXEC ELF with no interpreter, dynamic section, TLS, relocations or
// writable segment.  Run: node scripts/build-raster-launch.mjs
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const crate = join(root, "engine", "raster-launch");
const target = process.env.CARGO_TARGET_DIR ?? join(crate, "target");
const out = join(root, "engine", "py", "python", "sagebrush", "_bin");
mkdirSync(out, { recursive: true });

// (no libc and no crt: rust-lld links the code alone, at a fixed address,
// starting at _start; no PIE, no RELRO, no build id)
const flags = [
  "-C relocation-model=static",
  "-C target-feature=+crt-static",
  "-C linker=rust-lld",
  "-C linker-flavor=ld.lld",
  "-C link-arg=-static",
  "-C link-arg=--entry=_start",
  "-C link-arg=-znorelro",
  "-C link-arg=--build-id=none",
].join(" ");

for (const arch of ["x86_64", "aarch64"]) {
  const triple = `${arch}-unknown-linux-gnu`;
  execFileSync("cargo", ["build", "--release", "--target", triple], {
    cwd: crate,
    stdio: "inherit",
    env: { ...process.env, CARGO_TARGET_DIR: target, RUSTFLAGS: flags },
  });
  const bin = join(target, triple, "release", "sagebrush-raster-launch");
  check(readFileSync(bin), arch);
  const dest = join(out, `raster-launch-${arch}`);
  copyFileSync(bin, dest);
  chmodSync(dest, 0o755);
  console.log(`raster-launch-${arch}: ${readFileSync(dest).length} bytes, sha256 ${createHash("sha256").update(readFileSync(dest)).digest("hex")}`);
}

// The ELF's program headers: an EXEC with only LOAD (none writable), and
// GNU_STACK, GNU_EH_FRAME and PHDR, nothing the kernel would hand to a
// loader (PT_INTERP, PT_DYNAMIC) or set up (PT_TLS).
function check(b, arch) {
  const ok = (c, what) => {
    if (!c) throw new Error(`raster-launch-${arch}: ${what}`);
  };
  ok(b.readUInt32BE(0) === 0x7f454c46 && b[4] === 2 && b[5] === 1, "not a 64-bit little-endian ELF");
  ok(b.readUInt16LE(16) === 2, "not an EXEC (a PIE or a shared object)");
  ok(b.readUInt16LE(18) === (arch === "x86_64" ? 62 : 183), "the wrong machine");
  const phoff = Number(b.readBigUInt64LE(32)), phentsize = b.readUInt16LE(54), phnum = b.readUInt16LE(56);
  const PT = { 1: "LOAD", 2: "DYNAMIC", 3: "INTERP", 6: "PHDR", 7: "TLS", 0x6474e550: "GNU_EH_FRAME", 0x6474e551: "GNU_STACK", 0x6474e552: "GNU_RELRO" };
  for (let i = 0; i < phnum; i++) {
    const at = phoff + i * phentsize, type = b.readUInt32LE(at), flags = b.readUInt32LE(at + 4);
    const name = PT[type] ?? `0x${type.toString(16)}`;
    ok(["LOAD", "PHDR", "GNU_EH_FRAME", "GNU_STACK"].includes(name), `a ${name} segment`);
    ok(name !== "LOAD" || !(flags & 2), "a writable LOAD segment");
  }
}
