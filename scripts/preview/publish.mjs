#!/usr/bin/env node
import { constants, openSync, closeSync, fstatSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { NAME } from '../../web/preview/worker.mjs';
import { MOCKS } from '../../web/preview/names.mjs';
import { prepare } from './prepare.mjs';
import { R2 } from './r2.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
function credentials() {
  const path = join(homedir(), '.local/share/sagebrush/preview-secrets.json');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.uid !== process.getuid() || stat.size > 16384) {
      throw new Error('Preview secrets must be an owned regular file, mode 600, at most 16 KiB');
    }
    const value = JSON.parse(readFileSync(fd, 'utf8'));
    if (!value || Object.keys(value).sort().join(',') !== 'accessKeyId,accountId,secretAccessKey' ||
        !/^[a-f0-9]{32}$/.test(value.accountId) || !/^[a-fA-F0-9]{32}$/.test(value.accessKeyId) ||
        !/^[a-fA-F0-9]{64}$/.test(value.secretAccessKey)) throw new Error('Invalid preview R2 credential file schema');
    return value;
  } finally { closeSync(fd); }
}
function productionEnvironment() {
  for (const [key, value] of Object.entries(process.env)) {
    if (/(^|_)(PROD|PRODUCTION)(_|$)/i.test(key) ||
        (/^(NODE_ENV|ENVIRONMENT|ENV|SAGEBRUSH_ENV|DEPLOY_ENV|CLOUDFLARE_ENV)$/i.test(key) && /^(prod|production)$/i.test(value))) {
      throw new Error('Refusing a production environment; use a clean development shell');
    }
  }
}
async function main() {
  productionEnvironment();
  const [name, ...flags] = process.argv.slice(2);
  if (!name || !NAME.test(name)) throw new Error('Usage: scripts/preview.sh <name> [SAGEBRUSH_LATEX_PREVIEW=1] [SAGEBRUSH_PREVIEW_MOCKS=a,b]');
  // No generic shell command, output directory, endpoint or bucket override.
  const options = {};
  for (const key of ['SAGEBRUSH_LATEX_PREVIEW', 'SAGEBRUSH_PREVIEW_MOCKS']) {
    if (process.env[key] !== undefined) options[key] = process.env[key];
  }
  for (const flag of flags) {
    const match = /^(SAGEBRUSH_LATEX_PREVIEW|SAGEBRUSH_PREVIEW_MOCKS)=(.*)$/.exec(flag);
    if (!match) throw new Error('Unknown preview build flag');
    options[match[1]] = match[2];
  }
  if (options.SAGEBRUSH_LATEX_PREVIEW !== undefined && options.SAGEBRUSH_LATEX_PREVIEW !== '1') throw new Error('Hosted LaTeX previews require =1; test hooks are forbidden');
  const mocks = options.SAGEBRUSH_PREVIEW_MOCKS ? options.SAGEBRUSH_PREVIEW_MOCKS.split(',') : [];
  if (mocks.some(x => !MOCKS.includes(x)) || new Set(mocks).size !== mocks.length) throw new Error('Unknown or duplicate preview mock');
  const common = git('rev-parse', '--path-format=absolute', '--git-common-dir');
  const origin = git('remote', 'get-url', 'origin');
  if (!['git@github.com:sagemathinc/sagebrush.git', 'https://github.com/sagemathinc/sagebrush.git', 'https://github.com/sagemathinc/sagebrush'].includes(origin) ||
      /cloud-private|sagebrush-private/i.test(root + '\n' + common)) throw new Error('Only the public sagemathinc/sagebrush repository may be previewed');
  const host = `${name}.sagebrush.cloud`;
  if (options.SAGEBRUSH_LATEX_PREVIEW && !readFileSync(join(root, 'web/build.ts'), 'utf8').includes('SAGEBRUSH_PREVIEW_HOST')) {
    throw new Error('This branch lacks the LaTeX lane hosted-preview host gate; obtain its reviewed change first');
  }
  // Keep build children away from inherited CoCalc, AWS, Cloudflare and production tokens.
  // Credentials are read only AFTER every build process has exited.
  const env = Object.fromEntries(['PATH', 'HOME', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR'].filter(k => process.env[k] !== undefined).map(k => [k, process.env[k]]));
  Object.assign(env, options, { NODE_ENV: 'development', SAGEBRUSH_NO_SITE: '1', SAGEBRUSH_PREVIEW_HOST: host });
  const buildLock = join(git('rev-parse', '--absolute-git-dir'), 'preview-build.lock');
  try { mkdirSync(buildLock); } catch { throw new Error('Preview worktree build lock exists; inspect the prior publisher before removing it'); }
  try {
    const lock = join(common, `preview-${name}.lock`);
    try { mkdirSync(lock); } catch { throw new Error('Preview publish lock exists; inspect the prior publisher before removing it'); }
    try {
      // Only builds use ptest; preparation, credentials and R2 run in this parent.
      const step = (command, args) => execFileSync('/home/user/sagebrush-coord/bin/ptest', ['-m', '30', '--', command, ...args], { cwd: root, env, stdio: 'inherit' });
      // Never reuse dist: removed files, old mock flags and a private site overlay must not leak.
      rmSync(join(root, 'web/dist'), { recursive: true, force: true });
      step('pnpm', ['run', 'build']);
      step('node', ['scripts/build-cli.mjs']);
      step('bun', ['web/build.ts']);
      const output = prepare(join(root, 'web/dist'), host, mocks);
      // A single remote deadline covers listing, every PUT/DELETE, and body consumption.
      const remoteSignal = AbortSignal.timeout(20 * 60 * 1000);
      try {
        const client = new R2(credentials(), name, remoteSignal);
        const previous = await client.list();
        const keep = new Set([...output.files.keys()].map(p => `${name}/${p}`));
        // Upload policy sidecars and assets before entry pages; stale deletions happen last.
        const entries = [...output.files].sort(([a], [b]) => Number(a.endsWith('.html')) - Number(b.endsWith('.html')) || a.localeCompare(b));
        for (const [path, file] of entries) await client.put(`${name}/${path}`, file.bytes, file.type);
        for (const key of previous) if (!keep.has(key)) await client.delete(key);
        remoteSignal.throwIfAborted();
      } catch (error) {
        if (remoteSignal.aborted) throw new Error('Preview remote phase exceeded 20 minutes; publication may be partial and needs owner inspection');
        throw error;
      }
      console.log(`https://${host}/${options.SAGEBRUSH_LATEX_PREVIEW ? '?latex=1' : ''}`);
    } finally { rmSync(lock, { recursive: true, force: true }); }
  } finally { rmSync(buildLock, { recursive: true, force: true }); }
}
main().catch(error => {
  // Child stderr is build output only; S3 response bodies, fetch errors and JSON
  // parse failures may contain credentials and must never reach the terminal.
  const message = error instanceof Error && /^(Usage:|Refusing |Unknown |Only |Hosted |This branch |Preview |Invalid preview |R2 )/.test(error.message)
    ? error.message : 'Preview publish failed; inspect build output or the local preview credential file (credentials are never printed)';
  console.error(message);
  process.exitCode = 1;
});
