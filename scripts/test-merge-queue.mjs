// ci: checks.3 order=145
// Replay queue payloads against real git histories, including a cumulative head.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { testedTransition } from './size-measure.mjs';

const dir = mkdtempSync(join(tmpdir(), 'merge-queue-'));
const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (path, text) => {
  writeFileSync(join(dir, path), text);
  git('add', path); git('commit', '-qm', text);
  return git('rev-parse', 'HEAD');
};
const root = fileURLToPath(new URL('../', import.meta.url));
const event = (base, head) => ({ action: 'checks_requested', merge_group: { base_sha: base, head_sha: head, base_ref: 'refs/heads/master', head_ref: 'refs/heads/gh-readonly-queue/master/pr-1' } });
const resolve = ev => testedTransition({ cwd: dir, name: 'merge_group', ev });
function classify(ev, labels = '') {
  const path = join(dir, 'event.json');
  writeFileSync(path, JSON.stringify(ev));
  return spawnSync(process.execPath, [join(root, 'scripts/ci-paths.mjs')], {
    cwd: dir, encoding: 'utf8', env: { ...process.env, CI_PATHS_FILES: '', CI_PATHS_ROOT: root,
      GITHUB_EVENT_NAME: 'merge_group', GITHUB_EVENT_PATH: path, GITHUB_SHA: git('rev-parse', 'HEAD'),
      GITHUB_REF: ev.merge_group.head_ref, GITHUB_REF_NAME: String(ev.merge_group.head_ref ?? '').replace(/^refs\/heads\//, ''),
      GITHUB_BASE_REF: '', GITHUB_HEAD_REF: '', CI_PR_LABELS: labels },
  });
}
function full(ev, labels = '') {
  const r = classify(ev, labels);
  assert.equal(r.status, 0, r.stderr);
  const o = Object.fromEntries(r.stdout.trim().split('\n').map(line => line.split('=')));
  for (const key of ['full', 'node', 'web', 'modes', 'engine_smoke', 'engine_full', 'wasm_build', 'webkit', 'web_share', 'web_runner'])
    assert.equal(o[key], 'true', key);
  for (const key of ['docs_only', 'app_only', 'long', 'slow_tests']) assert.equal(o[key], 'false', key);
  return o;
}
// Parse the actual workflows, and run their final guards over failed/skipped upstream jobs.
const workflow = name => JSON.parse(execFileSync('bun', ['-e',
  'console.log(JSON.stringify(Bun.YAML.parse(await Bun.file(process.argv[1]).text())))',
  join(root, '.github/workflows', name + '.yml')], { encoding: 'utf8' }));
const ci = workflow('ci'), app = workflow('app');
for (const w of [ci, app]) {
  assert.deepEqual(w.permissions, { contents: 'read' }, 'queue code gets only a read-only repository token');
  for (const [name, job] of Object.entries(w.jobs)) {
    if (job.permissions) {
      // (changes reads the runs of its own commit, to find the merge queue's run of it: scripts/ci-queue-tested.mjs)
      assert.ok(w === ci && ['changes', 'size-base', 'wasm-publish', 'size-gate'].includes(name), 'no unexpected token override');
      // (size-gate reads only the queued pull request's labels, for the track-pull label: design/size-gate.md)
      assert.deepEqual(job.permissions, name === 'size-gate' ? { contents: 'read', 'pull-requests': 'read' } : { contents: 'read', actions: 'read' });
    }
    for (const step of job.steps ?? []) {
      if (step.uses?.startsWith('actions/download-artifact@')) {
        for (const key of ['github-token', 'repository', 'run-id'])
          assert.equal(step.with?.[key], undefined, 'artifact download stays in the current run');
      }
    }
  }
  assert.deepEqual(w.on.merge_group.types, ['checks_requested']);
  assert.equal(w.on.pull_request?.paths, undefined, 'required workflow has no PR path filter');
}
assert.ok(ci.jobs.ci.needs.includes('engine-nd-neon'));
const guard = (step, env) => spawnSync('bash', ['-e', '-c', step.run], { env: { ...process.env, ...env } }).status;
const ciGuard = ci.jobs.ci.steps[0];
assert.equal(guard(ciGuard, { CHANGES: 'success', RESULTS: 'success skipped' }), 0);
for (const env of [{ CHANGES: 'skipped', RESULTS: 'skipped' }, { CHANGES: 'failure', RESULTS: 'skipped' },
  { CHANGES: 'success', RESULTS: 'success failure' }, { CHANGES: 'success', RESULTS: 'success cancelled' }])
  assert.notEqual(guard(ciGuard, env), 0);
const appGuard = app.jobs['app-ci'].steps[0];
const passingApp = { EVENT: 'merge_group', PAGE: 'success', APP: 'success', WASM_CHANGES: 'success', WASM: 'success' };
assert.equal(guard(appGuard, passingApp), 0);
for (const env of [{ PAGE: 'skipped' }, { APP: 'failure' }, { WASM_CHANGES: 'skipped' }, { WASM: 'failure' }])
  assert.notEqual(guard(appGuard, { ...passingApp, ...env }), 0);
console.log('PASS: required workflow triggers and aggregate failure/skip guards');

// Queue runs never write a cache: a queue ref is unique, so a cache saved there is never read again and only evicts
// master's.  Every cache-capable step of a workflow that runs on merge_group, and of every local action, is guarded;
// a cache action this test doesn't know fails it, so a new writer can't slip through.
{
  const NO_QUEUE = "github.event_name != 'merge_group'";
  const parse = path => JSON.parse(execFileSync('bun', ['-e',
    'console.log(JSON.stringify(Bun.YAML.parse(await Bun.file(process.argv[1]).text())))', path], { encoding: 'utf8' }));
  const files = [];
  const wfDir = join(root, '.github/workflows'), acDir = join(root, '.github/actions');
  for (const f of readdirSync(wfDir).filter(f => /\.ya?ml$/.test(f))) {
    const wf = parse(join(wfDir, f));
    if (wf.on && typeof wf.on === 'object' && 'merge_group' in wf.on)
      files.push([f, Object.values(wf.jobs).flatMap(j => j.steps ?? [])]);
  }
  for (const d of existsSync(acDir) ? readdirSync(acDir) : []) {
    for (const n of ['action.yml', 'action.yaml']) {
      const f = join(acDir, d, n);
      if (existsSync(f)) files.push([`actions/${d}/${n}`, parse(f).runs?.steps ?? []]);
    }
  }
  assert.ok(files.some(([f]) => f === 'ci.yml') && files.some(([f]) => f === 'app.yml'), 'ci.yml and app.yml run on merge_group');
  let writers = 0;
  for (const [file, steps] of files) for (const step of steps) {
    const uses = String(step.uses ?? ''), action = uses.split('@')[0], w = step.with ?? {};
    const where = `${file}: ${step.name ?? uses}`;
    if (/^actions\/setup-(node|python)$/.test(action)) {
      if ('cache' in w) { writers++; assert.ok(String(w.cache).includes(NO_QUEUE), `${where}: its cache input is set on merge_group`); }
    } else if (action === 'Swatinem/rust-cache') {
      writers++; assert.ok(String(w['save-if'] ?? '').includes(NO_QUEUE), `${where}: rust-cache saves on merge_group`);
    } else if (action === 'actions/cache/restore') {
      // restoring is fine
    } else if (action === 'actions/cache/save' || action === 'actions/cache') {
      writers++; assert.ok(String(step.if ?? '').includes(NO_QUEUE), `${where}: a cache save runs on merge_group`);
    } else {
      assert.ok(!/cache/i.test(action), `${where}: an unknown cache action; guard it here`);
      assert.ok(!('cache' in w), `${where}: an unknown action with a cache input; guard it here`);
    }
  }
  assert.ok(writers >= 40, `every cache writer is checked (${writers})`);
  console.log(`PASS: no cache writer runs on merge_group (${writers} guarded steps)`);
}
try {
  git('init', '-q', '-b', 'master');
  git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
  const base = commit('README.md', 'base');
  const first = commit('README.md', 'first queue entry');
  assert.deepEqual(resolve(event(base, first)), { mode: 'transition', merge: first, base, head: first });
  const unlabeled = full(event(base, first));
  assert.equal(unlabeled.files, '1');
  assert.deepEqual(full(event(base, first), 'full-ci'), unlabeled, 'a full-ci label cannot select more than a queue run');
  const second = commit('new-input.txt', 'second queue entry');
  assert.deepEqual(resolve(event(base, second)), { mode: 'transition', merge: second, base, head: second });
  assert.equal(full(event(base, second)).files, '2', 'classify every entry, not just the last commit');
  assert.equal(resolve(event(first, second)).mode, 'transition', 'a base from a prior queue group is valid');
  for (const bad of [event(base, first), event(base, undefined), event(undefined, second), event(second, second)]) {
    assert.throws(() => resolve(bad), /merge_group/);
  }
  assert.notEqual(classify(event(base, first)).status, 0, 'a stale queue payload fails classification');
  git('checkout', '-q', '--orphan', 'unrelated'); git('rm', '-qrf', '.');
  const unrelated = commit('other.txt', 'unrelated');
  git('checkout', '-q', '--detach', second);
  assert.throws(() => resolve(event(unrelated, second)), /ancestor/);
  assert.notEqual(classify(event(unrelated, second)).status, 0, 'a non-ancestor base fails classification');
  console.log('PASS: single and cumulative merge groups, full tier without labels, and invalid payload refusal');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
