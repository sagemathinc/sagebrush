// The examples gallery's CI logic, without running anything (plan U7 final f8c4313e, sections 1 and 2,
// appendix A1, A5 and A6): ids and manifests, which examples a change selects, the shard matrix and its
// census, and the normalized form of a notebook's outputs that the committed one must equal.
// scripts/examples.mjs runs examples with it; scripts/ci-paths.mjs selects with it; its tests are
// scripts/test-examples.mjs.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export const KINDS = ["notebook", "board", "latex"];
export const ID = /^(notebook|board|latex)\/[a-z0-9]+(-[a-z0-9]+)*$/;
export const SLUG_MAX = 64;
/** the most examples a shard runs, and the most shards a matrix has (GitHub's job limit): 16, so that a shard's
 * worst case, every example killed at its 30 s deadline, two at a time, is 4 minutes, and the job with its build
 * stays inside PR CI's 10 minutes (William, Nov 2 and Nov 4) */
export const SHARD_MAX = 16;
export const MATRIX_MAX = 256;
export const MODES = ["python", "sage", "magma", "matlab"];
export const LEVELS = ["intro", "course", "research"];
export const FEATURES = [
  "beamer",
  "tikz",
  "pgfplots",
  "bibliography",
  "sagetex",
  "pythontex",
  "matlab",
];
/** the LaTeX features whose code runs (in the CLI engine, through `latex run`) */
export const EXECUTABLE = ["sagetex", "pythontex", "matlab"];
/** limits per example (A1, plan section 5) */
export const LIMITS = {
  files: 40,
  depth: 4,
  file: 200 * 1024,
  total: 512 * 1024,
  summary: 160,
  title: 120,
};
const SEGMENT = /^[A-Za-z0-9._ -]{1,64}$/;
const BINARY = /\.(png|jpe?g|gif|webp|pdf|zip)$/i;

export const sha256 = (b) => createHash("sha256").update(b).digest("hex");

