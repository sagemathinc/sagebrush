// Whether a file is a Jupytext MyST notebook (isMystHead), from its first 4096
// bytes alone, and the closed front-matter grammar that decides it: a module
// that imports nothing, so a page that only needs the decision (the board page's
// uploads and its "Open as a board": plan-myst-notebooks-p2 r2 §11.3) takes this
// and not the reader (web/notebook/myst.js, which re-exports it).
//
// A file is MyST if (isMystHead), judged from its first 4096 bytes alone (its
// UTF-8 bytes, cut before decoding: what the file browser reads, so the menu and
// the conversion always agree): its first line is exactly "---", the front
// matter's closing "---" line ends within those bytes, and the front matter has
// jupytext.text_representation.format_name: myst.  CRLF is read as LF (a
// textarea can't keep it anyway); a byte-order mark makes it not MyST.  A file of
// exactly 4096 bytes whose closing "---" has no newline after it isn't MyST: a
// head that long may be cut from a longer file (agents-ui's N-3, kept).  The
// front matter is read by a closed grammar (nested "key: value" maps, nothing
// else: no anchors, aliases, tags or flow collections), so nothing in it can do
// anything; what it doesn't understand is kept as text.

export const HEAD_BYTES = 4096;
// (a byte-order mark kept, not stripped: every decoder of a head or a .md does the same: TEXT)
const enc = new TextEncoder(), dec = new TextDecoder("utf-8", { ignoreBOM: true });
/** How a MyST head or file's bytes are decoded, wherever they are: UTF-8, a byte-order mark kept. */
export const TEXT = { encoding: "utf-8", ignoreBOM: true };

/** Whether a file is a Jupytext MyST notebook, from its text (the whole file, or its first HEAD_BYTES bytes
 * decoded): only its first HEAD_BYTES UTF-8 bytes are looked at, so either gives the same answer. */
export function isMystHead(text) {
  const t = String(text ?? "");
  // (at most HEAD_BYTES + 1 code units hold the first HEAD_BYTES bytes: each is at least one byte)
  const some = t.slice(0, HEAD_BYTES + 1), bytes = enc.encode(some);
  // (whole: the file is shorter than a head; text of exactly HEAD_BYTES bytes may be a head cut from a longer file,
  //  so it is judged as one: its closing line must end with its newline there, either way the same answer)
  const whole = some.length === t.length && bytes.length < HEAD_BYTES;
  // (a CR as the head's last byte is half of a CRLF cut by it, not a line's end)
  let raw = dec.decode(bytes.subarray(0, HEAD_BYTES));
  if (!whole && raw.endsWith("\r")) raw = raw.slice(0, -1);
  const head = lf(raw);
  const fm = frontMatter(head);
  // (its closing line ended inside the head: a newline after it there, or the file is no longer than the head)
  return !!fm && (whole || head[fm.end - 1] === "\n") && fm.data?.jupytext?.text_representation?.format_name === "myst";
}

export const lf = (s) => s.replace(/\r\n?/g, "\n");

// The front matter: its text, where the body starts, and its closed parse (or null)
export function frontMatter(t) {
  if (!t.startsWith("---\n")) return null;
  const close = /^---[ \t]*$/m;
  const rest = t.slice(4);
  const m = close.exec(rest);
  if (!m) return null;
  const yaml = rest.slice(0, m.index);
  let end = 4 + m.index + m[0].length;
  if (t[end] === "\n") end++;
  return { yaml, end, data: closedYaml(yaml) };
}

// Nested "key: value" maps by indentation; a value is a plain or quoted scalar.
// Anything else (lists, flow collections, anchors, aliases, tags, multi-line
// scalars) is not understood: that key's value is null.  Never throws.
export function closedYaml(src) {
  const root = Object.create(null);
  const stack = [{ indent: -1, obj: root }];
  for (const line of src.split("\n")) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const m = /^( *)([A-Za-z0-9_.-]+):(?:[ \t]+(.*?))?[ \t]*$/.exec(line);
    if (!m) continue;
    const indent = m[1].length;
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
    const parent = stack[stack.length - 1].obj;
    if (!parent) continue;
    const key = m[2], raw = m[3];
    if (raw === undefined || raw === "") {
      const child = Object.create(null);
      parent[key] = child;
      stack.push({ indent, obj: child });
    } else {
      parent[key] = scalar(raw);
      stack.push({ indent, obj: null });
    }
  }
  return root;
}
function scalar(raw) {
  if (/^[&*!|>[{]/.test(raw)) return null;
  const q = /^"((?:[^"\\]|\\.)*)"$|^'((?:[^']|'')*)'$/.exec(raw);
  if (q) return q[1] !== undefined ? q[1].replace(/\\(.)/g, "$1") : q[2].replace(/''/g, "'");
  return raw.replace(/\s+#.*$/, "");
}
