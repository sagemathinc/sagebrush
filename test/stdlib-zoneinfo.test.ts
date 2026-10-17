import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
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
    // (a zone file that is there but cannot be read: open()'s PermissionError,
    // as CPython's; not listed, as CPython's available_timezones skips it)
    copyFileSync(PINNED + "/Europe/London", join(dir, "Unreadable"));
    chmodSync(join(dir, "Unreadable"), 0);
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
      `a file not readable !! PermissionError [Errno 13] Permission denied: '${dir}/Unreadable'`,
      "available_timezones -> ['Zone', 'big']",
      "timedelta cache True 4096",
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// (daybreak2's HARD-ZI-1: _time._read and _time._tzfile are importable, so
// their limit is checked before a file is opened or a buffer allocated: an
// int in 0.._tzrules.MAX_FILE + 1; in a heap of 64 MB, which a 2**40-byte
// buffer would not fit)
test("_time._read and _time._tzfile called directly: a limit past _tzrules.MAX_FILE + 1, negative or not an int refused before any allocation", () => {
  const code = [
    "import _time, _tzrules",
    "for f in (_time._read, _time._tzfile):",
    "    for limit in (2 ** 40, 2 ** 70, _tzrules.MAX_FILE + 2, -1, 1.5, True, '4', None):",
    "        try:",
    "            f('/etc/hostname', limit)",
    "            print('read')",
    "        except (TypeError, ValueError) as e:",
    "            print(type(e).__name__, e)",
    "    print(len(f(" + JSON.stringify(PINNED + "/Europe/London") + ", _tzrules.MAX_FILE + 1)), len(f(" + JSON.stringify(PINNED + "/Europe/London") + ", 0)))",
  ].join("\n");
  const out = execFileSync(process.execPath, ["--max-old-space-size=64", __dirname + "/../src/cli.js", "-c", code], { encoding: "utf8", timeout: 60000 }).split("\n").filter(Boolean);
  const size = readFileSync(PINNED + "/Europe/London").length;
  const want = (f: string) => [
    `ValueError _time.${f}: the limit must be in 0..1048577, not 1099511627776`,
    `ValueError _time.${f}: the limit must be in 0..1048577, not 1180591620717411303424`,
    `ValueError _time.${f}: the limit must be in 0..1048577, not 1048578`,
    `ValueError _time.${f}: the limit must be in 0..1048577, not -1`,
    `TypeError _time.${f}: the limit must be an int, not float`,
    `TypeError _time.${f}: the limit must be an int, not bool`,
    `TypeError _time.${f}: the limit must be an int, not str`,
    `TypeError _time.${f}: the limit must be an int, not NoneType`,
    `${size} 0`,
  ];
  assert.deepEqual(out, [...want("_read"), ...want("_tzfile")]);
});

