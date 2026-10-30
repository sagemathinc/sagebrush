// Lanes import this one switch and supply their own implementations.
import { MOCKS } from './names.mjs';
export { MOCKS };
const HOST = /^[a-z0-9][a-z0-9-]{0,40}\.sagebrush\.cloud$/;
export function mockEnabled(name) {
  if (!MOCKS.includes(name)) throw new Error('Unknown preview mock name');
  if (typeof location === 'undefined' || !HOST.test(location.hostname)) return false;
  const fromBuild = globalThis.__SAGEBRUSH_PREVIEW__;
  const built = fromBuild?.host === location.hostname && Array.isArray(fromBuild.mocks) ? fromBuild.mocks : [];
  const query = new URL(location.href).searchParams.get('mock');
  return (query === null ? built : query.split(',')).includes(name);
}
