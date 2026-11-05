import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// bench/wasm-blas/driver.mjs must leave no Chrome and no profile dir behind, however it ends: the error path, the
// signals it handles, and the kills it never sees (SIGKILL of the driver, or of the driver's whole process group:
// Nov 4, a Chrome tree outlived its killed driver on VM1). A stand-in Chrome records its own pid, a child's (the
// "renderer") and that of a crash-handler stand-in that, like chrome_crashpad_handler, daemonizes into a session
// of its own with the profile dir in its arguments; then it waits. With FAKE_PORT=1 it announces a DevTools port
// that refuses connections, so the driver takes its error path at once.
const ROOT = join(__dirname, "..", "..");
const DRIVER = join(ROOT, "bench/wasm-blas/driver.mjs");
const FAKE = `#!/bin/sh
for a in "$@"; do case "$a" in --user-data-dir=*) U="\${a#--user-data-dir=}";; esac; done
sleep 1000 &
echo $! > "$FAKE_DIR/renderer.pid"
setsid sh -c 'while :; do sleep 0.2; done' crashpad "--database=$U/Crash Reports" < /dev/null > /dev/null 2>&1 &
echo $! > "$FAKE_DIR/crashpad.pid"
printf '%s' "$U" > "$FAKE_DIR/profile.path"
echo $$ > "$FAKE_DIR/chrome.pid"
[ "$FAKE_PORT" = 1 ] && printf '1\\n/devtools/browser/x\\n' > "$U/DevToolsActivePort"
wait
`;
const supported = process.platform === "linux" && spawnSync("pgrep", ["-V"]).status === 0;

