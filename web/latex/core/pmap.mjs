// Persistent hash map (HAMT, path copying) with an order-independent aggregate hash.
// D4 spike (D3 r4 §7.2): snapshots are O(1) (keep the root); equality of two maps is
// first decided by the aggregate hash (two 32-bit lanes), then optionally by a full
// structural comparison (used by the replay=cold check on a sample).
//
// Keys are strings. Values must carry a numeric hash: either a number, or an object
// with an integer field `vh` (computed once when the value is created).

const BITS = 5, WIDTH = 32, MASK = 31;

export function strHash(s) {           // FNV-1a 32-bit
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}
function mix(a, b) {                     // 32-bit mix of two 32-bit ints
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ b;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}
export function valueHash(v) {
  if (typeof v === "number") return mix(v | 0, (v / 4294967296) | 0);
  if (v === undefined || v === null) return 0;
  return v.vh >>> 0;
}
function entryHashes(kh, v) {
  const vh = valueHash(v);
  return [mix(kh, vh), mix(vh ^ 0x5bd1e995, kh)];
}
function popcount(x) { x -= (x >>> 1) & 0x55555555; x = (x & 0x33333333) + ((x >>> 2) & 0x33333333); return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24; }

class Leaf { constructor(kh, k, v) { this.kh = kh; this.k = k; this.v = v; } }
class Collision { constructor(kh, leaves) { this.kh = kh; this.leaves = leaves; } }
class Node { constructor(bitmap, children) { this.bitmap = bitmap; this.children = children; } }
const EMPTY_NODE = new Node(0, []);

function getIn(node, kh, k, shift) {
  for (;;) {
    if (node instanceof Leaf) return node.k === k ? node : undefined;
    if (node instanceof Collision) { for (const l of node.leaves) if (l.k === k) return l; return undefined; }
    const bit = 1 << ((kh >>> shift) & MASK);
    if ((node.bitmap & bit) === 0) return undefined;
    node = node.children[popcount(node.bitmap & (bit - 1))];
    shift += BITS;
  }
}

function mergeLeaves(a, b, shift) {   // a, b: Leaf or Collision with DIFFERENT keys
  if (a.kh === b.kh) {
    const la = a instanceof Collision ? a.leaves : [a], lb = b instanceof Collision ? b.leaves : [b];
    return new Collision(a.kh, la.concat(lb));
  }
  if (shift >= 35) throw new Error("pmap: distinct 32-bit hashes must separate within 7 levels");
  const ia = (a.kh >>> shift) & MASK, ib = (b.kh >>> shift) & MASK;
  if (ia === ib) return new Node(1 << ia, [mergeLeaves(a, b, shift + BITS)]);
  return ia < ib ? new Node((1 << ia) | (1 << ib), [a, b]) : new Node((1 << ia) | (1 << ib), [b, a]);
}

// returns [newNode, oldLeafOrUndefined]
function setIn(node, leaf, shift) {
  if (node instanceof Leaf) {
    if (node.k === leaf.k) return [leaf, node];
    return [mergeLeaves(node, leaf, shift), undefined];
  }
  if (node instanceof Collision) {
    // a new key whose hash differs from the collision bucket's: split into a Node holding BOTH the
    // whole collision bucket and the new leaf (no entry is lost; astra4 D4 r1 R3)
    if (node.kh !== leaf.kh) return [mergeLeaves(node, leaf, shift), undefined];
    const ls = node.leaves.slice();
    for (let i = 0; i < ls.length; i++) if (ls[i].k === leaf.k) { const old = ls[i]; ls[i] = leaf; return [new Collision(node.kh, ls), old]; }
    ls.push(leaf); return [new Collision(node.kh, ls), undefined];
  }
  const idx = (leaf.kh >>> shift) & MASK, bit = 1 << idx, pos = popcount(node.bitmap & (bit - 1));
  if ((node.bitmap & bit) === 0) {
    const ch = node.children.slice(); ch.splice(pos, 0, leaf);
    return [new Node(node.bitmap | bit, ch), undefined];
  }
  const [nc, old] = setIn(node.children[pos], leaf, shift + BITS);
  const ch = node.children.slice(); ch[pos] = nc;
  return [new Node(node.bitmap, ch), old];
}

