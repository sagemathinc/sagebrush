import test from 'node:test';
import assert from 'node:assert/strict';
import { bundledPackageDir } from './build-package-dir.mjs';

test('normal checkout handles absolute/relative, scoped and nested vendored dependencies', () => {
  const root = '/home/user/sagebrush-normal';
  const dir = input => bundledPackageDir(input, root);
  assert.equal(dir('node_modules/@xterm/xterm/lib/xterm.js'), 'node_modules/@xterm/xterm');
  assert.equal(dir(root + '/node_modules/katex/dist/katex.mjs'), 'node_modules/katex');
  const store = 'node_modules/.pnpm/patchflow@0.16.0/node_modules/patchflow/node_modules/@cocalc/diff-match-patch';
  assert.equal(dir(root + '/' + store + '/index.js'), store);
  assert.equal(dir('web/board/page.ts'), null);
});

test('symlinked node_modules is independent of worktree path length and preserves pnpm version paths', () => {
  const modules = '/home/user/sagebrush/node_modules';
  const suffix = '.pnpm/@xterm+xterm@6.0.0/node_modules/@xterm/xterm';
  for (const root of ['/home/user/sb', '/home/user/sagebrush-remote-preview', '/different/very-long-checkout-name']) {
    assert.equal(bundledPackageDir(modules + '/' + suffix + '/lib/xterm.js', root), 'node_modules/' + suffix);
    assert.equal(bundledPackageDir(root + '/node_modules/katex/dist/katex.mjs', root), 'node_modules/katex');
  }
  assert.equal(bundledPackageDir('/unrelated/node_modules/katex/index.js', '/checkout'), 'node_modules/katex');
});