// (a zombie awaiting its reaper counts as gone)
function alive(pid: number): boolean {
  try {
    return !/^\d+ \(.*\) Z /.test(readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return false;
  }
}

async function until(ok: () => boolean, ms = 8000): Promise<boolean> {
  const t0 = Date.now();
  while (!ok()) {
    if (Date.now() - t0 > ms) return false;
    await new Promise((r) => setTimeout(r, 50));
  }
  return true;
}

type Ending = "error" | "SIGINT" | "SIGTERM" | "SIGHUP" | "SIGKILL" | "group SIGKILL";

// (the profile dir is read from the stand-in's own --user-data-dir argument, not predicted from TMPDIR: a node
// binary running in secure-exec mode, such as one with file capabilities, never sees TMPDIR)
async function run(ending: Ending, extraEnv: Record<string, string> = {}): Promise<{ exit: number | string | null; out: string }> {
  const dir = mkdtempSync(join(tmpdir(), "wasm-blas-driver-"));
  try {
    writeFileSync(join(dir, "chrome"), FAKE);
    chmodSync(join(dir, "chrome"), 0o755);
    const env = { ...process.env, SBWR_CHROME: join(dir, "chrome"), FAKE_DIR: dir, FAKE_PORT: ending === "error" ? "1" : "0", ...extraEnv };
    const d = spawn(process.execPath, [DRIVER, "http://127.0.0.1:1/x.html", join(dir, "out.json"), "30"],
      { env, stdio: "ignore", detached: ending === "group SIGKILL" });
    const exited = new Promise<number | string | null>((r) => d.on("exit", (code, sig) => r(code ?? sig)));
    assert.ok(await until(() => existsSync(join(dir, "chrome.pid"))), `${ending}: the stand-in Chrome started`);
    const pids = ["chrome.pid", "renderer.pid", "crashpad.pid"].map((f) => Number(readFileSync(join(dir, f), "utf8")));
    const profile = readFileSync(join(dir, "profile.path"), "utf8");
    assert.match(profile, /\/sbwr-udd-[^/]+$/, `${ending}: the stand-in got the driver's profile dir`);
    assert.ok(existsSync(profile) || ending === "error", `${ending}: the profile dir exists while Chrome runs`);
    if (ending === "group SIGKILL") process.kill(-d.pid!, "SIGKILL");
    else if (ending !== "error") d.kill(ending);
    const exit = await exited;
    assert.ok(await until(() => pids.every((p) => !alive(p))), `${ending}: Chrome, its child and its crash handler are gone (${pids})`);
    assert.ok(await until(() => !existsSync(profile)), `${ending}: the profile dir ${profile} is removed`);
    return { exit, out: existsSync(join(dir, "out.json")) ? readFileSync(join(dir, "out.json"), "utf8") : "" };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("wasm-blas driver: the error path leaves no Chrome and no profile", { skip: !supported }, async () => {
  const r = await run("error");
  assert.equal(r.exit, 0);
  assert.match(JSON.parse(r.out).result.error, /fetch failed|ECONNREFUSED/);
});

for (const [sig, code] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]] as const) {
  test(`wasm-blas driver: ${sig} leaves no Chrome and no profile`, { skip: !supported }, async () => {
    assert.equal((await run(sig)).exit, code);
  });
}

// (the driver held just after it spawns Chrome: the signal lands where the handlers, if they came after the spawn,
// would not be in place yet, and the default action would kill the driver unhandled, exit "SIGTERM"; Nov 5,
// master CI, once by timing alone. With the handlers before the spawn it is handled: cleanup, then 128+15)
test("wasm-blas driver: SIGTERM right after the spawn is handled (the handlers precede the spawn)", { skip: !supported }, async () => {
  assert.equal((await run("SIGTERM", { SBWR_TEST_HOLD_MS: "1500" })).exit, 143);
});

test("wasm-blas driver: SIGKILL of the driver (no handler runs) leaves no Chrome and no profile", { skip: !supported }, async () => {
  assert.equal((await run("SIGKILL")).exit, "SIGKILL");
});

test("wasm-blas driver: SIGKILL of the driver's process group leaves no Chrome and no profile", { skip: !supported }, async () => {
  assert.equal((await run("group SIGKILL")).exit, "SIGKILL");
});

// The watchdog has no matcher of its own: it runs the driver's --kill-naming mode, so the watchdog and the driver
// share one matcher, which splits /proc/PID/cmdline at NUL argument boundaries only. (#645 DRIVER645-ARGV-1: a
// shell matcher that turned NULs into newlines took a newline inside one unrelated argument for a boundary.)
test("wasm-blas driver: the watchdog uses the driver's own matcher (no /proc parsing in the shell)", () => {
  const src = readFileSync(DRIVER, "utf8");
  const dog = src.slice(src.indexOf("const WATCHDOG = ["), src.indexOf('].join("\\n");'));
  assert.ok(dog.length > 0 && dog.includes("--kill-naming"), "the watchdog calls --kill-naming");
  assert.ok(!dog.includes("/proc") && !dog.includes("cmdline"), "the watchdog reads no cmdline itself");
});

// One case list for both checks of the one matcher: the pure classifier (--classify, no signals) and the kill
// scan the watchdog and the driver run (--kill-naming, on real processes). Each case is the arguments of a
// process; "names" means some argument names the profile dir. (#645 DRIVER645-PATH-2: a path that leaves the dir
// through ".." is not inside it.)
function matcherCases(udd: string): [string, string[], boolean][] {
  return [
    ["exact", [udd], true],
    ["inside", [`${udd}/Crash Reports`], true],
    ["flag, exact", [`--user-data-dir=${udd}`], true],
    ["flag, inside", [`--database=${udd}/Crash Reports`], true],
    ["second argument", ["--x", `${udd}/a`], true],
    ["dot inside", [`--database=${udd}/./Crash Reports`], true],
    ["dotdot back into it", [`${udd}/x/../Crash Reports`], true],
    ["sibling <dir>-x", [`${udd}-x`], false],
    ["sibling <dir>x", [`${udd}x`], false],
    ["sibling inside", [`${udd}x/Crash Reports`], false],
    ["sibling flag", [`--database=${udd}-other`], false],
    ["newline inside one argument", [`--description=looking at a profile\n${udd}/Crash Reports`], false],
    ["newline, then exactly the dir", [`note\n${udd}`], false],
    ["dotdot out of it", [`${udd}/../x`], false],
    ["flag, dotdot out of it", [`--database=${udd}/../x`], false],
    ["flag, dotdot to another run", [`--database=${udd}/../not-this-run/Crash Reports`], false],
    ["dotdot to its parent", [`${udd}/..`], false],
  ];
}

test("wasm-blas driver: --classify (pure, no signals) on the shared cases", () => {
  const udd = join(tmpdir(), "sbwr-udd-classify");
  for (const [name, args, names] of matcherCases(udd)) {
    const cmdline = ["/usr/bin/some-viewer", ...args].join("\0") + "\0";
    const r = spawnSync(process.execPath, [DRIVER, "--classify", udd], { input: cmdline, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), names ? "names" : "spares", name);
  }
  // (anything but a driver-made profile dir is refused before anything is read)
  for (const bad of ["/", "/tmp", "relative/sbwr-udd-x", ""]) {
    assert.equal(spawnSync(process.execPath, [DRIVER, "--classify", bad], { input: "" }).status, 2, `classify ${JSON.stringify(bad)}`);
    assert.equal(spawnSync(process.execPath, [DRIVER, "--kill-naming", bad]).status, 2, `kill-naming ${JSON.stringify(bad)}`);
  }
});

test("wasm-blas driver: --kill-naming kills exactly the processes of the shared cases that name the profile", { skip: !supported }, async () => {
  const udd = mkdtempSync(join(tmpdir(), "sbwr-udd-"));
  const cases = matcherCases(udd);
  cases.push(["skipped pid", [udd], false]);
  // (after "--", so node passes a --flag=... argument through instead of parsing it as its own option)
  const kids = cases.map(([, args]) => spawn(process.execPath, ["-e", "setInterval(() => {}, 1e6)", "--", ...args], { stdio: "ignore" }));
  try {
    assert.ok(await until(() => kids.every((k) => alive(k.pid!))), "the victims started");
    const skip = kids[cases.length - 1].pid!;
    const r = spawnSync(process.execPath, [DRIVER, "--kill-naming", udd, String(skip)], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    await new Promise((ok) => setTimeout(ok, 300));
    for (const [i, [name, , killed]] of cases.entries()) assert.equal(!alive(kids[i].pid!), killed, `${name}: ${killed ? "killed" : "spared"}`);
  } finally {
    for (const k of kids) k.kill("SIGKILL");
    rmSync(udd, { recursive: true, force: true });
  }
});
