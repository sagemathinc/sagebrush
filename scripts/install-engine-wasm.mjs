// Install a freshly built engine module at its committed path, bytes only.
// fs.copyFileSync also copies the source's mode, and cargo writes .wasm
// outputs 0755, so a copy left wasm/sagebrush-engine.wasm executable: git saw
// a mode change and CI's "differs from a fresh build" warning fired even when
// the bytes were identical.  The committed file is 0644.
import { chmodSync, readFileSync, writeFileSync } from "node:fs";

export function installWasm(src, dst) {
  const bytes = readFileSync(src);
  writeFileSync(dst, bytes);
  chmodSync(dst, 0o644); // (writeFileSync keeps an existing file's mode)
  return bytes.length;
}
