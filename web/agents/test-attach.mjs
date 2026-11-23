// ci: web-runner order=178 runner=bun
// An image pasted or dropped into the agents page's composer (attach.ts, #1791 step 2), with a stand-in host: which
// files are saved (PNG, JPEG, GIF and WebP by their bytes, at most IMAGE_BYTES_MAX), where (the chat's own folder, a
// random name, the real type's extension), what the draft gets (the path), and what is said when it can't be.
//   bun web/agents/test-attach.mjs
import { attach, attachFolder, ATTACH_COPY, ATTACH_MAX, ATTACH_ROOT } from "./attach.ts";
import { IMAGE_BYTES_MAX } from "../workspace/agent-pair.ts";

let failures = 0;
const ok = (c, msg, detail) => { console.log((c ? "ok   " : "FAIL ") + msg + (!c && detail !== undefined ? "  " + JSON.stringify(detail).slice(0, 600) : "")); if (!c) failures++; };

const ascii = (s) => [...s].map((c) => c.charCodeAt(0));
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const bytes = (head, n = 64) => { const u = new Uint8Array(n).fill(7); u.set(head); return u; };
const file = (u, name = "x.png", type = "image/png") => new File([u], name, { type });
function host({ agent = null, create = true, fail = null } = {}) {
  const H = { made: [], lines: [], toasts: [], reads: [] };
  H.create = create ? async (path, u) => { if (fail) throw fail; if (H.made.some((m) => m.path === path)) throw new Error(`${path} is there already`); H.made.push({ path, u: new Uint8Array(u) }); } : null;
  H.append = (conv, line) => H.lines.push({ conv, line });
  H.agent = () => agent && { name: agent.name, reads: (p) => (H.reads.push(p), agent.reads(p)) };
  H.toast = (t) => H.toasts.push(t);
  H.conversation = () => "c1";
  return H;
}

