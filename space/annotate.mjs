// Adds what a space's objects are for, and guided tours, from a notes file: { summaries: { <id>: text }, tours: [{ id,
// title, steps: [{ node: <id>, text }] }] }. Summaries for ids the space hasn't are refused, as are tour stops on
// them, so a notes file can't drift from its space unnoticed. An agent (or a person) writes the notes; this merges them.
//   node annotate.mjs public/X.space.json notes.json
import { readFileSync, writeFileSync } from "node:fs";

const [spaceFile, notesFile] = process.argv.slice(2);
if (!spaceFile || !notesFile) throw new Error("usage: node annotate.mjs <space.json> <notes.json>");
const space = JSON.parse(readFileSync(spaceFile, "utf8"));
const notes = JSON.parse(readFileSync(notesFile, "utf8"));
const ids = new Set(space.nodes.map((n) => n.id));
const bad = [];
let added = 0;
for (const [id, text] of Object.entries(notes.summaries ?? {})) {
  if (!ids.has(id)) { bad.push(`summary for ${id}: no such object`); continue; }
  if (typeof text !== "string" || !text.trim()) { bad.push(`summary for ${id}: empty`); continue; }
  space.nodes.find((n) => n.id === id).summary = text.trim();
  added++;
}
const tours = [];
for (const t of notes.tours ?? []) {
  const steps = (t.steps ?? []).filter((s) => {
    if (ids.has(s.node)) return true;
    bad.push(`tour ${t.id}: stop on ${s.node}: no such object`);
    return false;
  });
  if (steps.length) tours.push({ id: String(t.id), title: String(t.title ?? t.id), steps: steps.map((s) => ({ node: s.node, text: String(s.text ?? "") })) });
}
if (bad.length) throw new Error(bad.join("\n"));
if (tours.length) space.tours = tours;
writeFileSync(spaceFile, JSON.stringify(space));
const missing = space.nodes.filter((n) => !n.summary).map((n) => n.id);
console.log(`${spaceFile}: ${added} summaries, ${tours.length} tours${missing.length ? `; no summary yet: ${missing.join(", ")}` : ""}`);
