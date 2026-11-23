// ci: checks.3 order=60
// The signed Mac app's job (.github/workflows/app.yml, mac-release) runs only
// on this repository, for a push of an app-v* tag or a dispatch that asks to
// sign: never on a pull request, and never for a dispatch without `sign`, on
// a tag too; and only when the page it ships was built (its `needs`), with an
// explicit status function, since GitHub's implicit success() would skip it
// after any skipped job upstream.  Its `if:` is read from the workflow and
// evaluated here over the cases below (GitHub's expression syntax, only the
// parts it uses: anything else in it fails this test, rather than being
// guessed).  The job's steps are checked too: the Rust dependencies are
// fetched and the engine bundled before the credentials are imported; known
// download commands are rejected after the import; CARGO_NET_OFFLINE is required
// on the tauri and cargo steps after it; the app is stapled (until its ticket
// validates) before the disk image is made from it (a stub xcrun); and the
// engine Node's entitlement check is run on true, false and absent entitlements
// (a stub codesign).  And the two hand-run checks: signing-check (the Mac
// secrets) and windows-signing-check (Windows signing, its own environment,
// the OIDC token for its job alone, a throwaway probe signed and kept 1 day).
//
//   node scripts/test-app-release-guard.mjs
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const text = readFileSync(join(root, ".github", "workflows", "app.yml"), "utf8");
const job = /^  mac-release:\n([\s\S]*?)(?=^  [A-Za-z0-9_-]+:\n|(?![\s\S]))/m.exec(text);
let failed = 0, passed = 0;
const ok = (c, what) => (c ? passed++ : (failed++, console.log("FAIL " + what)));
if (!job) {
  console.log("FAIL no mac-release job in .github/workflows/app.yml");
  process.exit(1);
}
const raw = /^    if: (.+)$/m.exec(job[1])?.[1];
// (the ${{ }} form as GitHub reads it: the expression inside)
const cond = raw && /^\$\{\{\s*([\s\S]*?)\s*\}\}$/.exec(raw) ? /^\$\{\{\s*([\s\S]*?)\s*\}\}$/.exec(raw)[1] : raw;
ok(!!cond, "the job has an if: on one line");
ok(/^    environment: sagebrush-signing$/m.test(job[1]), "the job uses the sagebrush-signing environment");