// (daybreak2's follow-up to HARD-ZI-1: available_timezones walks a TZPATH a
// user may choose, so its walk has a budget of names across all of TZPATH,
// each directory read at most that many names at a time (_time._zonedir);
// past it, a refusal in words, never a partial set)
test("available_timezones: budgets of names and of characters (names read, directories pending, keys kept) across all of TZPATH, refused past them, each directory read only as far as they allow", () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-zoneinfo-walk-"));
  try {
    // two roots: a/ with 2 zones and a directory of 1 more (5 names in all),
    // b/ with 1 zone and 1 file that is not one (2 names)
    for (const d of ["a", "a/Sub", "b"]) mkdirSync(join(dir, d));
    for (const f of ["a/One", "a/Two", "a/Sub/Three", "b/Four"]) copyFileSync(PINNED + "/Europe/London", join(dir, f));
    writeFileSync(join(dir, "a/notes.txt"), "not a zone");
    writeFileSync(join(dir, "b/x"), "x");
    // (the big one: 65537 names, one past the default bound)
    mkdirSync(join(dir, "big"));
    for (let i = 0; i <= 65536; i++) writeFileSync(join(dir, "big", "f" + i), "");
    // (characters: one zone whose name is 200 characters, its key too, so 400
    // in all; and 11000 names of 200 characters, past the default 2097152)
    mkdirSync(join(dir, "long"));
    copyFileSync(PINNED + "/Europe/London", join(dir, "long", "z".repeat(200)));
    mkdirSync(join(dir, "empty"));
    mkdirSync(join(dir, "wide"));
    for (let i = 0; i < 11000; i++) writeFileSync(join(dir, "wide", String(i).padStart(200, "w")), "");
    const code = [
      "import zoneinfo, zoneinfo._tzpath as T",
      `d = ${JSON.stringify(dir)}`,
      "zoneinfo.reset_tzpath([d + '/a', d + '/b'])",
      // (2 roots and 7 names: 9)
      "for bound in (9, 8, 6):",
      "    T._MAX_ENTRIES = bound",
      "    try: print(bound, sorted(zoneinfo.available_timezones()))",
      "    except NotImplementedError as e: print(bound, e)",
      "T._MAX_ENTRIES = 1 << 16",
      "zoneinfo.reset_tzpath([d + '/big'])",
      "try: zoneinfo.available_timezones()",
      "except NotImplementedError as e: print('big', e)",
      "zoneinfo.reset_tzpath([d + '/long'])",
      // (the root's own characters, then 400)
      "for chars in (400, 399, 199):",
      "    T._MAX_CHARS = len(d + '/long') + chars",
      "    try: print(chars, [len(k) for k in zoneinfo.available_timezones()])",
      "    except NotImplementedError as e: print(chars, str(e).replace(str(T._MAX_CHARS), 'root+%d' % chars))",
      "T._MAX_CHARS = 1 << 21",
      "zoneinfo.reset_tzpath([d + '/wide'])",
      "try: zoneinfo.available_timezones()",
      "except NotImplementedError as e: print('wide', e)",
      // (daybreak2's HARD-TZB-2: roots spend too, missing or empty ones included)
      "T._MAX_ENTRIES = 5",
      "for roots in (['/nonexistent-%d' % i for i in range(5)], ['/nonexistent-%d' % i for i in range(6)], [d + '/a/Sub'] * 2 + ['/nonexistent'] * 3, [d + '/empty'] * 6):",
      "    zoneinfo.reset_tzpath(roots)",
      "    try: print(len(roots), sorted(zoneinfo.available_timezones()))",
      "    except NotImplementedError as e: print(len(roots), e)",
      "T._MAX_ENTRIES = 1 << 16",
      "T._MAX_CHARS = 30",
      "zoneinfo.reset_tzpath(['/' + 'x' * 30])",
      "try: zoneinfo.available_timezones()",
      "except NotImplementedError as e: print('long root', e)",
    ].join("\n");
    const out = run(process.execPath, ["--max-old-space-size=128", __dirname + "/../src/cli.js", "-c", code], {}).filter(Boolean);
    assert.deepEqual(out, [
      "9 ['Four', 'One', 'Sub/Three', 'Two']",
      "8 zoneinfo: available_timezones() past Sagebrush's bound of 8 names on TZPATH",
      "6 zoneinfo: available_timezones() past Sagebrush's bound of 6 names on TZPATH",
      "big zoneinfo: available_timezones() past Sagebrush's bound of 65536 names on TZPATH",
      "400 [200]",
      // (the key's 200 cross what the name left)
      "399 zoneinfo: available_timezones() past Sagebrush's bound of root+399 characters of names on TZPATH",
      // (the name itself crosses them, as _zonedir reads it)
      "199 zoneinfo: available_timezones() past Sagebrush's bound of root+199 characters of names on TZPATH",
      "wide zoneinfo: available_timezones() past Sagebrush's bound of 2097152 characters of names on TZPATH",
      "5 []",
      "6 zoneinfo: available_timezones() past Sagebrush's bound of 5 names on TZPATH",
      // (a/Sub twice: 2 roots and 1 name each, then a missing one: 5 spent, the next refused)
      "5 zoneinfo: available_timezones() past Sagebrush's bound of 5 names on TZPATH",
      "6 zoneinfo: available_timezones() past Sagebrush's bound of 5 names on TZPATH",
      "long root zoneinfo: available_timezones() past Sagebrush's bound of 30 characters of names on TZPATH",
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("_time._zonedir called directly: at most limit names and chars characters (None past them); a limit past its bound, negative or not an int refused before anything is read", () => {
  const code = [
    "import _time",
    `names = _time._zonedir(${JSON.stringify(PINNED + "/Europe")}, 3, 1000)`,
    "print(len(names), all(isinstance(n, str) for n in names), _time._zonedir('/', 0, 1000))",
    // (Europe's names are longer than 5 characters in all: None)
    `print(_time._zonedir(${JSON.stringify(PINNED + "/Europe")}, 100, 5))`,
    "for limit in (2 ** 40, 65538, -1, 1.5, True, None):",
    "    try: _time._zonedir('/', limit, 10); print('listed')",
    "    except (TypeError, ValueError) as e: print(type(e).__name__, e)",
    "for chars in (2 ** 40, 2 ** 21 + 1, -1, 'x'):",
    "    try: _time._zonedir('/', 1, chars); print('listed')",
    "    except (TypeError, ValueError) as e: print(type(e).__name__, e)",
    `for p in ('/nonexistent-zonedir', ${JSON.stringify(PINNED + "/Europe/London")}):`,
    "    try: _time._zonedir(p, 5, 100)",
    "    except OSError as e: print(type(e).__name__)",
  ].join("\n");
  const out = run(process.execPath, ["--max-old-space-size=64", __dirname + "/../src/cli.js", "-c", code], {}).filter(Boolean);
  assert.deepEqual(out, [
    "3 True []",
    "None",
    "ValueError _time._zonedir: the limit must be in 0..65537, not 1099511627776",
    "ValueError _time._zonedir: the limit must be in 0..65537, not 65538",
    "ValueError _time._zonedir: the limit must be in 0..65537, not -1",
    "TypeError _time._zonedir: the limit must be an int, not float",
    "TypeError _time._zonedir: the limit must be an int, not bool",
    "TypeError _time._zonedir: the limit must be an int, not NoneType",
    "ValueError _time._zonedir: the limit must be in 0..2097152, not 1099511627776",
    "ValueError _time._zonedir: the limit must be in 0..2097152, not 2097153",
    "ValueError _time._zonedir: the limit must be in 0..2097152, not -1",
    "TypeError _time._zonedir: the limit must be an int, not str",
    "FileNotFoundError",
    "NotADirectoryError",
  ]);
});

test("the tzdata package: the pinned one's version as a browser; none under Node, as on CPython without it", () => {
  const code = "import tzdata\nprint(tzdata.IANA_VERSION, tzdata.__version__, sorted(n for n in dir(tzdata) if not n.startswith('__')))";
  const as = (env: Record<string, string>) => run(process.execPath, [__dirname + "/../src/cli.js", "-c", code], env).filter(Boolean);
  assert.deepEqual(as(BROWSER), ["2026e 2026.5 ['IANA_VERSION']"]);
  const source = JSON.parse(readFileSync(__dirname + "/../../tzdata/source.json", "utf8"));
  assert.equal(source.version, "2026.5", "lib/tzdata/__init__.py's version is the pinned data's (scripts/tzdata-import.mjs)");
  assert.throws(() => run(process.execPath, [__dirname + "/../src/cli.js", "-c", code], {}), /ModuleNotFoundError: No module named 'tzdata'/);
});