function delIn(node, kh, k, shift) {     // returns [newNodeOrNull, oldLeaf]
  if (node instanceof Leaf) return node.k === k ? [null, node] : [node, undefined];
  if (node instanceof Collision) {
    const i = node.leaves.findIndex((l) => l.k === k);
    if (i < 0) return [node, undefined];
    const ls = node.leaves.slice(); const old = ls.splice(i, 1)[0];
    return [ls.length === 1 ? ls[0] : new Collision(node.kh, ls), old];
  }
  const bit = 1 << ((kh >>> shift) & MASK);
  if ((node.bitmap & bit) === 0) return [node, undefined];
  const pos = popcount(node.bitmap & (bit - 1));
  const [nc, old] = delIn(node.children[pos], kh, k, shift + BITS);
  if (!old) return [node, undefined];
  const ch = node.children.slice();
  if (nc === null) { ch.splice(pos, 1); return [ch.length ? new Node(node.bitmap & ~bit, ch) : null, old]; }
  ch[pos] = nc; return [new Node(node.bitmap, ch), old];
}

export class PMap {
  constructor(root = EMPTY_NODE, size = 0, h1 = 0, h2 = 0) { this.root = root; this.size = size; this.h1 = h1; this.h2 = h2; }
  static empty() { return EMPTY_PMAP; }
  get(k) { const l = getIn(this.root, strHash(k), k, 0); return l ? l.v : undefined; }
  has(k) { return getIn(this.root, strHash(k), k, 0) !== undefined; }
  set(k, v) {
    const kh = strHash(k);
    const [root, old] = setIn(this.root, new Leaf(kh, k, v), 0);
    let { h1, h2, size } = this;
    if (old) { const [o1, o2] = entryHashes(kh, old.v); h1 = (h1 - o1) >>> 0; h2 = (h2 - o2) >>> 0; } else size++;
    const [n1, n2] = entryHashes(kh, v); h1 = (h1 + n1) >>> 0; h2 = (h2 + n2) >>> 0;
    return new PMap(root, size, h1, h2);
  }
  delete(k) {
    const kh = strHash(k);
    const [root, old] = delIn(this.root, kh, k, 0);
    if (!old) return this;
    const [o1, o2] = entryHashes(kh, old.v);
    return new PMap(root || EMPTY_NODE, this.size - 1, (this.h1 - o1) >>> 0, (this.h2 - o2) >>> 0);
  }
  hashEquals(other) { return this.size === other.size && this.h1 === other.h1 && this.h2 === other.h2; }
  hashString() { return this.h1.toString(16).padStart(8, "0") + this.h2.toString(16).padStart(8, "0") + ":" + this.size; }
  *entries() {
    const stack = [this.root];
    while (stack.length) {
      const n = stack.pop();
      if (n instanceof Leaf) yield [n.k, n.v];
      else if (n instanceof Collision) for (const l of n.leaves) yield [l.k, l.v];
      else for (const c of n.children) stack.push(c);
    }
  }
  // Full structural comparison (slow; used on samples by the replay=cold check).
  structEquals(other, valueEq) {
    if (this.size !== other.size) return false;
    for (const [k, v] of this.entries()) {
      const w = other.get(k);
      if (w === undefined || !valueEq(v, w)) return false;
    }
    return true;
  }
  // Approximate retained-size accounting for §7.4 (nodes x measured size is reported by D4).
  nodeCount() {
    let n = 0; const stack = [this.root];
    while (stack.length) { const x = stack.pop(); n++; if (x instanceof Node) for (const c of x.children) stack.push(c); }
    return n;
  }
}
const EMPTY_PMAP = new PMap();