/** Every example under root, sorted by id: {id, kind, slug, dir, manifest | null, error?}. */
export function listExamples(root) {
  const out = [];
  for (const kind of KINDS) {
    const d = join(root, kind);
    if (!existsSync(d)) continue;
    for (const slug of readdirSync(d).sort()) {
      const dir = join(d, slug);
      if (!statSync(dir).isDirectory()) continue;
      const e = { id: `${kind}/${slug}`, kind, slug, dir, manifest: null };
      try {
        e.manifest = JSON.parse(
          readFileSync(join(dir, "example.json"), "utf8"),
        );
      } catch (err) {
        e.error = `example.json: ${err.message}`;
      }
      out.push(e);
    }
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export const executable = (e) =>
  e.kind === "latex" &&
  (e.manifest?.features ?? []).some((f) => EXECUTABLE.includes(f));

// What a change runs (plan section 2's table): changed paths -> the ids to run.
const ALL = [
  /^examples\/schema\.json$/,
  /^examples\/tags\.json$/,
  /^scripts\/examples[^/]*\.mjs$/,
  /^\.github\/workflows\/ci\.yml$/,
];
const ENGINE = [
  /^src\//,
  /^lib\//,
  /^engine\//,
  /^wasm\//,
  /^pyparse\//,
  /^kernels\//,
  /^scripts\/build-cli\.mjs$/,
  /^package\.json$/,
  /^pnpm-lock\.yaml$/,
];
const BOARD = [/^web\/board\//, /^packages\/sagebrush-board\//];
const LATEX = [/^web\/latex\//, /^src\/latex-cli\.ts$/];
export const EXAMPLE_PATH =
  /^examples\/(notebook|board|latex)\/([a-z0-9]+(?:-[a-z0-9]+)*)\//;

/** {ids, reason}: the examples a run selects, from its changed files; `all` (full tier, nightly) selects every one. */
export function select(files, examples, { all = false } = {}) {
  const m = (ps) => files.some((f) => ps.some((p) => p.test(f)));
  if (all)
    return {
      ids: examples.map((e) => e.id),
      reason: "all: the full tier or a scheduled run",
    };
  if (m(ALL))
    return {
      ids: examples.map((e) => e.id),
      reason: "all: the examples' schema, tags, tools or job changed",
    };
  const ids = new Set();
  const why = [];
  if (m(ENGINE)) {
    for (const e of examples)
      if (e.kind === "notebook" || e.kind === "board" || executable(e))
        ids.add(e.id);
    why.push(
      "the CLI, engines or libraries: every notebook, board and executable latex example",
    );
  }
  if (m(BOARD)) {
    for (const e of examples) if (e.kind === "board") ids.add(e.id);
    why.push("the board: every board example");
  }
  if (m(LATEX)) {
    for (const e of examples) if (e.kind === "latex") ids.add(e.id);
    why.push("the LaTeX editor: every latex example");
  }
  const known = new Set(examples.map((e) => e.id));
  for (const f of files) {
    const x = EXAMPLE_PATH.exec(f);
    if (x && known.has(`${x[1]}/${x[2]}`)) ids.add(`${x[1]}/${x[2]}`);
  }
  if (files.some((f) => EXAMPLE_PATH.test(f))) why.push("the examples changed");
  return { ids: [...ids].sort(), reason: why.join("; ") || "none" };
}

/** The matrix size for n selected examples: no shard runs more than SHARD_MAX; too many is refused. */
export function shardCount(n) {
  if (!Number.isSafeInteger(n) || n < 0)
    throw new Error(`shardCount: ${n} is not a count`);
  if (n > SHARD_MAX * MATRIX_MAX)
    throw new Error(
      `${n} examples selected: more than ${SHARD_MAX * MATRIX_MAX} (${MATRIX_MAX} shards of ${SHARD_MAX}), GitHub's matrix limit`,
    );
  return Math.ceil(n / SHARD_MAX);
}

/** Shard k (1-based) of n: the sorted ids at positions i with i mod n == k - 1. */
export function shardIds(ids, k, n) {
  const sorted = [...ids].sort();
  return sorted.filter((_, i) => i % n === k - 1);
}

/** Why the shards' ran lists don't add up to the selection exactly once (empty when they do). */
export function census(selected, ranLists) {
  const p = [];
  const seen = new Map();
  for (const list of ranLists)
    for (const id of list) seen.set(id, (seen.get(id) ?? 0) + 1);
  for (const id of selected)
    if (!seen.has(id)) p.push(`${id}: selected but never ran`);
  for (const [id, n] of seen) {
    if (!selected.includes(id)) p.push(`${id}: ran but wasn't selected`);
    else if (n > 1) p.push(`${id}: ran ${n} times`);
  }
  for (const [i, list] of ranLists.entries())
    if (list.length > SHARD_MAX)
      p.push(
        `shard ${i + 1} ran ${list.length} examples, more than ${SHARD_MAX}`,
      );
  return p;
}

/** A relative path's problems (A1): segments, no dot segments or separators in disguise, depth. */
export function pathProblem(p) {
  if (typeof p !== "string" || p === "") return "not a path";
  if (p !== p.normalize("NFC")) return "not NFC";
  if (/^[/\\]/.test(p) || p.includes("\\") || /%[0-9a-f]{2}/i.test(p))
    return "absolute, a backslash or an escape";
  const segs = p.split("/");
  if (segs.length > LIMITS.depth) return `deeper than ${LIMITS.depth}`;
  for (const s of segs)
    if (!SEGMENT.test(s) || s === "." || s === ".." || s.startsWith("."))
      return `segment ${JSON.stringify(s)}`;
  return null;
}

const MAIN = {
  notebook: /\.ipynb$/,
  board: /\.(board\.json|json|md)$/,
  latex: /\.tex$/,
};
const COMMON = [
  "title",
  "summary",
  "tags",
  "level",
  "main",
  "files",
  "author",
  "license",
];

/** A manifest's problems against the schema (conditional by kind), the files really in its folder and the tag list. */
export function manifestProblems(m, kind, present, tags) {
  const p = [];
  if (!m || typeof m !== "object" || Array.isArray(m))
    return ["example.json is not an object"];
  const allowed = new Set([
    ...COMMON,
    ...(kind === "notebook"
      ? ["mode", "expect", "loose"]
      : kind === "board"
        ? ["modes"]
        : ["features"]),
  ]);
  for (const k of Object.keys(m))
    if (!allowed.has(k)) p.push(`unknown field ${JSON.stringify(k)}`);
  for (const k of COMMON) if (!(k in m)) p.push(`missing ${k}`);
  if (
    typeof m.title !== "string" ||
    !m.title.trim() ||
    m.title.length > LIMITS.title
  )
    p.push(`title: 1 to ${LIMITS.title} characters`);
  if (
    typeof m.summary !== "string" ||
    !m.summary.trim() ||
    m.summary.length > LIMITS.summary
  )
    p.push(`summary: 1 to ${LIMITS.summary} characters`);
  if (
    !Array.isArray(m.tags) ||
    !m.tags.length ||
    m.tags.some((t) => !tags.includes(t))
  )
    p.push("tags: one or more, from examples/tags.json");
  if (!LEVELS.includes(m.level)) p.push(`level: one of ${LEVELS.join(", ")}`);
  if (m.license !== "MIT") p.push("license: MIT");
  if (typeof m.author !== "string" || !m.author.trim())
    p.push("author: a name");
  if (kind === "notebook" && !MODES.includes(m.mode))
    p.push(`mode: one of ${MODES.join(", ")}`);
  if (
    kind === "board" &&
    m.modes !== undefined &&
    (!Array.isArray(m.modes) || m.modes.some((x) => !MODES.includes(x)))
  )
    p.push(`modes: from ${MODES.join(", ")}`);
  if (
    kind === "latex" &&
    m.features !== undefined &&
    (!Array.isArray(m.features) ||
      m.features.some((f) => !FEATURES.includes(f)))
  )
    p.push(`features: from ${FEATURES.join(", ")}`);
  if (!Array.isArray(m.files) || !m.files.length) p.push("files: a list");
  else {
    if (m.files.length > LIMITS.files) p.push(`files: at most ${LIMITS.files}`);
    const folded = new Set();
    for (const f of m.files) {
      const why = pathProblem(f);
      if (why) p.push(`files: ${JSON.stringify(f)}: ${why}`);
      const k = String(f).normalize("NFC").toLowerCase();
      if (folded.has(k))
        p.push(`files: ${JSON.stringify(f)} collides with another file`);
      folded.add(k);
    }
    for (const f of m.files)
      if (m.files.some((g) => g !== f && g.startsWith(f + "/")))
        p.push(`files: ${JSON.stringify(f)} is both a file and a folder`);
    if (!m.files.includes(m.main)) p.push("main: one of the files");
    else if (!MAIN[kind].test(m.main))
      p.push(`main: a ${MAIN[kind].source.replace(/\\|\$/g, "")} file`);
    // (the folder holds exactly the listed files, the manifest and, for latex, its committed preview)
    const extra = present.filter(
      (f) =>
        f !== "example.json" &&
        !(kind === "latex" && f === "preview.html") &&
        !m.files.includes(f),
    );
    for (const f of extra) p.push(`${f}: in the folder but not in files`);
    for (const f of m.files)
      if (!present.includes(f)) p.push(`${f}: listed but missing`);
  }
  if (kind === "notebook" && m.loose !== undefined) {
    if (!Array.isArray(m.loose)) p.push("loose: a list");
    else
      for (const l of m.loose)
        if (
          !l ||
          !Number.isInteger(l.cell) ||
          !Number.isInteger(l.output) ||
          l.compare !== "type-only" ||
          typeof l.why !== "string" ||
          !l.why.trim()
        )
          p.push(
            `loose: ${JSON.stringify(l)}: {cell, output, compare: "type-only", why}`,
          );
  }
  return p;
}

/** The files under dir, as relative paths with "/", sorted. */
export function folderFiles(dir) {
  const out = [];
  const walk = (d, pre) => {
    for (const n of readdirSync(d).sort()) {
      const full = join(d, n);
      if (statSync(full).isDirectory()) walk(full, pre + n + "/");
      else out.push(pre + n);
    }
  };
  walk(dir, "");
  return out;
}

/** files.json (A6): the listed files with their sizes and hashes, from the source bytes. */
export function filesJson(dir, m) {
  return {
    id: null,
    main: m.main,
    files: m.files.map((f) => {
      const b = readFileSync(join(dir, f));
      return {
        path: f,
        bytes: b.length,
        sha256: sha256(b),
        encoding: BINARY.test(f) ? "base64" : "utf-8",
      };
    }),
  };
}

/** An example's size problems (plan section 5). */
export function sizeProblems(dir, m) {
  const p = [];
  let total = 0;
  for (const f of m.files ?? []) {
    if (pathProblem(f) || !existsSync(join(dir, f))) continue;
    const n = statSync(join(dir, f)).size;
    total += n;
    if (n > LIMITS.file) p.push(`${f}: ${n} bytes, more than ${LIMITS.file}`);
  }
  if (total > LIMITS.total)
    p.push(`${total} bytes in all, more than ${LIMITS.total}`);
  return p;
}

// ---- SVG canonicalization (A5): ids renamed by order of appearance, a fixed list of nondeterministic
// attributes dropped. Numbers are never rounded: a moved point changes the hash.
// generated ids: Sagebrush's plots' own (sbclip1, sbgrad2: deterministic, renamed anyway), matplotlib-style
// clip paths (p and 8 or more hex digits), and a prefix with a separator and 6 or more hex digits
const GEN_ID =
  /^(?:sb[a-z]+[0-9]+|p[0-9a-f]{8,}|(?:clip|grad|pat|mask|glyph)[0-9a-f]{4,}|[A-Za-z]+[-_][0-9a-f]{6,})$/i;
const DROP = ["data-generated", "data-timestamp"];
export function svgCanon(svg) {
  const ids = new Map();
  for (const m of svg.matchAll(/\sid="([^"]+)"/g))
    if (GEN_ID.test(m[1]) && !ids.has(m[1])) ids.set(m[1], `i${ids.size + 1}`);
  let s = svg;
  for (const a of DROP) s = s.replace(new RegExp(`\\s${a}="[^"]*"`, "g"), "");
  if (ids.size) {
    const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(
      `(id="|href="#|url\\(#)(${[...ids.keys()].map(esc).join("|")})(?=[")])`,
      "g",
    );
    s = s.replace(re, (_, pre, id) => pre + ids.get(id));
  }
  return s;
}

// ---- a notebook's outputs, normalized (A5)
const text = (v) => (Array.isArray(v) ? v.join("") : String(v ?? ""));
/** One cell's outputs (Jupyter's shape) as the compared form; an error output is returned as {error}. */
export function normalizeOutputs(outputs, looseFor = () => false) {
  const out = [];
  for (const [i, o] of (outputs ?? []).entries()) {
    if (o.output_type === "error") return { error: `${o.ename}: ${o.evalue}` };
    if (looseFor(i)) {
      out.push({ loose: o.output_type === "stream" ? "stream" : "rich" });
      continue;
    }
    if (o.output_type === "stream") {
      const prev = out[out.length - 1];
      if (prev?.stream === o.name) prev.text += text(o.text);
      else out.push({ stream: o.name, text: text(o.text) });
      continue;
    }
    if (
      o.output_type === "execute_result" ||
      o.output_type === "display_data"
    ) {
      const data = {};
      for (const mime of Object.keys(o.data ?? {}).sort()) {
        const v = o.data[mime];
        if (mime === "image/png")
          data[mime] =
            "sha256:" +
            sha256(Buffer.from(text(v).replace(/\s+/g, ""), "base64"));
        else if (mime === "image/svg+xml")
          data[mime] = "sha256:" + sha256(svgCanon(text(v)));
        else if (mime.startsWith("text/")) data[mime] = text(v);
        else data[mime] = JSON.stringify(v);
      }
      out.push({ rich: data });
    }
  }
  return { outputs: out };
}

/** A notebook's normalized form: per code cell, its outputs; `loose` declarations from its manifest. */
export function normalizeNotebook(nb, loose = []) {
  const cells = (nb.cells ?? []).filter((c) => c.cell_type === "code");
  return cells.map((c, ci) => {
    const n = normalizeOutputs(c.outputs, (oi) =>
      loose.some((l) => l.cell === ci && l.output === oi),
    );
    return n.error ? { error: n.error } : n.outputs;
  });
}

/** Text an output must never hold (A5): the run's temporary folder, today's date, the host's name. */
export function leaks(nbNorm, { tmp, date, host }) {
  const s = JSON.stringify(nbNorm);
  return [
    tmp && s.includes(tmp) ? `the run's temporary folder (${tmp})` : null,
    date && s.includes(date) ? `today's date (${date})` : null,
    host && host.length > 3 && s.includes(host)
      ? `the host name (${host})`
      : null,
  ].filter(Boolean);
}
