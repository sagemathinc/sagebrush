// ci: web-runner order=200 runner=bun
// A board's copy and its pictures (board-pictures.ts copyBoardPictures): each picture file copied to the copy's
// folder; one that can't be (its read fails, the copy's create is refused or throws) offered to `keep` with its bytes
// when they were read, and reported when neither copied nor kept, so the caller can tell the person; a picture that
// was never a file isn't one.
//   bun web/workspace/test-board-pictures-copy.mjs
import { copyBoardPictures } from "./board-pictures.ts";

let failures = 0;
const J = JSON.stringify;
const ok = (c, msg, detail) => { console.log((c ? "ok   " : "FAIL ") + msg + (!c && detail !== undefined ? "  " + J(detail).slice(0, 600) : "")); if (!c) failures++; };
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const png = (fill) => { const u = new Uint8Array(64).fill(fill); u.set(PNG); return u; };
const A = "/Attachments/board-a", B = "/Attachments/board-b";
/** a stand-in workspace: the source board's two picture files; `failRead`, paths whose read fails */
function ws(failRead = new Set()) {
  const files = new Map([[`${A}/ione.png`, png(1)], [`${A}/itwo.png`, png(2)]]);
  return {
    files,
    list: async (folder) => [...files.keys()].filter((p) => p.startsWith(folder + "/")).map((path) => ({ path, kind: "file" })),
    readUpTo: async (p) => { if (failRead.has(p) || !files.has(p)) throw new Error("not readable"); return { content: files.get(p) }; },
    createByPerson: async () => { throw new Error("not used"); },
  };
}
const creator = (w, refuse = () => false) => async (p, u) => {
  if (refuse(p)) throw Object.assign(new Error("refused by the workspace"), { code: "admit" });
  if (w.files.has(p)) throw Object.assign(new Error("there"), { code: "exists" });
  w.files.set(p, new Uint8Array(u));
};
const names = ["ione", "itwo", "ibrowser"];

{
  const w = ws();
  const lost = await copyBoardPictures(w, "a", "b", names, creator(w));
  ok(J(lost) === "[]" && w.files.has(`${B}/ione.png`) && w.files.has(`${B}/itwo.png`), "every picture file copied to the copy's folder; one never a file (kept in a browser) isn't reported", lost);
}
{
  const w = ws();
  const lost = await copyBoardPictures(w, "a", "b", names, creator(w, (p) => p.startsWith(B)));
  ok(J(lost.sort()) === J(["ione", "itwo"]) && ![...w.files.keys()].some((p) => p.startsWith(B)), "the copy's creates refused, nothing to keep them: both reported", lost);
}
{
  const w = ws(), kept = new Map();
  const lost = await copyBoardPictures(w, "a", "b", names, creator(w, (p) => p.startsWith(B)), async (n, u) => (kept.set(n, u), true));
  ok(J(lost) === "[]" && kept.size === 2 && kept.get("ione")?.[8] === 1 && kept.get("itwo")?.[8] === 2, "refused, then kept (this browser): none reported, each kept with its own bytes", [...kept.keys()]);
}
{
  const w = ws();
  const lost = await copyBoardPictures(w, "a", "b", names, creator(w, (p) => p.startsWith(B)), async () => false);
  ok(J(lost.sort()) === J(["ione", "itwo"]), "refused and not kept: reported", lost);
}
{
  const w = ws(new Set([`${A}/itwo.png`])), kept = [];
  const lost = await copyBoardPictures(w, "a", "b", names, creator(w), async (n) => (kept.push(n), true));
  ok(J(lost) === J(["itwo"]) && J(kept) === "[]" && w.files.has(`${B}/ione.png`), "a source that can't be read: reported (no bytes to keep), the others copied", { lost, kept });
}
{
  const w = ws();
  const lost = await copyBoardPictures(w, "a", "b", names, async () => { throw new TypeError("a save that threw"); });
  ok(J(lost.sort()) === J(["ione", "itwo"]), "a create that throws anything: reported, never taken as copied", lost);
}

console.log(failures ? `${failures} FAILED` : "test-board-pictures-copy: all passed");
process.exit(failures ? 1 : 0);
