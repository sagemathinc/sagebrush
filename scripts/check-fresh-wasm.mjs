// The pins against a fresh build of engine/ (the engine-wasm job, after scripts/build-engine.mjs wrote the five
// modules into wasm/): a module whose bytes don't match its pin in wasm/pins.json, or whose mode isn't 0644.
// When the pins record this tree's own source (wasm-modules.mjs's pinsState: "current"), that is an error on every
// event: the pins must be this source's build, so the build isn't reproducible, or the pins were edited by hand.
// When they record another source ("pending": a pull request or queue group that changes the engine, or master before
// its pin commit, design/wasm-artifacts.md section 13), the mismatch is expected and only reported: a pull request
// never carries a pin, and master's CI commits it after the merge (scripts/wasm-pin-commit.mjs).  Except on a tag: a
// release ships only a commit whose pins are its own source's build.
//   node scripts/check-fresh-wasm.mjs        (in the engine-wasm job)
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { MODULES, parsePins, pinsState, sha256 } from "./wasm-modules.mjs";
import { isTagRun } from "./wasm-artifact.mjs";

// (`state` stands in for pinsState(cwd): a test's fixture without git)
export function checkFreshWasm({ cwd = process.cwd(), state, env = process.env } = {}) {
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
  if ((state ?? pinsState(cwd)) === "current") {
    return { status: 1, message: `::error::wasm/pins.json records this tree's own source, but differs from a fresh build of it: the build isn't reproducible here, or the pins were edited by hand\n${stale.join("\n")}` };
  }
  if (isTagRun(env)) {
    return { status: 1, message: `::error::a release builds only from a commit whose pins are its own source's build, and this commit's pin is pending: tag the commit after master's pin commit\n${stale.join("\n")}` };
  }
  return { status: 0, message: `::notice::this source's pin is pending (wasm/pins.json records another source's build): master's CI commits it after the merge, never a pull request\n${stale.join("\n")}` };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = checkFreshWasm();
  console.log(r.message);
  process.exit(r.status);
}
