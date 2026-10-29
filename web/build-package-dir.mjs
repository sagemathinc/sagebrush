import { isAbsolute, relative, resolve } from 'node:path';

// Bun may report either the checkout's logical dependency path or the real path
// of a symlinked node_modules. Keep nested .pnpm store paths for vendored notices.
export function bundledPackageDir(input, cwd, root, realModules) {
  const abs = resolve(cwd, input);
  const marker = '/node_modules/';
  const last = abs.lastIndexOf(marker);
  if (last < 0) return null;
  const parts = abs.slice(last + marker.length).split('/');
  const name = parts[0].startsWith('@') ? parts[0] + '/' + parts[1] : parts[0];
  const packagePath = abs.slice(0, last + marker.length) + name;
  for (const modules of [resolve(root, 'node_modules'), realModules]) {
    const path = relative(modules, packagePath);
    if (path && path !== '..' && !path.startsWith('../') && !isAbsolute(path)) return 'node_modules/' + path;
  }
  throw new Error('bundled dependency is outside the checkout node_modules');
}
