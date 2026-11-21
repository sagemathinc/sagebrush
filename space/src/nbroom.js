// A notebook's room: its cells as objects (code with its output as the notebook last showed it, and its text cells as
// notes), linked by what flows between them: a cell that defines a name, to each later cell that reads it (the
// notebook's own dependencies, read from a real parse of each cell; Python and Sage).  Laid out as a room is
// (roomlayout.js): the cells that only define stand at the top, what reads them below.  A text cell is linked to the
// code cell after it, so it stands beside what it explains.
//   notebookRoom({ mode, cells }, { path })  -> a sagebrush-space
import { cellNames } from "./pyroom.js";
import { layered } from "./roomlayout.js";
import { SCENE } from "./run.js";
const joinText = (t) => (Array.isArray(t) ? t.join("") : String(t ?? ""));
// (a cell's outputs as an object keeps them: its text, an error, its last figure, a 3D scene)
function outputsOf(outs) {
  const r = { output: "", outputError: false, svg: null, png: null, scene: null };
  for (const o of outs ?? []) {
    if (o?.output_type === "stream") r.output += joinText(o.text);
    else if (o?.output_type === "error") {
      const tb = Array.isArray(o.traceback) && o.traceback.length ? o.traceback.map(String) : [`${o.ename ?? "Error"}: ${o.evalue ?? ""}`];
      r.output += tb.join("\n").replace(/\x1b\[[0-9;]*m/g, "") + "\n";
      r.outputError = true;
    }
    else if (o?.data) {
      const d = o.data;
      if (d[SCENE]) { try { r.scene = typeof d[SCENE] === "string" ? JSON.parse(d[SCENE]) : d[SCENE]; } catch {} }
      else if (d["image/svg+xml"]) r.svg = joinText(d["image/svg+xml"]);
      else if (d["image/png"]) r.png = joinText(d["image/png"]).replace(/\s+/g, "");
      else if (d["text/plain"]) r.output += joinText(d["text/plain"]) + "\n";
    }
  }
  r.output = r.output.replace(/\s+$/, "");
  return r;
}
const firstLine = (code) => (String(code).split("\n").find((l) => l.trim() && !/^\s*#/.test(l)) ?? String(code).split("\n")[0] ?? "").trim();

export function notebookRoom(nb, { path = "" } = {}) {
  const mode = String(nb.mode ?? "python"), parses = mode === "python" || mode === "sage";
  const nodes = [], edges = [], definer = new Map(); // (a name -> the last cell so far that defines it)
  let n = 0, pendingNote = null;
  const used = new Set();
  (Array.isArray(nb.cells) ? nb.cells : []).forEach((c, k) => {
    if (!c || typeof c !== "object") return;
    // (its id, unless another cell has it too: then its place as well)
    let id = "cell:" + String(c.id ?? k);
    if (c.id === undefined || c.id === null || used.has(id)) id = `cell:${k}:${c.id ?? ""}`;
    used.add(id);
    if (c.type === "markdown" || c.type === "raw") {
      const text = String(c.code ?? "");
      if (!text.trim()) return;
      const title = (text.split("\n").find((l) => l.trim()) ?? "").replace(/^#+\s*/, "").slice(0, 60);
      nodes.push({ id, kind: "note", title: title || "(text)", text, group: "text", order: k });
      pendingNote = id;
      return;
    }
    n++;
    const code = String(c.code ?? "");
    const names = parses ? cellNames(code, { sage: mode === "sage" }) : null;
    const first = firstLine(code);
    const nd = { id, kind: "code", cell: true, lang: mode, title: `[${n}] ${first.length > 48 ? first.slice(0, 45) + "…" : first || "(empty)"}`,
      text: code, lines: code.split("\n").length, group: "cells", order: k, names: names?.defs ?? [], ...outputsOf(c.outputs) };
    if (!nd.output) delete nd.output;
    if (names) {
      // (each name it reads, from the cell that last defined it before: the notebook's dependency)
      const from = new Map();
      for (const u of names.uses) { const d = definer.get(u); if (d) (from.get(d) ?? from.set(d, []).get(d)).push(u); }
      for (const [d, vars] of from) edges.push({ from: d, to: id, kind: "uses", vars });
      for (const d of names.defs) definer.set(d, id);
      if (!names.uses.length && !names.defs.length) nd.summary = null;
    } else if (parses) nd.summary = "This cell doesn't parse: its links are unknown.";
    if (pendingNote) { edges.push({ from: pendingNote, to: id, kind: "explains" }); pendingNote = null; }
    nodes.push(nd);
  });
  // (a link's names, said on the cell it reaches: "uses x, y from [2]")
  const byId = new Map(nodes.map((x) => [x.id, x]));
  for (const nd of nodes) {
    if (nd.kind !== "code") continue;
    const ins = edges.filter((e) => e.to === nd.id && e.vars);
    const outs = edges.filter((e) => e.from === nd.id && e.vars);
    const parts = [];
    if (nd.names.length) parts.push(`Defines ${nd.names.slice(0, 6).join(", ")}${nd.names.length > 6 ? ", …" : ""}.`);
    if (ins.length) parts.push(`Uses ${ins.map((e) => `${e.vars.slice(0, 4).join(", ")} from ${byId.get(e.from).title.split(" ")[0]}`).join("; ")}.`);
    if (outs.length) parts.push(`Read by ${outs.map((e) => byId.get(e.to).title.split(" ")[0]).join(", ")}.`);
    if (parts.length && nd.summary === undefined) nd.summary = parts.join(" ");
    if (nd.summary === null) delete nd.summary;
  }
  for (const nd of nodes) if (!edges.some((e) => e.from === nd.id || e.to === nd.id)) nd.shelf = true;
  layered(nodes, edges);
  for (const nd of nodes) if (nd.shelf) nd.group = "not linked here";
  const cells = nodes.filter((x) => x.kind === "code").length;
  return {
    format: "sagebrush-space", version: 1, title: path || "a notebook",
    summary: `${cells} code cell${cells === 1 ? "" : "s"} (${mode})${parses ? ", linked by the names that flow from one to another" : ": links come from a parse, which this language doesn't have here yet"}.`,
    room: { kind: "notebook", path, lang: mode, labels: ["not linked here"] }, directed: true, nodes, edges,
  };
}