// ---- each type, by its bytes: saved in the chat's folder under a random name with the real type's extension
{
  const H = host();
  const kinds = [[PNG, "png"], [[0xff, 0xd8, 0xff, 0xe0], "jpg"], [ascii("GIF87a"), "gif"], [ascii("GIF89a"), "gif"], [[...ascii("RIFF"), 1, 2, 3, 4, ...ascii("WEBP")], "webp"]];
  // (each named as another type: the name says nothing)
  await attach(H, "abc123", kinds.map(([h]) => file(bytes(h), "photo.bmp", "image/bmp")));
  const re = new RegExp(`^${ATTACH_ROOT}/abc123/[0-9a-f]{24}\\.(png|jpg|gif|webp)$`);
  ok(H.made.length === 5 && H.made.every((m, i) => re.test(m.path) && m.path.endsWith("." + kinds[i][1])), "PNG, JPEG, GIF87a, GIF89a and WebP: each saved in /Attachments/<chat>/, a random 24-hex name, the extension of its bytes' type", H.made.map((m) => m.path));
  ok(H.made.every((m, i) => m.u.length === 64 && kinds[i][0].every((b, j) => m.u[j] === b)), "…with the file's own bytes");
  ok(new Set(H.made.map((m) => m.path)).size === 5, "…every name a new one");
  ok(H.lines.length === 5 && H.lines.every((l, i) => l.conv === "abc123" && l.line === ATTACH_COPY.line(H.made[i].path)) && H.lines[0].line === "Image: `" + H.made[0].path + "`", "each saved image's path goes into that chat's draft, as `Image: <path>` (code: nothing fetched)", H.lines);
  ok(H.toasts.length === 0, "nothing to say when all is well (no agent paired)", H.toasts);
}
// ---- what isn't an image, or is too big: not saved, and said
{
  const H = host();
  await attach(H, "c1", [file(new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>"), "a.svg", "image/svg+xml"), file(bytes([...ascii("RIFF"), 1, 2, 3, 4, ...ascii("WAVE")]), "a.webp", "image/webp"), file(bytes(PNG.slice(0, 7)), "a.png")]);
  ok(H.made.length === 0 && H.lines.length === 0 && H.toasts.length === 3 && H.toasts.every((t) => t === ATTACH_COPY.notImage), "SVG, RIFF that isn't WebP, a cut PNG signature: not saved, each said", H.toasts);
  const H2 = host();
  await attach(H2, "c1", [file(bytes(PNG, IMAGE_BYTES_MAX)), file(bytes(PNG, IMAGE_BYTES_MAX + 1))]);
  ok(H2.made.length === 1 && H2.made[0].u.length === IMAGE_BYTES_MAX && H2.toasts.length === 1 && H2.toasts[0] === ATTACH_COPY.tooBig(IMAGE_BYTES_MAX + 1) && /3\.8 MB.*at most 3\.75 MB/.test(H2.toasts[0]), "exactly 3,750,000 bytes is saved; one byte more is refused, with its size and the most there can be", H2.toasts);
  // (the size from the file itself, before it is read: a file that says it is too big is never read)
  let read = false;
  const big = { size: IMAGE_BYTES_MAX + 1, arrayBuffer: async () => { read = true; return bytes(PNG).buffer; } };
  const H3 = host();
  await attach(H3, "c1", [big]);
  ok(!read && H3.made.length === 0 && H3.toasts[0] === ATTACH_COPY.tooBig(IMAGE_BYTES_MAX + 1), "a file over the cap is refused before it is read");
  // (a file whose bytes come out bigger than it said: refused all the same)
  const liar = { size: 10, arrayBuffer: async () => bytes(PNG, IMAGE_BYTES_MAX + 1).buffer };
  const H4 = host();
  await attach(H4, "c1", [liar]);
  ok(H4.made.length === 0 && H4.toasts[0] === ATTACH_COPY.tooBig(IMAGE_BYTES_MAX + 1), "bytes over the cap, whatever the file said its size was: refused");
  const H5 = host();
  await attach(H5, "c1", [{ size: 10, arrayBuffer: async () => { throw new Error("NotReadableError: secret/path/x.png"); } }, file(bytes(PNG))]);
  ok(H5.made.length === 1 && H5.toasts[0] === ATTACH_COPY.failed(ATTACH_COPY.why.read) && !H5.toasts[0].includes("secret"), "a file that can't be read: said in the page's words, not the error's; the next one is still saved", H5.toasts);
}
// ---- how many at once, the chat's folder, the workspace
{
  const H = host();
  await attach(H, "c1", Array.from({ length: ATTACH_MAX + 1 }, () => file(bytes(PNG))));
  ok(H.made.length === 0 && H.toasts[0] === ATTACH_COPY.tooMany, `more than ${ATTACH_MAX} at once: none saved, and said`, H.toasts);
  const H2 = host();
  await attach(H2, "c1", Array.from({ length: ATTACH_MAX }, () => file(bytes(PNG))));
  ok(H2.made.length === ATTACH_MAX, `${ATTACH_MAX} at once: all saved`);
  ok(attachFolder("abc_-9Z") === "/Attachments/abc_-9Z" && attachFolder("../x") === null && attachFolder("a/b") === null && attachFolder("") === null && attachFolder("a".repeat(65)) === null && attachFolder("a b") === null, "a chat's folder only from an id that is a plain name (no /, .., spaces; at most 64)");
  const H3 = host();
  await attach(H3, "../etc", [file(bytes(PNG))]);
  ok(H3.made.length === 0 && H3.toasts[0] === ATTACH_COPY.noWorkspace, "a chat whose id isn't a plain name: nothing saved");
  const H4 = host({ create: false });
  await attach(H4, "c1", [file(bytes(PNG))]);
  ok(H4.made.length === 0 && H4.lines.length === 0 && H4.toasts[0] === ATTACH_COPY.noWorkspace, "no workspace open: nothing saved, nothing in the draft, said");
  const said = [];
  for (const code of ["exists", "limit", "storage", "read", "other", "toString", "__proto__", undefined]) {
    const H5 = host({ fail: Object.assign(new Error("iVBORw0KGgo secret text"), code === undefined ? {} : { code }) });
    await attach(H5, "c1", [file(bytes(PNG))]);
    said.push(H5.lines.length === 0 && H5.toasts.length === 1 ? H5.toasts[0] : "BAD");
  }
  const W = ATTACH_COPY.why;
  ok(JSON.stringify(said) === JSON.stringify([W.exists, W.limit, W.storage, W.other, W.other, W.other, W.other, W.other].map(ATTACH_COPY.failed)), "a create the workspace refuses: nothing in the draft; its reason said by its code (exists, limit, storage), anything else one fixed sentence; never the error's own text", said);
}
// ---- the paired agent's access: said when it can't read the folder
{
  const H = host({ agent: { name: "Claude", reads: (p) => p.startsWith("/Attachments/") } });
  await attach(H, "c1", [file(bytes(PNG))]);
  ok(H.toasts.length === 0 && H.reads.length === 1 && H.reads[0] === H.made[0].path, "an agent whose access includes the image's path: nothing to say");
  const H2 = host({ agent: { name: "Claude", reads: () => false } });
  await attach(H2, "c1", [file(bytes(PNG))]);
  ok(H2.made.length === 1 && H2.lines.length === 1 && H2.toasts[0] === ATTACH_COPY.outside("Claude") && /Claude can't read \/Attachments/.test(H2.toasts[0]), "an agent whose access doesn't include it: saved, the path in the draft, and said that it can't read it", H2.toasts);
}

console.log(failures ? `${failures} FAILED` : "test-attach: all passed");
process.exit(failures ? 1 : 0);
