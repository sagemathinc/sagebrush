// ci: checks.3 order=60
// The iOS app's TestFlight workflow (.github/workflows/app-ios-testflight.yml) runs only by hand, on master, in this
// repository; and its signing secrets never share a machine with the project's code.  Steps of one job are not isolated
// from each other ($GITHUB_ENV, $GITHUB_PATH, processes left running), jobs are: the archive job builds an unsigned
// archive with no environment and no secret, and uploads it; the sign job, in the sagebrush-signing environment on a
// GitHub-hosted runner (a fresh VM), needs it and downloads it by name, and has no checkout, no local action and no
// build.  Its secrets are in two steps only, each given by its own step's env: the signing step, whose commands are
// the keychain's and the profile's, `node -e` (writing the files), and `xcodebuild -exportArchive` alone; and the
// upload step (altool, after the signing).  The certificate is imported non-extractable, for codesign only, and the
// always() step at the end removes the keychain, the profile and the upload key.  The same checks on altered copies of
// the workflow must each fail, each for its own reason.
//
//   node scripts/test-app-ios-testflight-guard.mjs
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const text = readFileSync(join(root, ".github", "workflows", "app-ios-testflight.yml"), "utf8");

// (the steps of a job: each "      - " item to the next, with its name, its env block and its run block)
function steps(job) {
  return job.split(/^(?=      - )/m).slice(1).map((s) => ({
    text: s,
    name: /^      - name: (.+)$/m.exec(s)?.[1] ?? /^      - uses: (.+)$/m.exec(s)?.[1] ?? "(unnamed)",
    env: /^        env:\n((?:          .*\n)*)/m.exec(s)?.[1] ?? "",
    run: /^        run: \|\n((?:          .*\n|\n)*)/m.exec(s)?.[1] ?? /^        run: (.+)$/m.exec(s)?.[1] ?? "",
    always: /^        if: always\(\)$/m.test(s),
  }));
}
const jobOf = (t, name) => new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [A-Za-z0-9_-]+:\\n|(?![\\s\\S]))`, "m").exec(t)?.[1];
// (the project's code: any of these commands in a step's run)
const BUILDS = /(?:^|[\s;&|(])(?:cargo|pnpm|npm|npx|bun|yarn|xcodegen|pod|make|swift|rustc)\b/m;

/** The problems with workflow text `t` (an empty list: it passes). */
function check(t) {
  const bad = [];
  const need = (c, what) => c || bad.push(what);
  const on = /^on:\n((?:  .*\n)+)/m.exec(t)?.[1] ?? "";
  need(on.trim() === "workflow_dispatch:", "the only trigger is workflow_dispatch");
  const head = t.slice(0, t.search(/^jobs:$/m));
  need(!/secrets\./.test(head), "no secret outside a step (the workflow's env)");
  const page = jobOf(t, "page"), arc = jobOf(t, "archive"), sg = jobOf(t, "sign");
  need(!!page && !!arc && !!sg, "the jobs page, archive and sign");
  if (!page || !arc || !sg) return bad;
  const names = [...t.slice(t.search(/^jobs:$/m)).matchAll(/^  ([A-Za-z0-9_-]+):\n/gm)].map((m) => m[1]);
  need(names.join() === "page,archive,sign", "the jobs are page, archive and sign, nothing else");
  const gate = "if: github.repository == 'sagemathinc/sagebrush' && github.ref == 'refs/heads/master'";
  need([page, arc, sg].every((j) => j.includes(`    ${gate}\n`)), "every job only on this repository's master");
  need(!/secrets\.|environment:/.test(page), "the page job has no secret and no environment");
  need(!/secrets\./.test(arc), "a secret only in the sign job (none in archive)");
  need(!/^    environment:/m.test(arc), "the archive job has no environment");
  need(/^    environment: sagebrush-signing$/m.test(sg), "the sign job in the sagebrush-signing environment");
  // (GitHub-hosted labels only: the isolation is a fresh VM per job)
  need(/^    runs-on: (?:macos-(?:14|15|26)(?:-xlarge)?|macos-latest)$/m.test(sg), "the sign job's runs-on is a GitHub-hosted macOS label");
  need(/^    needs: archive$/m.test(sg), "the sign job needs archive");
  need(!/uses: actions\/checkout@/.test(sg) && !/uses: \.\//.test(sg), "the sign job has no checkout and no local action");
  const uses = [...sg.matchAll(/^      - uses: ([^@\s]+)@/gm)].map((m) => m[1]);
  need(uses.every((u) => u === "actions/download-artifact"), "the sign job uses only download-artifact");
  need(/- uses: actions\/upload-artifact@\S+.*\n {8}with:\n {10}name: ios-archive\n/.test(arc) && /- uses: actions\/download-artifact@\S+.*\n {8}with:\n {10}name: ios-archive\n/.test(sg), "the archive is passed by the artifact ios-archive");
  const jobEnv = /^    env:\n((?:      .*\n)*)/m.exec(sg)?.[1] ?? "";
  need(!/secrets\./.test(jobEnv), "no secret in the sign job's env");
  const all = steps(sg);
  for (const s of all) {
    const secret = /secrets\./.test(s.text);
    need(!secret || /secrets\./.test(s.env), `${s.name}: a secret only in its step's env`);
    need(!BUILDS.test(s.run) && !/\btauri\b/.test(s.run), `${s.name}: in the sign job, so runs no build (cargo, tauri, a package manager)`);
    need(!/^\s*(?:\.|source)\s/m.test(s.run) && !/\bbash\s+[^-]/.test(s.run), `${s.name}: in the sign job, so runs no script file`);
    if (!secret) continue;
    for (const m of s.run.matchAll(/\bxcodebuild\b(.*)$/gm)) need(/^ -exportArchive\b/.test(m[1]), `${s.name}: holds a secret, so xcodebuild only with -exportArchive`);
    for (const m of s.run.matchAll(/\bnode\b(.*)$/gm)) need(/^ -e\b/.test(m[1]), `${s.name}: holds a secret, so node only with -e`);
  }
  const archive = steps(arc).find((s) => s.name === "Build the unsigned archive");
  need(!!archive && /cargo tauri ios build .*--archive-only --no-sign\b/.test(archive.run) && !/--export-method/.test(archive.run), "the archive is unsigned (--archive-only --no-sign)");
  need(all.some((s) => /^\s*find "\$RUNNER_TEMP\/archive" -type l -print0 \| while/m.test(s.run) && /case "\$r" in "\$base"\/\*\) ;; \*\) echo "FAIL: the link/.test(s.run)), "no link in the archive resolves outside it (checked after the untar)");
  const at = (re) => all.findIndex((s) => re.test(s.name));
  const sign = at(/^Sign for the App Store/), upload = at(/^Upload to App Store Connect/), clean = at(/^Remove the keychain/);
  need(sign >= 0 && upload > sign && clean === all.length - 1, "the order: sign, upload, then the clean-up last");
  if (sign >= 0) {
    const s = all[sign];
    const secrets = [...s.env.matchAll(/secrets\.(\w+)/g)].map((m) => m[1]).sort();
    need(secrets.join() === "SAGEBRUSH_IOS_DIST_P12_BASE64,SAGEBRUSH_IOS_DIST_P12_PASSWORD,SAGEBRUSH_IOS_PROFILE_BASE64", "the signing step holds the certificate, its password and the profile, nothing else");
    need(/security import \S+ -k "\$kc" -f pkcs12 -P "\$P12_PASSWORD" -x -T \/usr\/bin\/codesign$/m.test(s.run), "the certificate imported non-extractable (-x), for codesign only, into this run's keychain");
    need(/security create-keychain -p "\$kcpw" "\$kc"/.test(s.run) && /^\s*kcpw=\$\(openssl rand -hex 32\)$/m.test(s.run), "a keychain of this run's own, with a random password");
    need(/^\s*unset P12_PASSWORD$/m.test(s.run) && /rm -f "\$s\/dist\.p12"/.test(s.run), "the password unset and the .p12 removed once imported");
  }
  if (upload >= 0) {
    const u = all[upload];
    const secrets = [...u.env.matchAll(/secrets\.(\w+)/g)].map((m) => m[1]).sort();
    need(secrets.join() === "SAGEBRUSH_ASC_ISSUER_ID,SAGEBRUSH_ASC_KEY_BASE64,SAGEBRUSH_ASC_KEY_ID", "the upload step holds the API key only");
    need(/xcrun altool --upload-app /.test(u.run), "the upload is altool's");
  }
  if (clean >= 0) {
    const c = all[clean];
    need(c.always && !/secrets\./.test(c.text), "the clean-up runs always(), with no secret");
    need(/security delete-keychain "\$kc"/.test(c.run) && /\$uuid\.mobileprovision/.test(c.run) && /\$HOME\/\.appstoreconnect/.test(c.run), "the clean-up removes the keychain, the profile and the upload key");
  }
  return bad;
}

