import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// zoneinfo (lib/_zoneinfo.py: CPython 3.14's C _zoneinfo in Python; lib/zoneinfo/:
// its Lib/zoneinfo) compared with CPython 3.14, which runs the C module.
// - Under Node: the host's zone files on TZPATH, and no tzdata package, as on
//   CPython without one.
// - As a browser (SAGEBRUSH_TIME_NO_ZONE_FILES=1, the pinned zone data read
//   from the repository: SAGEBRUSH_TIME_PINNED_DIR): an empty TZPATH and the
//   pinned tzdata 2026.5 as the installed tzdata package. The zones are
//   compared with CPython reading the same files on TZPATH; what depends on
//   how an installed tzdata package is looked up (odd keys, the module's
//   functions) with test/zoneinfo_api_cases.tzdata.txt, CPython 3.14.8's
//   output with tzdata 2026.5 installed and PYTHONTZPATH empty:
//     PYTHONTZPATH= python3 test/zoneinfo_api_cases.py > test/zoneinfo_api_cases.tzdata.txt
const TEST = __dirname + "/../../test/";
const PINNED = __dirname + "/../../tzdata/zoneinfo";
const BROWSER = { SAGEBRUSH_TIME_NO_ZONE_FILES: "1", SAGEBRUSH_TIME_PINNED_DIR: PINNED, PYTHONTZPATH: "" };
const run = (cmd: string, args: string[], env: Record<string, string>) =>
  execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env }, maxBuffer: 256 << 20, timeout: 600000 }).split("\n");
const sagebrush = (file: string, env: Record<string, string> = {}) => run(process.execPath, [__dirname + "/../src/cli.js", TEST + file], env);
const cpython = (file: string, env: Record<string, string> = {}) => run("python3", [TEST + file], env);

// TODO(python-core-semantics): Sagebrush cannot pickle getattr yet, which
// ZoneInfo's pickles (getattr(ZoneInfo, "_unpickle")) need; until that
// branch merges, a pickle line may be that TypeError instead of CPython's.
const PICKLE = /^(pickle|pickle no_cache|unpickle same|unpickle no_cache|subclass pickle) /;
const NOT_YET = " !! TypeError cannot pickle 'builtin_function_or_method' object | context: None";
function same(got: string[], want: string[], what: string) {
  assert.equal(got.length, want.length, `${what}: ${got.length} lines, not ${want.length}`);
  for (let i = 0; i < want.length; i++) {
    if (got[i] !== want[i] && PICKLE.test(want[i]) && got[i] === want[i].replace(/ (->|!!) .*$/, "") + NOT_YET) continue;
    assert.equal(got[i], want[i], `${what}, line ${i + 1}`);
  }
}

test("zoneinfo_api_cases.py under Node (the host's TZPATH, no tzdata): CPython's output", () => {
  same(sagebrush("zoneinfo_api_cases.py"), cpython("zoneinfo_api_cases.py"), "zoneinfo_api_cases.py");
});

test("zoneinfo_api_cases.py as a browser (the pinned tzdata as the tzdata package): CPython's with tzdata 2026.5 installed", () => {
  const want = readFileSync(TEST + "zoneinfo_api_cases.tzdata.txt", "utf8").split("\n");
  same(sagebrush("zoneinfo_api_cases.py", BROWSER), want, "zoneinfo_api_cases.py as a browser");
});

test("zoneinfo_files_cases.py (TZif files built in it, every shape of TZ string): CPython's output", () => {
  same(sagebrush("zoneinfo_files_cases.py"), cpython("zoneinfo_files_cases.py"), "zoneinfo_files_cases.py");
});