// GitHub's expression syntax, as much as the condition uses: context names, 'strings', ==, !=, &&, ||, !, ( ),
// startsWith(a, b), and the status functions cancelled(), always(), success() and failure().  A job's `if:` with
// no status function is GitHub's `success() && (...)`: true only when every job upstream of it, transitively,
// succeeded (ctx.upstream), so a skipped one skips it too.
const STATUS = /\b(?:success|failure|cancelled|always)\s*\(/;
function jobIf(expr, ctx) {
  return STATUS.test(expr) ? evaluate(expr, ctx) : ctx.upstream.every((r) => r === "success") && evaluate(expr, ctx);
}
function evaluate(expr, ctx) {
  const toks = expr.match(/\s*(?:'(?:[^']|'')*'|[A-Za-z_][A-Za-z0-9_.-]*|==|!=|&&|\|\||[!(),])/gy);
  if (!toks || toks.join("").length !== expr.length) throw new Error("an expression this test doesn't read: " + expr);
  const t = toks.map((s) => s.trim());
  let i = 0;
  const peek = () => t[i], eat = (x) => { if (t[i] !== x) throw new Error(`expected ${x} at ${t[i]}`); i++; };
  const value = (name) => {
    if (name === "true") return true;
    if (name === "false") return false;
    const v = name.split(".").reduce((o, k) => (o == null ? undefined : o[k]), ctx);
    if (v === undefined && !name.startsWith("inputs.")) throw new Error("an unknown context value: " + name);
    return v ?? null;
  };
  const primary = () => {
    const x = t[i++];
    if (x === "(") { const v = or(); eat(")"); return v; }
    if (x === "!") return !primary();
    if (x?.startsWith("'")) return x.slice(1, -1).replace(/''/g, "'");
    if (x === "cancelled" || x === "always" || x === "success" || x === "failure") {
      eat("(");
      eat(")");
      if (x === "cancelled") return !!ctx.cancelled;
      if (x === "always") return true;
      if (x === "success") return !ctx.cancelled && ctx.upstream.every((r) => r === "success");
      return ctx.upstream.some((r) => r === "failure");
    }
    if (x === "startsWith") {
      eat("(");
      const a = or();
      eat(",");
      const b = or();
      eat(")");
      return String(a ?? "").toLowerCase().startsWith(String(b ?? "").toLowerCase());
    }
    if (/^[A-Za-z_]/.test(x ?? "")) return value(x);
    throw new Error("unexpected " + x);
  };
  const cmp = () => {
    let v = primary();
    while (peek() === "==" || peek() === "!=") {
      const op = t[i++], w = primary();
      const eq = typeof v === "string" && typeof w === "string" ? v.toLowerCase() === w.toLowerCase() : v === w;
      v = op === "==" ? eq : !eq;
    }
    return v;
  };
  const and = () => { let v = cmp(); while (peek() === "&&") { i++; const w = cmp(); v = v ? w : v; } return v; };
  const or = () => { let v = and(); while (peek() === "||") { i++; const w = and(); v = v ? v : w; } return v; };
  const v = or();
  if (i !== t.length) throw new Error("left over: " + t.slice(i).join(" "));
  return !!v;
}

const REPO = "sagemathinc/sagebrush";
const cases = [
  // [what, event, ref, inputs, repository, signs]
  ["a push of an app-v tag", "push", "refs/tags/app-v0.4.0", {}, REPO, true],
  ["a dispatch with sign", "workflow_dispatch", "refs/heads/master", { sign: true }, REPO, true],
  ["a dispatch with sign, on an app-v tag", "workflow_dispatch", "refs/tags/app-v0.4.0", { sign: true }, REPO, false],
  ["a hostile dispatch with sign on track/math", "workflow_dispatch", "refs/heads/track/math", { sign: true }, REPO, false],
  ["a dispatch without sign", "workflow_dispatch", "refs/heads/master", { sign: false }, REPO, false],
  ["a dispatch without sign, on an app-v tag", "workflow_dispatch", "refs/tags/app-v0.4.0", { sign: false }, REPO, false],
  ["a dispatch with no inputs", "workflow_dispatch", "refs/heads/master", {}, REPO, false],
  ["a push to master", "push", "refs/heads/master", {}, REPO, false],
  ["a push to track/math", "push", "refs/heads/track/math", {}, REPO, false],
  ["a push of another tag", "push", "refs/tags/v1.0.0", {}, REPO, false],
  ["a push of a branch named like the tag", "push", "refs/heads/app-v1", {}, REPO, false],
  ["a merge group", "merge_group", "refs/heads/gh-readonly-queue/master/pr-1306-dddddddddddddddddddddddddddddddddddddddd", {}, REPO, false],
  ["a merge group cannot request signing", "merge_group", "refs/tags/app-v0.4.0", { sign: true }, REPO, false],
  ["a pull request", "pull_request", "refs/pull/1/merge", {}, REPO, false],
  ["a pull request whose ref looks like the tag", "pull_request", "refs/tags/app-v0.4.0", { sign: true }, REPO, false],
  ["a pull_request_target", "pull_request_target", "refs/tags/app-v0.4.0", { sign: true }, REPO, false],
  ["a schedule", "schedule", "refs/tags/app-v0.4.0", {}, REPO, false],
  ["a fork's push of an app-v tag", "push", "refs/tags/app-v0.4.0", {}, "someone/sagebrush", false],
  ["a fork's dispatch with sign", "workflow_dispatch", "refs/heads/master", { sign: true }, "someone/sagebrush", false],
];
// The jobs upstream of the release on its own events: wasm-changes runs, wasm-modules (pull requests only) is
// skipped, page succeeds.
const UPSTREAM = ["success", "skipped", "success"];
const ctxOf = (event_name, ref, inputs, repository, page = "success", cancelled = false) => ({
  github: { event_name, ref, repository },
  inputs,
  needs: { page: { result: page } },
  cancelled,
  upstream: [UPSTREAM[0], UPSTREAM[1], page],
});
if (cond) {
  ok(STATUS.test(cond) && /\bneeds\.page\.result\s*==\s*'success'/.test(cond), "the condition has a status function and requires needs.page.result == 'success'");
  for (const [what, event_name, ref, inputs, repository, signs] of cases) {
    let got;
    try {
      got = jobIf(cond, ctxOf(event_name, ref, inputs, repository));
    } catch (e) {
      ok(false, `${what}: ${e.message}`);
      continue;
    }
    ok(got === signs, `${what}: ${signs ? "signs" : "never signs"} (the condition says ${got})`);
  }
  // (never after a page that failed, was skipped or was cancelled, nor in a cancelled run)
  const TAG = ["push", "refs/tags/app-v0.4.0", {}, REPO];
  for (const [what, page, cancelled] of [["the page failed", "failure", false], ["the page was skipped", "skipped", false], ["the page was cancelled", "cancelled", false], ["the run was cancelled", "success", true]]) {
    let got;
    try { got = jobIf(cond, ctxOf(...TAG, page, cancelled)); } catch (e) { ok(false, `an app-v tag, ${what}: ${e.message}`); continue; }
    ok(got === false, `an app-v tag, ${what}: never signs (the condition says ${got})`);
  }
  // (the evaluator models the implicit success(): the same condition without its status function is skipped on the
  // job's own events, as GitHub skips it)
  const bare = cond.replace(/^!cancelled\(\)\s*&&\s*/, "");
  ok(bare !== cond && jobIf(bare, ctxOf(...TAG)) === false, "without its status function, the condition would be skipped after the skipped job upstream");
  // (the evaluator itself: it refuses what it doesn't read)
  let refused = false;
  try { evaluate("contains(github.ref, 'x')", { github: {} }); } catch { refused = true; }
  ok(refused, "the evaluator refuses an expression it doesn't read");
}

// The steps, in order: each `- ` item of the job's steps, with its name, its run script and its env.
const steps = [];
for (const m of job[1].split(/^      - /m).slice(1)) {
  const name = /^(?:name: (.+))$/m.exec(m)?.[1] ?? /^uses: (\S+)/m.exec(m)?.[1] ?? /^run: (.+)$/m.exec(m)?.[1] ?? "";
  steps.push({ name: name.trim(), text: m, offline: /^\s+CARGO_NET_OFFLINE: "true"$/m.test(m) });
}
const at = (re) => steps.findIndex((st) => re.test(st.text));
const imported = steps.findIndex((st) => /^Import the Apple credentials$/.test(st.name));
ok(imported > 0, "a step imports the Apple credentials");
const fetchAt = at(/^\s*(?:run: )?cargo fetch --locked\s*$/m), bundleAt = at(/node app\/engine\/bundle\.mjs/);
ok(fetchAt >= 0 && fetchAt < imported, "the app's Rust dependencies are fetched (cargo fetch --locked) before the credentials are imported");
ok(bundleAt >= 0 && bundleAt < imported, "the engine is bundled (its Node downloaded) before the credentials are imported");
// (after the import: none of the known download commands, and every tauri or cargo step offline)
const DOWNLOADS = /\b(?:cargo fetch|cargo install|rustup|npm (?:install|ci|i)\b|npx|pnpm|yarn|bun (?:install|add)|curl|wget|bundle\.mjs|brew)\b|actions\/(?:checkout|download-artifact|setup-|cache)/;
// (tauri or cargo as a command: a build, a test, a bundle; not a path such as app/src-tauri)
const BUILDS = /(?:^|[\s;&|(=])(?:tauri|cargo)\s+[a-z]/m;
for (const st of steps.slice(imported + 1)) {
  ok(!DOWNLOADS.test(st.text), `after the import, "${st.name}" runs no known download command`);
  if (BUILDS.test(st.text.replace(/^\s*#.*$/gm, ""))) ok(st.offline, `after the import, "${st.name}" builds offline (CARGO_NET_OFFLINE: "true")`);
}
// The app's ticket: Tauri builds the app only (its own staple says nothing when it doesn't land); the app is stapled
// until the ticket validates, then the disk image is made from it, then signed, notarized and stapled. The staple
// step's own script is run as GitHub runs it with a stub xcrun and sleep: a ticket at once, one after two misses, none.
{
  const named = (re) => steps.findIndex((st) => re.test(st.name));
  const tauriAt = at(/tauri build --ci --bundles /), stapleAt = named(/^Staple the app$/), dmgAt = named(/^Make the disk image from the stapled app$/), signAt = named(/^Sign, notarize and staple the disk image$/);
  ok(tauriAt >= 0 && /tauri build --ci --bundles app -- --locked/.test(steps[tauriAt].text), "Tauri builds the app only, no disk image of its own");
  ok(stapleAt > tauriAt && dmgAt > stapleAt && signAt > dmgAt, "the app is stapled, then the disk image made from it, then signed, notarized and stapled");
  ok(dmgAt >= 0 && /\bditto "\$app"/.test(steps[dmgAt].text) && /\bhdiutil create\b/.test(steps[dmgAt].text), "the disk image holds the stapled app, copied with ditto");
  const m = stapleAt >= 0 && /^        run: \|\n((?:          .*\n?)+)/m.exec(steps[stapleAt].text);
  ok(!!m, "the staple step is a run: | script");
  if (m) {
    const { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, readFileSync: rd, existsSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { spawnSync } = await import("node:child_process");
    const script = m[1].replace(/^          /gm, "");
    for (const [what, missesBefore, passes, staples, sleeps] of [["a ticket at once", 0, true, 1, 0], ["a ticket after two misses", 2, true, 3, 2], ["no ticket", 99, false, 6, 5]]) {
      const d = mkdtempSync(join(tmpdir(), "staple-"));
      try {
        mkdirSync(join(d, "bin"));
        mkdirSync(join(d, "app/src-tauri/target/release/bundle/macos/Sagebrush.app"), { recursive: true });
        // (xcrun: "stapler staple" counts its calls and fails until the misses are used up; "stapler validate" then succeeds)
        writeFileSync(join(d, "bin", "xcrun"), `#!/bin/sh\nn=$(cat "${d}/staples" 2>/dev/null || echo 0)\nif [ "$2" = staple ]; then n=$((n+1)); echo $n > "${d}/staples"; [ $n -gt ${missesBefore} ] || exit 65; exit 0; fi\n[ $n -gt ${missesBefore} ] || exit 65\n`);
        writeFileSync(join(d, "bin", "sleep"), `#!/bin/sh\necho x >> "${d}/sleeps"\n`);
        chmodSync(join(d, "bin", "xcrun"), 0o755);
        chmodSync(join(d, "bin", "sleep"), 0o755);
        writeFileSync(join(d, "step.sh"), script);
        const r = spawnSync("bash", ["--noprofile", "--norc", "-e", join(d, "step.sh")], { cwd: d, env: { ...process.env, PATH: `${join(d, "bin")}:${process.env.PATH}` }, encoding: "utf8" });
        const count = (f) => (existsSync(join(d, f)) ? rd(join(d, f), "utf8").trim().split("\n").filter(Boolean).length : 0);
        const tries = existsSync(join(d, "staples")) ? Number(rd(join(d, "staples"), "utf8")) : 0;
        ok((r.status === 0) === passes && tries === staples && count("sleeps") === sleeps, `the staple step with ${what}: ${passes ? "passes" : "fails"} after ${staples} staple(s) and ${sleeps} wait(s) (exit ${r.status}, ${tries}, ${count("sleeps")})`);
      } finally {
        rmSync(d, { recursive: true, force: true });
      }
    }
  }
}
// The engine Node's entitlement check, the step's own script run as GitHub runs it (bash -e), with a stub codesign
// that prints the entitlements given: it passes only when both are the boolean true.
const jit = steps.find((st) => /^The engine's Node has the JIT entitlements$/.test(st.name));
ok(!!jit, "a step checks the engine Node's JIT entitlements");
if (jit) {
  const m = /^        run: \|\n((?:          .*\n?)+)/m.exec(jit.text);
  ok(!!m, "the entitlement check is a run: | script");
  if (m) {
    const { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { spawnSync } = await import("node:child_process");
    const script = m[1].replace(/^          /gm, "");
    const plist = (jitV, memV) =>
      `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict>\n` +
      (jitV === null ? "" : `\t<key>com.apple.security.cs.allow-jit</key>\n\t<${jitV}/>\n`) +
      (memV === null ? "" : `\t<key>com.apple.security.cs.allow-unsigned-executable-memory</key>\n\t<${memV}/>\n`) +
      `</dict>\n</plist>\n`;
    for (const [what, jitV, memV, codesignOk, passes] of [
      ["both true", "true", "true", true, true],
      ["allow-jit false", "false", "true", true, false],
      ["allow-jit absent", null, "true", true, false],
      ["unsigned executable memory false", "true", "false", true, false],
      ["unsigned executable memory absent", "true", null, true, false],
      ["codesign fails", "true", "true", false, false],
    ]) {
      const d = mkdtempSync(join(tmpdir(), "jit-"));
      try {
        mkdirSync(join(d, "bin"));
        mkdirSync(join(d, "app/src-tauri/target/release/bundle/macos/Sagebrush.app/Contents/MacOS"), { recursive: true });
        writeFileSync(join(d, "ent.plist"), plist(jitV, memV));
        writeFileSync(join(d, "bin", "codesign"), codesignOk ? `#!/bin/sh\ncat "${join(d, "ent.plist")}"\n` : "#!/bin/sh\nexit 1\n");
        chmodSync(join(d, "bin", "codesign"), 0o755);
        writeFileSync(join(d, "step.sh"), script);
        const r = spawnSync("bash", ["--noprofile", "--norc", "-e", join(d, "step.sh")], {
          cwd: d,
          env: { ...process.env, PATH: `${join(d, "bin")}:${process.env.PATH}`, RUNNER_TEMP: d },
          encoding: "utf8",
        });
        ok((r.status === 0) === passes, `the entitlement check with ${what}: ${passes ? "passes" : "fails"} (exit ${r.status})`);
      } finally {
        rmSync(d, { recursive: true, force: true });
      }
    }
  }
}
// The secrets check (.github/workflows/signing-check.yml): run by hand only, in the same environment, and only from
// master on this repository; its `if:` read and evaluated as above (it has no job upstream).
{
  const sc = readFileSync(join(root, ".github", "workflows", "signing-check.yml"), "utf8");
  const on = /^on:\n([\s\S]*?)(?=^\S)/m.exec(sc)?.[1] ?? "";
  ok(/^  workflow_dispatch:\s*$/m.test(on) && on.split("\n").filter((l) => /^  \S/.test(l)).length === 1, "signing-check runs only by hand (workflow_dispatch alone)");
  const check = /^  check:\n([\s\S]*?)(?=^  [A-Za-z0-9_-]+:\n|(?![\s\S]))/m.exec(sc)?.[1] ?? "";
  ok(/^    environment: sagebrush-signing$/m.test(check), "signing-check uses the sagebrush-signing environment");
  const scIf = /^    if: (.+)$/m.exec(check)?.[1];
  ok(!!scIf, "signing-check's job has an if: on one line");
  if (scIf) {
    for (const [what, ref, repository, runs] of [
      ["a dispatch from master", "refs/heads/master", REPO, true],
      ["a dispatch from a branch", "refs/heads/track/math", REPO, false],
      ["a dispatch from a branch named master-ish", "refs/heads/master2", REPO, false],
      ["a dispatch from a tag", "refs/tags/app-v0.4.0", REPO, false],
      ["a fork's dispatch from master", "refs/heads/master", "someone/sagebrush", false],
    ]) {
      let got;
      try { got = jobIf(scIf, { github: { event_name: "workflow_dispatch", ref, repository }, inputs: {}, needs: {}, cancelled: false, upstream: [] }); } catch (e) { ok(false, `signing-check, ${what}: ${e.message}`); continue; }
      ok(got === runs, `signing-check, ${what}: ${runs ? "runs" : "never runs"} (the condition says ${got})`);
    }
  }
}
// The Windows signing check (.github/workflows/windows-signing-check.yml): run by hand only, asked to sign, from
// master on this repository, in an environment of its own that no other workflow names; the OIDC token granted to
// that job alone; the throwaway executable built before the sign-in, signed only with the Azure CLI sign-in (no cache,
// no environment credential), checked, and kept 1 day; every action pinned to a commit.
{
  const wf = (f) => readFileSync(join(root, ".github", "workflows", f), "utf8");
  const ws = wf("windows-signing-check.yml");
  const on = /^on:\n([\s\S]*?)(?=^\S)/m.exec(ws)?.[1] ?? "";
  ok(/^  workflow_dispatch:\s*$/m.test(on) && on.split("\n").filter((l) => /^  \S/.test(l)).length === 1, "windows-signing-check runs only by hand (workflow_dispatch alone)");
  ok(/^      sign_windows:\n        description: .+\n        type: boolean\n        default: false$/m.test(on), "windows-signing-check's sign_windows input is a boolean, false unless asked");
  const check = /^  check:\n([\s\S]*?)(?=^  [A-Za-z0-9_-]+:\n|(?![\s\S]))/m.exec(ws)?.[1] ?? "";
  ok((ws.match(/^  [A-Za-z0-9_-]+:\n/gm) ?? []).filter((l) => !/^  (workflow_dispatch|contents|check):/.test(l)).length === 0, "windows-signing-check has one job, check");
  ok(/^    environment: sagebrush-signing-windows$/m.test(check), "windows-signing-check uses the sagebrush-signing-windows environment");
  const others = ["app.yml", "signing-check.yml", "ci.yml"].filter((f) => { try { return /sagebrush-signing-windows|AZURE_(TENANT|CLIENT|SUBSCRIPTION)_ID|ARTIFACT_SIGNING_/.test(wf(f)); } catch { return false; } });
  ok(others.length === 0, `no other workflow names the Windows environment or its names (${others.join(", ") || "none"})`);
  ok(/^    environment: sagebrush-signing$/m.test(check) === false, "windows-signing-check never names the Mac environment");
  // (the token: id-token: write once, in the job, never at the workflow's top)
  const top = /^permissions:\n((?:  .+\n)+)/m.exec(ws)?.[1] ?? "";
  ok(/^  contents: read$/m.test(top) && !/id-token/.test(top), "windows-signing-check's workflow permissions are contents: read alone");
  ok((ws.match(/id-token: write/g) ?? []).length === 1 && /^    permissions:\n      contents: read\n      id-token: write$/m.test(check), "id-token: write is granted to the check job alone");
  const wsIf = /^    if: (.+)$/m.exec(check)?.[1];
  ok(!!wsIf, "windows-signing-check's job has an if: on one line");
  if (wsIf) {
    for (const [what, event_name, ref, repository, inputs, runs] of [
      ["a dispatch from master asking to sign", "workflow_dispatch", "refs/heads/master", REPO, { sign_windows: true }, true],
      ["a dispatch from master not asking", "workflow_dispatch", "refs/heads/master", REPO, { sign_windows: false }, false],
      ["a dispatch from master with no input", "workflow_dispatch", "refs/heads/master", REPO, {}, false],
      ["a dispatch from a branch", "workflow_dispatch", "refs/heads/track/math", REPO, { sign_windows: true }, false],
      ["a dispatch from a branch named master-ish", "workflow_dispatch", "refs/heads/master2", REPO, { sign_windows: true }, false],
      ["a dispatch from a tag", "workflow_dispatch", "refs/tags/app-v0.4.0", REPO, { sign_windows: true }, false],
      ["a fork's dispatch from master", "workflow_dispatch", "refs/heads/master", "someone/sagebrush", { sign_windows: true }, false],
      ["a push to master", "push", "refs/heads/master", REPO, { sign_windows: true }, false],
      ["a pull request", "pull_request", "refs/pull/1/merge", REPO, { sign_windows: true }, false],
    ]) {
      let got;
      try { got = jobIf(wsIf, { github: { event_name, ref, repository }, inputs, needs: {}, cancelled: false, upstream: [] }); } catch (e) { ok(false, `windows-signing-check, ${what}: ${e.message}`); continue; }
      ok(Boolean(got) === runs, `windows-signing-check, ${what}: ${runs ? "runs" : "never runs"} (the condition says ${got})`);
    }
  }
  // (the steps, in order)
  const at = (re) => check.search(re);
  const build = at(/name: Build the throwaway executable/), login = at(/uses: azure\/login@/), sign = at(/uses: azure\/artifact-signing-action@/), verify = at(/name: Check the signature and its timestamp/), upload = at(/uses: actions\/upload-artifact@/);
  ok(build >= 0 && login > build && sign > login && verify > sign && upload > verify, "build the probe, then sign in, sign, check, keep (in that order)");
  const uses = check.match(/uses: \S+/g) ?? [];
  ok(uses.length === 3 && uses.every((u) => /^uses: [A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[0-9a-f]{40}$/.test(u)), `every action is pinned to a commit (${uses.join("; ")})`);
  const signStep = check.slice(sign, verify);
  ok(/cache-dependencies: false/.test(signStep) && /exclude-environment-credential: true/.test(signStep) && /exclude-azure-cli-credential: false/.test(signStep), "the sign step uses the Azure CLI sign-in alone, with no cache");
  ok(/timestamp-rfc3161: http:\/\/timestamp\.acs\.microsoft\.com/.test(signStep), "the signature is timestamped (RFC 3161)");
  ok(/files: \$\{\{ runner\.temp \}\}\\probe\\sagebrush-signing-probe\.exe/.test(signStep) && !/files-folder|files-catalog/.test(signStep), "the sign step signs the throwaway probe alone");
  const verifyStep = check.slice(verify, upload);
  ok(/verify \/pa \/all/.test(verifyStep) && /Get-AuthenticodeSignature/.test(verifyStep) && /TimeStamperCertificate/.test(verifyStep), "the check runs signtool verify /pa /all and Get-AuthenticodeSignature, timestamp included");
  const up = check.slice(upload);
  ok(/retention-days: 1$/m.test(up) && !/app\/|bundle|\.msi|setup/i.test(up), "the signed probe alone is kept, 1 day");
  ok(!/gh release|softprops|action-gh-release|releases/.test(ws), "windows-signing-check makes no release");
}
// The signed disk image is kept 1 day as an artifact: in a public repository any signed-in GitHub user can download
// it (design/native-desktop.md §6.3).
{
  const up = /name: sagebrush-app-macos-signed\n[\s\S]*?retention-days: (\d+)/.exec(job[1]);
  ok(up && up[1] === "1", `the signed artifact is kept 1 day (retention-days ${up ? up[1] : "missing"})`);
}
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