let failed = 0, passed = 0;
const problems = check(text);
for (const p of problems) console.log("FAIL " + p);
problems.length ? failed++ : passed++;
// The controls: each an altered copy that must fail, with the problem named.
const signEnv = /^( {8}env:\n {10}P12_BASE64: .*\n(?: {10}.*\n)*?)(?= {8}run:)/m;
const controls = [
  ["a trigger on pull requests", (t) => t.replace(/^on:\n  workflow_dispatch:\n/m, "on:\n  workflow_dispatch:\n  pull_request:\n"), "the only trigger"],
  ["the certificate in the archive step's env", (t) => t.replace(/(- name: Build the unsigned archive\n(?: {8}.*\n)*? {8}env:\n)/, "$1          IOS_CERTIFICATE: ${{ secrets.SAGEBRUSH_IOS_DIST_P12_BASE64 }}\n"), "none in archive"],
  ["an environment on the archive job", (t) => t.replace(/(  archive:\n(?:    .*\n)*?    timeout-minutes: 60\n)/, "$1    environment: sagebrush-signing\n"), "the archive job has no environment"],
  ["a checkout in the sign job", (t) => t.replace(/(  sign:\n(?:    .*\n|      .*\n)*?    steps:\n)/, "$1      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0\n"), "no checkout"],
  ["a local action in the sign job", (t) => t.replace(/(  sign:\n(?:    .*\n|      .*\n)*?    steps:\n)/, "$1      - uses: ./.github/actions/wasm-modules\n"), "no local action"],
  ["the sign job self-hosted", (t) => t.replace(/(  sign:\n(?:    .*\n)*?    runs-on: )macos-15/, "$1self-hosted"), "GitHub-hosted"],
  ["the sign job not needing archive", (t) => t.replace(/(  sign:\n(?:    .*\n)*?    needs: )archive/, "$1page"), "needs archive"],
  ["a secret in the sign job's env", (t) => t.replace(/(  sign:\n(?:    .*\n)*?    env:\n)/, "$1      P: ${{ secrets.SAGEBRUSH_IOS_DIST_P12_PASSWORD }}\n"), "no secret in the sign job's env"],
  ["an xcodebuild archive in the signing step", (t) => t.replace(/xcodebuild -exportArchive /, "xcodebuild archive -scheme x\n          xcodebuild -exportArchive "), "xcodebuild only with -exportArchive"],
  ["cargo in the sign job", (t) => t.replace(/(\n {10}mkdir "\$RUNNER_TEMP\/archive"\n)/, "\n          cargo build$1"), "runs no build"],
  ["cargo in the signing step", (t) => t.replace(/(\n {10}umask 077\n {10}s="\$RUNNER_TEMP\/signing")/, "\n          cargo build$1"), "runs no build"],
  ["the import without -x", (t) => t.replace(/ -x -T \/usr\/bin\/codesign/, " -T /usr/bin/codesign"), "non-extractable"],
  ["the import for every program (-A)", (t) => t.replace(/ -x -T \/usr\/bin\/codesign/, " -x -A"), "non-extractable"],
  ["a signed archive", (t) => t.replace(/--archive-only --no-sign/, "--export-method app-store-connect"), "unsigned"],
  ["the clean-up not always()", (t) => t.replace(/(- name: Remove the keychain.*\n) {8}if: always\(\)\n/, "$1"), "always()"],
  ["the clean-up without the keychain", (t) => t.replace(/security delete-keychain "\$kc"/, "true"), "removes the keychain"],
  ["the upload before the signing", (t) => {
    const s = t.indexOf("      - name: Sign for the App Store"), u = t.indexOf("      - name: Upload to App Store Connect"), c = t.indexOf("      - name: Remove the keychain");
    return t.slice(0, s) + t.slice(u, c) + t.slice(s, u) + t.slice(c);
  }, "the order"],
  ["a script run in the signing step", (t) => t.replace(/(\n {10}umask 077\n {10}s="\$RUNNER_TEMP\/signing")/, "\n          bash app/x.sh$1"), "no script file"],
  ["the upload key in the signing step", (t) => t.replace(signEnv, (m) => m + "          K: ${{ secrets.SAGEBRUSH_ASC_KEY_BASE64 }}\n"), "nothing else"],
  ["the archive's links not checked", (t) => t.replace(/case "\$r" in "\$base"\/\*\) ;; /, 'case "$r" in *) ;; '), "resolves outside it"],
  ["the artifact renamed in the sign job", (t) => t.replace(/(  sign:\n[\s\S]*?name: )ios-archive/, "$1other"), "the artifact ios-archive"],
];
for (const [what, alter, expect] of controls) {
  const t = alter(text);
  if (t === text) { failed++; console.log(`FAIL control "${what}": the alteration didn't apply`); continue; }
  const p = check(t);
  if (p.some((x) => x.includes(expect))) passed++;
  else { failed++; console.log(`FAIL control "${what}": passed, or failed for another reason (${p.join("; ") || "no problem found"})`); }
}
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