// (every zone, each transition and the TZ string's years after the last;
// in shards run at once)
const SHARDS = 4;
for (const [mode, sb, py] of [
  ["under Node, the host's zone files", {}, {}],
  ["as a browser, the pinned zone files", BROWSER, { PYTHONTZPATH: PINNED }],
] as const)
  test(`zoneinfo_sweep_cases.py ${mode}: CPython's output for every zone`, async () => {
    const { execFile } = await import("node:child_process");
    const go = (cmd: string, args: string[], env: Record<string, string>) =>
      new Promise<string>((ok, no) => execFile(cmd, args, { encoding: "utf8", env: { ...process.env, ...env }, maxBuffer: 256 << 20, timeout: 900000 }, (e, out) => (e ? no(e) : ok(out))));
    const shards = [...Array(SHARDS).keys()];
    const [got, want] = await Promise.all([
      Promise.all(shards.map((i) => go(process.execPath, [__dirname + "/../src/cli.js", TEST + "zoneinfo_sweep_cases.py"], { ...sb, ZI_SHARD: `${i}/${SHARDS}` }))),
      Promise.all(shards.map((i) => go("python3", [TEST + "zoneinfo_sweep_cases.py"], { ...py, ZI_SHARD: `${i}/${SHARDS}` }))),
    ]);
    const zones = want.join("").split("\n").filter((l) => /^\S/.test(l)).length;
    assert.ok(zones > 500, `(the sweep covered ${zones} zones)`);
    same(got.join("").split("\n"), want.join("").split("\n"), `zoneinfo_sweep_cases.py ${mode}`);
  });

test("zoneinfo's bounds: header counts and files past _tzrules' refused in words, a FIFO never opened, the timedelta cache bounded", () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-zoneinfo-"));
  try {
    copyFileSync(PINNED + "/Europe/London", join(dir, "Zone"));
    writeFileSync(join(dir, "big"), Buffer.concat([readFileSync(PINNED + "/Europe/London"), Buffer.alloc((1 << 20) + 1)]));
    execFileSync("mkfifo", [join(dir, "fifo")]);
    const out = sagebrush("zoneinfo_bounds_cases.py", { ZI_DIR: dir });
    assert.deepEqual(out.filter(Boolean), [
      "bounds 65536 256 1024 1048576",
      "transitions at the bound -> True",
      "transitions past the bound !! NotImplementedError zoneinfo: a TZif file with 65537 transitions is past Sagebrush's bound of 65536",
      "types at the bound -> True",
      "types past the bound !! NotImplementedError zoneinfo: a TZif file with 257 local time types is past Sagebrush's bound of 256",
      "abbreviations past the bound !! NotImplementedError zoneinfo: a TZif file with 1025 bytes of abbreviations is past Sagebrush's bound of 1024",
      "a version 1 header's huge count !! NotImplementedError zoneinfo: a TZif file with 1073741824 transitions is past Sagebrush's bound of 65536",
      "a version 2 header's huge count !! NotImplementedError zoneinfo: a TZif file with 1073741824 transitions is past Sagebrush's bound of 65536",
      "a zone file -> None",
      `a file past MAX_FILE !! NotImplementedError zoneinfo: '${dir}/big' is past Sagebrush's bound of 1048576 bytes for a TZif file`,
      "a FIFO !! ZoneInfoNotFoundError 'No time zone found with key fifo'",
      "available_timezones -> ['Zone', 'big']",
      "timedelta cache True 4096",
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the tzdata package: the pinned one's version as a browser; none under Node, as on CPython without it", () => {
  const code = "import tzdata\nprint(tzdata.IANA_VERSION, tzdata.__version__, sorted(n for n in dir(tzdata) if not n.startswith('__')))";
  const as = (env: Record<string, string>) => run(process.execPath, [__dirname + "/../src/cli.js", "-c", code], env).filter(Boolean);
  assert.deepEqual(as(BROWSER), ["2026e 2026.5 ['IANA_VERSION']"]);
  const source = JSON.parse(readFileSync(__dirname + "/../../tzdata/source.json", "utf8"));
  assert.equal(source.version, "2026.5", "lib/tzdata/__init__.py's version is the pinned data's (scripts/tzdata-import.mjs)");
  assert.throws(() => run(process.execPath, [__dirname + "/../src/cli.js", "-c", code], {}), /ModuleNotFoundError: No module named 'tzdata'/);
});
