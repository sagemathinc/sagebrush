// ci: checks.3 order=146
// Exercise the hosted-runner mirror helper against fixture files, without sudo or network access.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const dir = mkdtempSync(join(tmpdir(), 'apt-mirror-'));
const helper = readFileSync(fileURLToPath(new URL('./ci-apt-mirror.sh', import.meta.url)), 'utf8');
const mirrors = join(dir, 'mirrors.txt'), script = join(dir, 'helper.sh'), bin = join(dir, 'bin');
// Relocate only the helper's fixed system path; run the rest of its actual shell code unchanged.
assert.equal(helper.split('/etc/apt/apt-mirrors.txt').length - 1, 2);
writeFileSync(script, helper.replaceAll('/etc/apt/apt-mirrors.txt', mirrors));
mkdirSync(bin);
writeFileSync(join(bin, 'curl'), '#!/bin/sh\nexit "${PROBE_EXIT:-0}"\n', { mode: 0o755 });
writeFileSync(join(bin, 'sudo'), '#!/bin/sh\nexec "$@"\n', { mode: 0o755 });
const run = (probe = '0') => {
  const r = spawnSync('bash', [script], { encoding: 'utf8', env: { ...process.env, PATH: bin + ':' + process.env.PATH, PROBE_EXIT: probe } });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
};
try {
  assert.match(run(), /left as they are/, 'a runner with no mirrorlist is unchanged');
  const original = 'http://azure.archive.ubuntu.com/ubuntu/\tpriority:1\nhttp://us-east-2.ec2.archive.ubuntu.com/ubuntu/\tpriority:1\nhttps://archive.ubuntu.com/ubuntu/\tpriority:2\nhttps://security.ubuntu.com/ubuntu/\tpriority:3\n';
  writeFileSync(mirrors, original);
  run('1');
  assert.equal(readFileSync(mirrors, 'utf8'), original, 'a failed health probe leaves the mirror list alone');
  run();
  const first = readFileSync(mirrors, 'utf8');
  assert.ok(!first.includes('azure.archive.ubuntu.com'));
  const rows = first.trim().split('\n');
  const priority = line => Number(/priority:(\d+)/.exec(line)?.[1] ?? Infinity);
  assert.ok(rows[0].startsWith('http://mirrors.edge.kernel.org/ubuntu/'));
  assert.ok(rows.slice(1).every(row => priority(rows[0]) < priority(row)), 'the checked mirror outranks EC2; no random download fan-out to a tied mirror');
  assert.ok(first.includes('us-east-2.ec2.archive.ubuntu.com'), 'EC2 remains a fallback');
  assert.ok(first.includes('https://archive.ubuntu.com/ubuntu/\tpriority:2'));
  assert.ok(first.includes('https://security.ubuntu.com/ubuntu/\tpriority:3'));
  run();
  assert.equal(readFileSync(mirrors, 'utf8'), first, 're-running does not duplicate the preferred mirror');
  console.log('PASS: preferred mirror outranks EC2, fallbacks retained, failed probe and missing file unchanged');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
