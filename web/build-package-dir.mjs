import { resolve } from 'node:path';

// Bun may report either the checkout's logical dependency path or the real path
// of a symlinked node_modules. Keep nested .pnpm store paths for vendored notices.
export function bundledPackageDir(input, cwd) {
  const abs = resolve(cwd, input);
  const marker = '/node_modules/';
  const last = abs.lastIndexOf(marker);
  if (last < 0) return null;
  const parts = abs.slice(last + marker.length).split('/');
  const name = parts[0].startsWith('@') ? parts[0] + '/' + parts[1] : parts[0];
  // Keep a pnpm store/version prefix when present (including vendored nested
  // dependencies). Otherwise the last node_modules boundary names the package.
  // Individual package links can point outside even a real copied node_modules.
  const store = abs.lastIndexOf('/node_modules/.pnpm/', last);
  return abs.slice((store < 0 ? last : store) + 1, last + marker.length) + name;
}
