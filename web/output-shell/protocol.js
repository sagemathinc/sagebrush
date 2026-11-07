// The isolated output renderer's channel (OUT-ISO plan r3, phase 1): one closed,
// versioned schema shared by the host (web/notebook/output-frames.js) and the
// renderer shell (web/output-shell/shell.js).  Every message is a JSON string on a
// MessagePort, and its length is checked BEFORE it is parsed (daybreak3's ruling:
// the message cap is on serialized size, before allocation or parse).  Unknown
// types and fields, wrong types, oversized values and non-finite numbers are
// refused: decode returns null, and the receiver ignores the message.
//
// host -> frame:  render {generation, area, outputs: [{id, kind, body}]}, theme {theme}, dispose {}
// frame -> host:  ready {}, committed {generation, area, ids, height}, height {generation, height}, error {generation, reason}
//
// The bounds below are phase-1 measurement candidates, not approved defaults
// (astra, Nov 7): they are frozen, with their provenance, from the 50/200-area
// measurements before rich rendering is enabled.
export const VERSION = 1;
export const BOUNDS = Object.freeze({
  messageChars: 4 * 1024 * 1024, // (one message, serialized: its UTF-16 length, checked before JSON.parse)
  outputsPerRender: 64, // (the outputs of one cell area)
  idChars: 64,
  heightPx: 32768, // (a reported height: larger is refused)
  reasonChars: 200,
});
// (a render's output kinds: what the shell knows how to draw; phase 1 migrates no MIME)
export const KINDS = Object.freeze(["html", "svg", "text"]);
export const THEMES = Object.freeze(["light", "dark", "contrast"]);

const SHAPES = {
  "to-frame": {
    render: { generation: "gen", area: "id", outputs: "outputs" },
    theme: { theme: "theme" },
    dispose: {},
  },
  "to-host": {
    ready: {},
    committed: { generation: "gen", area: "id", ids: "ids", height: "height" },
    height: { generation: "gen", height: "height" },
    error: { generation: "gen", reason: "reason" },
  },
};

const isId = (v) => typeof v === "string" && v.length > 0 && v.length <= BOUNDS.idChars && /^[A-Za-z0-9_.:-]+$/.test(v);
const CHECK = {
  gen: (v) => Number.isSafeInteger(v) && v >= 0,
  id: isId,
  ids: (v) => Array.isArray(v) && v.length <= BOUNDS.outputsPerRender && v.every(isId) && new Set(v).size === v.length,
  height: (v) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= BOUNDS.heightPx,
  reason: (v) => typeof v === "string" && v.length <= BOUNDS.reasonChars,
  theme: (v) => THEMES.includes(v),
  outputs: (v) => Array.isArray(v) && v.length <= BOUNDS.outputsPerRender && new Set(v.map((o) => o?.id)).size === v.length &&
    v.every((o) => o && typeof o === "object" && !Array.isArray(o) && Object.keys(o).length === 3 && isId(o.id) && KINDS.includes(o.kind) && typeof o.body === "string"),
};

/** A message for `dir` ("to-frame" | "to-host"), as the string to post; throws if the schema doesn't allow it. */
export function encode(dir, type, fields = {}) {
  const m = { v: VERSION, type, ...fields };
  if (!valid(dir, m)) throw new Error(`not a valid ${dir} ${type} message`);
  const s = JSON.stringify(m);
  if (s.length > BOUNDS.messageChars) throw new Error(`a ${type} message over ${BOUNDS.messageChars} characters`);
  return s;
}

/** The message `data` carries for `dir`, or null: not a string within the cap, not JSON, or not in the schema. */
export function decode(dir, data) {
  if (typeof data !== "string" || data.length > BOUNDS.messageChars) return null; // (before any parse)
  let m;
  try { m = JSON.parse(data); } catch { return null; }
  return valid(dir, m) ? m : null;
}

function valid(dir, m) {
  if (!m || typeof m !== "object" || Array.isArray(m) || m.v !== VERSION) return false;
  const shape = Object.hasOwn(SHAPES, dir) && Object.hasOwn(SHAPES[dir], m.type) ? SHAPES[dir][m.type] : null;
  if (!shape) return false;
  const keys = Object.keys(m).filter((k) => k !== "v" && k !== "type");
  if (keys.length !== Object.keys(shape).length) return false;
  return keys.every((k) => Object.hasOwn(shape, k) && CHECK[shape[k]](m[k]));
}
