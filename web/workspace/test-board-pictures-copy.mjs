// ci: web-runner order=200 runner=bun
// A board's copy and its pictures (board-pictures.ts copyBoardPictures): each picture file copied to the copy's
// folder; one that can't be (its read fails, the copy's create is refused or throws) offered to `keep` with its bytes
// when they were read (null when there are none: never a file, unreadable), and reported when neither copied nor kept,
// so the caller can tell the person: every name asked for is one of the three.
//   bun web/workspace/test-board-pictures-copy.mjs
import { copyBoardPictures, filePictureNames, pictureFilesOf } from "./board-pictures.ts";

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
    list: async (folder) => [...files.keys()].filter((p) => p.startsWith(folder + "/")).map((path) => ({ path, kind: "file", size: files.get(path).length })),
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
  ok(J(lost) === J(["ibrowser"]) && w.files.has(`${B}/ione.png`) && w.files.has(`${B}/itwo.png`), "every picture file copied to the copy's folder; a name with no file and nothing to keep it: reported", lost);
  const w2 = ws(), asked = [];
  const lost2 = await copyBoardPictures(w2, "a", "b", names, creator(w2), async (n, u) => (asked.push([n, u]), u === null));
  ok(J(lost2) === "[]" && asked.length === 1 && asked[0][0] === "ibrowser" && asked[0][1] === null, "a name with no file is offered to keep with no bytes; kept (a browser that has it), not reported", asked);
  ok(J((await pictureFilesOf(ws(), "a", names)).map((f) => [f.name, f.size])) === J([["ione", 64], ["itwo", 64]]), "the picture files a copy copies, with their sizes, for the caller to charge first");
}
{
  const w = ws();
  const lost = await copyBoardPictures(w, "a", "b", names, creator(w, (p) => p.startsWith(B)));
  ok(J(lost.sort()) === J(["ibrowser", "ione", "itwo"]) && ![...w.files.keys()].some((p) => p.startsWith(B)), "the copy's creates refused, nothing to keep them: all reported", lost);
}
{
  const w = ws(), kept = new Map();
  const lost = await copyBoardPictures(w, "a", "b", names, creator(w, (p) => p.startsWith(B)), async (n, u) => (kept.set(n, u), u !== null));
  ok(J(lost) === J(["ibrowser"]) && kept.get("ione")?.[8] === 1 && kept.get("itwo")?.[8] === 2, "refused, then kept (this browser): those not reported, each kept with its own bytes", [...kept.keys()]);
}
{
  const w = ws();
  const lost = await copyBoardPictures(w, "a", "b", names, creator(w, (p) => p.startsWith(B)), async () => false);
  ok(J(lost.sort()) === J(["ibrowser", "ione", "itwo"]), "refused and not kept: reported", lost);
}
{
  const w = ws(new Set([`${A}/itwo.png`])), kept = [];
  const lost = await copyBoardPictures(w, "a", "b", names, creator(w), async (n, u) => (kept.push(n), u !== null));
  ok(J(lost.sort()) === J(["ibrowser", "itwo"]) && J(kept.sort()) === J(["ibrowser", "itwo"]) && w.files.has(`${B}/ione.png`), "a source that can't be read: offered with no bytes, not kept, reported; the others copied", { lost, kept });
}
{
  const w = ws();
  const lost = await copyBoardPictures(w, "a", "b", names, async () => { throw new TypeError("a save that threw"); });
  ok(J(lost.sort()) === J(["ibrowser", "ione", "itwo"]), "a create that throws anything: reported, never taken as copied", lost);
}

{
  // the source folder can't be listed: no picture is known to be a file, so every name asked for is reported
  const w = ws();
  w.list = async () => { throw new Error("listing failed"); };
  const lost = await copyBoardPictures(w, "a", "b", names, creator(w));
  ok(J(lost.sort()) === J(["ibrowser", "ione", "itwo"]) && ![...w.files.keys()].some((p) => p.startsWith(B)), "a source folder that can't be listed: every name reported, nothing copied", lost);
}

{
  // the names a board's files hold: not a picture with its own source (an https: address, embedded data)
  ok(J(filePictureNames({ ia: { w: 1, h: 1 }, ib: { w: 1, h: 1, src: "https://example.com/b.png" }, ic: { src: "data:image/png;base64,AA==" }, id: { src: "" } })) === J(["ia", "id"]) && J(filePictureNames(null)) === "[]" && J(filePictureNames([1])) === "[]",
    "the file pictures: those without a source of their own");
}
{
  // held to what was measured (the shell's): only those files, each as it was; one changed since, stale, thrown
  const w = ws();
  const files = await pictureFilesOf(w, "a", ["ione", "itwo"]);
  w.files.set(`${A}/itwo.png`, png(9).slice(0, 40));
  let thrown = null;
  try { await copyBoardPictures(w, "a", "b", ["ione", "itwo"], creator(w), undefined, { expect: files, stale: (p) => new Error("stale " + p) }); } catch (e) { thrown = e; }
  ok(thrown?.message === `stale ${A}/itwo.png`, "a picture changed since it was measured: the caller's stale error thrown", String(thrown));
  const w2 = ws();
  const lost = await copyBoardPictures(w2, "a", "b", ["ione", "itwo"], creator(w2), undefined, { expect: (await pictureFilesOf(w2, "a", ["ione"])) });
  ok(J(lost) === J(["itwo"]) && !w2.files.has(`${B}/itwo.png`) && w2.files.has(`${B}/ione.png`), "a file not measured isn't copied (it wasn't charged): reported", lost);
}
{
  // the caller's own refusal at a picture's create (a limit, a revoked grant): thrown as it is, not a lost picture
  const w = ws(), no = new Error("limit hit");
  let stop = null, thrown = null;
  try { await copyBoardPictures(w, "a", "b", ["ione", "itwo"], async () => { stop = no; throw no; }, undefined, { stopped: () => stop }); } catch (e) { thrown = e; }
  ok(thrown === no && ![...w.files.keys()].some((p) => p.startsWith(B)), "the caller's refusal at the first picture: thrown as it is, nothing more copied", String(thrown));
}

console.log(failures ? `${failures} FAILED` : "test-board-pictures-copy: all passed");
process.exit(failures ? 1 : 0);
