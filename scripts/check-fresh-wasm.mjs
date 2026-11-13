// The pins against a fresh build of engine/ (the engine-wasm job, after scripts/build-engine.mjs wrote the four
// modules into wasm/): a module whose bytes don't match its pin in wasm/pins.json, or whose mode isn't 0644,
// means the pin is stale.  On a master push, a dispatch (a train's gate, before it lands) or the schedule that is an
// error: master must never carry a pin that isn't its own source's build.  On a pull request it is a warning: the
// pull request's own run prints the pins.json lines to commit (the wasm-modules job), so a mismatch mid-review is
// expected; the train's dispatch catches it before landing.
//   node scripts/check-fresh-wasm.mjs        (in the engine-wasm job; GITHUB_EVENT_NAME decides)
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { MODULES, parsePins, sha256 } from "./wasm-modules.mjs";

export function checkFreshWasm({ cwd = process.cwd(), event = process.env.GITHUB_EVENT_NAME ?? "local" } = {}) {
  let pins;
  try {
    pins = parsePins(readFileSync(join(cwd, "wasm", "pins.json"), "utf8"));
  } catch (e) {
    return { status: 2, message: `::error::wasm/pins.json: ${e.message}` };
  }
  const stale = [];
  for (const name of MODULES) {
    const path = join(cwd, "wasm", name);
    let bytes, mode;
    try {
      bytes = readFileSync(path);
      mode = statSync(path).mode & 0o777;
    } catch (e) {
      return { status: 2, message: `::error::wasm/${name}: ${e.message} (run node scripts/build-engine.mjs first)` };
    }
    const pin = pins[name], h = sha256(bytes);
    if (h !== pin.sha256 || bytes.length !== pin.bytes) stale.push(`${name}: the fresh build is ${bytes.length} bytes, sha256 ${h}; pinned ${pin.bytes} bytes, sha256 ${pin.sha256}`);
    else if (mode !== 0o644) stale.push(`${name}: mode ${mode.toString(8)}, not 644`);
  }
  if (!stale.length) return { status: 0, message: "wasm/: every pin equals a fresh build" };
  const what = "wasm/pins.json differs from a fresh build of engine/ (commit the pins.json lines this run's wasm-modules job printed, or node scripts/wasm-pins.mjs --from-local after the same build)";
  const strict = event === "push" || event === "workflow_dispatch" || event === "schedule";
  return strict ? { status: 1, message: `::error::${what}\n${stale.join("\n")}` } : { status: 0, message: `::warning::${what}\n${stale.join("\n")}` };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = checkFreshWasm();
  console.log(r.message);
  process.exit(r.status);
}
