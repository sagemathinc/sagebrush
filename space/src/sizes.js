// An object's slab, [width, height, depth] in the space's units: by its kind, and for what holds code, by its length
// (`lines`; a directory by its `files`), so a long one looks long from afar.  main.js draws with it; roomlayout.js
// spaces a room's objects by it.
const SIZE = {
  file: [2.6, 1.6, 0.12], note: [5, 3.8, 0.45], code: [5, 3.8, 0.2], plot3d: [5, 5, 0.15],
  fn: [3.4, 2.1, 0.3], class: [4.6, 3, 0.7], block: [3.4, 1.8, 0.2], import: [2.6, 1.0, 0.1], dir: [3.6, 2.4, 0.9],
};
// (the length at which an object is its kind's usual size)
const USUAL = { file: 120, fn: 25, block: 25, class: 80 };
const clampK = (k) => Math.min(2.4, Math.max(0.7, k));
export function sizeOf(nd) {
  const s = SIZE[nd.kind] ?? SIZE.file;
  let k = null;
  if (nd.kind === "dir" && Number(nd.files) > 0) k = clampK(Math.sqrt(Number(nd.files) / 10));
  else if (USUAL[nd.kind] && Number(nd.lines) > 0) k = clampK(Math.sqrt(Number(nd.lines) / USUAL[nd.kind]));
  return k === null ? s : [s[0] * Math.sqrt(k), s[1] * k, s[2]];
}
