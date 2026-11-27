// A .bib read as BibTeX reads it, and the cited entries written as BibTeX's plain style writes them: the thebibliography
// a .bbl would hold, for a document whose \bibliography names .bib files when no .bbl is beside the .tex (BibTeX not
// run). inputs.ts gives it to the engine as that .bbl, so \cite's numbers and natbib's options apply as for one BibTeX
// made. A chunk of its own (sagebrush-latex-bib.js), the worker's, fetched when a document has a .bib read; the CLI's
// bundled. Plain's style only (sorted by author, year and title; numbered labels); fields it has no place for are left
// out, but a doi, an eprint and a url are shown, simply. Pure: test-latex-units.mjs checks it.

type Entry = { type: string; key: string; fields: Map<string, string> };
export type Bib = { entries: Map<string, Entry>; strings: Map<string, string> };

const MONTHS: [string, string][] = [["jan", "January"], ["feb", "February"], ["mar", "March"], ["apr", "April"], ["may", "May"], ["jun", "June"],
  ["jul", "July"], ["aug", "August"], ["sep", "September"], ["oct", "October"], ["nov", "November"], ["dec", "December"]];

export const newBib = (): Bib => ({ entries: new Map(), strings: new Map(MONTHS) });

/** One .bib's @string's and entries added to `bib` (its @string's are seen by the files after it, as BibTeX reads them in
 * order; an entry whose key is already there is left out, as BibTeX keeps the first). Text outside an entry is a
 * comment, as in BibTeX; an entry that doesn't parse ends at the next "@". */
export function parseBib(text: string, bib: Bib = newBib()): Bib {
  const n = text.length;
  let i = 0;
  const ws = () => { while (i < n && /\s/.test(text[i])) i++; };
  const ident = (): string | null => { const re = /[^\s"#%'(),={}]+/y; re.lastIndex = i; const m = re.exec(text); if (!m) return null; i = re.lastIndex; return m[0]; };
  // (an unclosed value ends at a line that starts an entry, "@" and a letter: the entries after it are read)
  const nextEntry = (j: number) => { const re = /\n[ \t]*@[A-Za-z]/y; re.lastIndex = j; return re.test(text); };
  // (the index of the "}" closing the "{" at `at`, or where an unclosed one ends)
  const balanced = (at: number) => { let d = 0; for (let j = at; j < n; j++) { if (text[j] === "{") d++; else if (text[j] === "}" && --d === 0) return j; else if (nextEntry(j)) return j; } return n; };
  const value = (): string => {
    let out = "";
    for (;;) {
      ws();
      const c = text[i];
      if (c === "{") { const e = balanced(i); out += text.slice(i + 1, e); i = e + 1; }
      else if (c === '"') { let d = 0, j = i + 1; for (; j < n; j++) { if (text[j] === "{") d++; else if (text[j] === "}") d--; else if (text[j] === '"' && d <= 0) break; else if (nextEntry(j)) break; } out += text.slice(i + 1, j); i = j + 1; }
      else if (c !== undefined && /[0-9]/.test(c)) { const re = /[0-9]+/y; re.lastIndex = i; out += re.exec(text)![0]; i = re.lastIndex; }
      else { const id = ident(); if (id === null) break; out += bib.strings.get(id.toLowerCase()) ?? ""; }
      ws();
      if (text[i] === "#") { i++; continue; }
      break;
    }
    return out.replace(/\s+/g, " ").trim();
  };
  while (i < n) {
    const at = text.indexOf("@", i);
    if (at < 0) break;
    i = at + 1;
    ws();
    const type = ident()?.toLowerCase();
    if (!type || type === "comment") continue;
    ws();
    const open = text[i];
    if (open !== "{" && open !== "(") continue;
    const close = open === "{" ? "}" : ")";
    i++;
    if (type === "preamble") { value(); ws(); if (text[i] === close) i++; continue; }
    if (type === "string") {
      ws(); const name = ident(); ws();
      if (!name || text[i] !== "=") continue;
      i++;
      bib.strings.set(name.toLowerCase(), value());
      ws(); if (text[i] === close) i++;
      continue;
    }
    ws();
    const kre = /[^,\s{}()]+/y; kre.lastIndex = i;
    const km = kre.exec(text);
    if (!km) continue;
    i = kre.lastIndex;
    const fields = new Map<string, string>();
    for (;;) {
      ws();
      if (text[i] === ",") { i++; ws(); }
      if (i >= n || text[i] === close) { i++; break; }
      if (text[i] === "@") break;
      const name = ident();
      ws();
      if (!name || text[i] !== "=") break;
      i++;
      fields.set(name.toLowerCase(), value());
    }
    const lk = km[0].toLowerCase();
    if (!bib.entries.has(lk)) bib.entries.set(lk, { type, key: km[0], fields });
  }
  return bib;
}

// ---- names, as BibTeX splits them: "First von Last", "von Last, First", "von Last, Jr, First"
/** `s` split at `sep` (a regex source) where it is outside braces. */
function splitTop(s: string, sep: RegExp): string[] {
  const out: string[] = [];
  let d = 0, from = 0;
  for (let j = 0; j < s.length; j++) {
    const c = s[j];
    if (c === "{") d++;
    else if (c === "}") d--;
    else if (d === 0) { sep.lastIndex = j; const m = sep.exec(s); if (m) { out.push(s.slice(from, j)); from = j + m[0].length; j = from - 1; } }
  }
  out.push(s.slice(from));
  return out.map((x) => x.trim()).filter((x) => x !== "");
}
/** Whether a name's word starts lowercase, as BibTeX decides it (its first letter outside braces; a special character
 * such as {\"o} by its letter; another braced group isn't lowercase). */
function lowerWord(w: string): boolean {
  if (w.startsWith("{\\")) { const m = /^\{\\[a-zA-Z]+\s*\{?([A-Za-z])|^\{\\.\{?([A-Za-z])/.exec(w); const ch = m ? m[1] ?? m[2] : ""; return !!ch && ch === ch.toLowerCase() && ch !== ch.toUpperCase(); }
  for (let j = 0, d = 0; j < w.length; j++) {
    if (w[j] === "{") { if (d === 0) return false; d++; continue; }
    if (w[j] === "}") { d--; continue; }
    if (/[A-Za-z]/.test(w[j])) return w[j] === w[j].toLowerCase();
  }
  return false;
}
type Name = { first: string; von: string; last: string; jr: string };
export function nameParts(name: string): Name {
  const parts = splitTop(name, /,/y);
  const words = (s: string) => splitTop(s, /[\s~]+/y);
  if (parts.length >= 2) {
    const vl = words(parts[0]);
    let k = 0; while (k < vl.length - 1 && lowerWord(vl[k])) k++;
    return { von: vl.slice(0, k).join(" "), last: vl.slice(k).join(" "), jr: parts.length >= 3 ? parts[1] : "", first: parts[parts.length >= 3 ? 2 : 1] };
  }
  const w = words(parts[0] ?? "");
  if (w.length <= 1) return { first: "", von: "", last: w[0] ?? "", jr: "" };
  // (von: from the first lowercase word to the last one before the last word; else the last word alone is the last name)
  let a = -1, b = -1;
  for (let k = 0; k < w.length - 1; k++) if (lowerWord(w[k])) { if (a < 0) a = k; b = k; }
  if (a < 0) return { first: w.slice(0, -1).join(" "), von: "", last: w[w.length - 1], jr: "" };
  return { first: w.slice(0, a).join(" "), von: w.slice(a, b + 1).join(" "), last: w.slice(b + 1).join(" "), jr: "" };
}
const splitNames = (s: string) => splitTop(s, /\s+and\s+/iy);
/** A name list as plain writes it: "A", "A and B", "A, B, and C"; "and others" as "et~al.". */
function formatNames(s: string): string {
  const all = splitNames(s), others = all.length > 1 && all[all.length - 1].toLowerCase() === "others";
  const ns = (others ? all.slice(0, -1) : all).map((x) => { const p = nameParts(x); return [p.first, p.von, p.last].filter(Boolean).join(" ") + (p.jr ? ", " + p.jr : ""); });
  if (others) return ns.length === 1 ? ns[0] + " et~al." : ns.join(", ") + ", et~al.";
  return ns.length <= 2 ? ns.join(" and ") : ns.slice(0, -1).join(", ") + ", and " + ns[ns.length - 1];
}
const editors = (s: string) => formatNames(s) + (splitNames(s).length > 1 ? ", editors" : ", editor");

/** A title in sentence case, as plain's change.case$ "t": letters outside braces lowercased but the first and one after
 * a colon and space; a braced group kept as written, and (here) a control sequence and math left as they are. */
export function titleCase(s: string): string {
  let out = "", d = 0, math = false;
  for (let j = 0; j < s.length; j++) {
    const c = s[j];
    if (c === "{") d++;
    else if (c === "}") d--;
    else if (c === "$" && d === 0) math = !math;
    else if (c === "\\" && d === 0) { const m = /\\(?:[A-Za-z]+|.)/y; m.lastIndex = j; const r = m.exec(s); if (r) { out += r[0]; j = m.lastIndex - 1; continue; } }
    else if (d === 0 && !math && j > 0 && !/:\s*$/.test(s.slice(Math.max(0, j - 3), j))) { out += c.toLowerCase(); continue; }
    out += c;
  }
  return out;
}
/** Letters outside braces lowercased, as change.case$ "l" (a control sequence and math left as they are). */
const lower = (s: string) => titleCase("x" + s).slice(1).replace(/^./, (c) => c.toLowerCase());
const dashify = (p: string) => p.replace(/(\d)\s*-\s*(?=\d)/g, "$1--").replace(/(\d)\s*--+\s*(?=\d)/g, "$1--");
/** BibTeX's purify$: letters, digits and spaces, a special character as its letter. */
const purify = (s: string) => s.replace(/\\[A-Za-z]+\s*|\\./g, "").replace(/-/g, " ").replace(/[^A-Za-z0-9\s]/g, "").replace(/\s+/g, " ").trim();

// (the names part of plain's sort key, by type, as its presort: book and inbook author, else editor; proceedings editor,
//  else organization; manual author, else organization; every other type author only; then the key field; else empty,
//  so the entry sorts first: plain warns "to sort, need author or key")
function sortKey(e: Entry): string {
  const f = e.fields, t = e.type;
  const names = (s: string) => splitNames(s).map((x) => { const p = nameParts(x); return [p.von, p.last, p.first, p.jr].filter(Boolean).join(" "); }).join("   ");
  const org = (o: string) => o.replace(/^The\s+/, "");
  const by = (...ks: string[]) => { for (const k of ks) { const v = f.get(k); if (v) return k === "organization" ? org(v) : k === "key" ? v : names(v); } return ""; };
  const who = t === "book" || t === "inbook" ? by("author", "editor", "key") : t === "proceedings" ? by("editor", "organization", "key")
    : t === "manual" ? by("author", "organization", "key") : by("author", "key");
  const title = (f.get("title") ?? "").replace(/^(A|An|The)\s+/, "");
  return (purify(who) + "    " + (f.get("year") ?? "") + "    " + purify(title)).toLowerCase();
}

// (plain's output: a state machine of sentences and blocks. output writes ", " in a sentence, ". " after new.sentence,
//  ".\n\newblock " after new.block; a period ends the entry, none added after one (add.period$))
const addPeriod = (s: string) => (/[.?!]\}*$/.test(s) ? s : s + ".");
class Out {
  s = ""; st: "before" | "mid" | "sentence" | "block" = "before";
  out(x: string) { if (!x) return; if (this.st === "mid") this.s += ", "; else if (this.st === "sentence") this.s = addPeriod(this.s) + " "; else if (this.st === "block") this.s = addPeriod(this.s) + "\n\\newblock "; this.s += x; this.st = "mid"; }
  block() { if (this.st !== "before") this.st = "block"; }
  sentence() { if (this.st !== "block" && this.st !== "before") this.st = "sentence"; }
  blockIf(...xs: string[]) { if (xs.some(Boolean)) this.block(); }
  sentenceIf(...xs: string[]) { if (xs.some(Boolean)) this.sentence(); }
}
/** A number joined to its word as plain's tie.or.space.connect: a tie when it is shorter than 3 characters. */
const tie = (w: string, n: string) => w + (n.length < 3 ? "~" : " ") + n;

/** One entry's text as plain.bst writes it: each type's fields in its order, sentences and blocks as plain makes them. */
export function formatEntry(e: Entry): string {
  const f = (k: string) => e.fields.get(k) ?? "";
  const o = new Out(), t = e.type;
  const em = (s: string) => (s ? "{\\em " + s + "}" : "");
  const authors = f("author") ? formatNames(f("author")) : "", eds = f("editor") ? editors(f("editor")) : "";
  const title = f("title") ? titleCase(f("title")) : "", btitle = em(f("title"));
  const date = f("year") ? (f("month") ? f("month") + " " + f("year") : f("year")) : f("month");
  const edition = f("edition") ? lower(f("edition")) + " edition" : "";
  const multi = /[-,+]/.test(f("pages"));
  const pages = f("pages") ? (multi ? tie("pages", dashify(f("pages"))) : tie("page", f("pages"))) : "";
  const bvolume = f("volume") ? tie("volume", f("volume")) + (f("series") ? " of " + em(f("series")) : "") : "";
  // (format.number.series: "number" in a sentence, "Number" starting one; nothing with a volume, which bvolume shows)
  const numSeries = () => f("volume") ? "" : f("number") ? tie(o.st === "mid" ? "number" : "Number", f("number")) + (f("series") ? " in " + f("series") : "") : f("series");
  const chapterPages = () => f("chapter") ? tie(f("type") ? lower(f("type")) : "chapter", f("chapter")) + (pages ? ", " + pages : "") : pages;
  const inEdBooktitle = f("booktitle") ? "In " + (eds ? eds + ", " : "") + em(f("booktitle")) : "";
  const thesis = (dflt: string) => (f("type") ? titleCase(f("type")) : dflt);
  if (t === "article") {
    o.out(authors); o.block(); o.out(title); o.block(); o.out(em(f("journal")));
    let vnp = f("volume") + (f("number") ? "(" + f("number") + ")" : "");
    if (f("pages")) vnp = vnp ? vnp + ":" + dashify(f("pages")) : pages;
    o.out(vnp); o.out(date);
  } else if (t === "book" || t === "inbook") {
    o.out(authors || eds); o.block(); o.out(btitle); o.out(bvolume);
    if (t === "inbook") o.out(chapterPages());
    o.block(); o.out(numSeries()); o.sentence(); o.out(f("publisher")); o.out(f("address")); o.out(edition); o.out(date);
  } else if (t === "booklet") {
    o.out(authors); o.block(); o.out(title); o.blockIf(f("howpublished"), f("address")); o.out(f("howpublished")); o.out(f("address")); o.out(date);
  } else if (t === "incollection") {
    o.out(authors); o.block(); o.out(title); o.block(); o.out(inEdBooktitle); o.out(bvolume); o.out(numSeries()); o.out(chapterPages());
    o.sentence(); o.out(f("publisher")); o.out(f("address")); o.out(edition); o.out(date);
  } else if (t === "inproceedings" || t === "conference") {
    o.out(authors); o.block(); o.out(title); o.block(); o.out(inEdBooktitle); o.out(bvolume); o.out(numSeries()); o.out(pages);
    if (!f("address")) { o.sentenceIf(f("organization"), f("publisher")); o.out(f("organization")); o.out(f("publisher")); o.out(date); }
    else { o.out(f("address")); o.out(date); o.sentence(); o.out(f("organization")); o.out(f("publisher")); }
  } else if (t === "manual") {
    if (authors) o.out(authors); else if (f("organization")) { o.out(f("organization")); o.out(f("address")); }
    o.block(); o.out(btitle);
    if (!authors) { if (!f("organization")) { o.blockIf(f("address")); o.out(f("address")); } }
    else { o.blockIf(f("organization"), f("address")); o.out(f("organization")); o.out(f("address")); }
    o.out(edition); o.out(date);
  } else if (t === "mastersthesis" || t === "phdthesis") {
    o.out(authors); o.block(); o.out(t === "phdthesis" ? btitle : title); o.block();
    o.out(thesis(t === "phdthesis" ? "PhD thesis" : "Master's thesis")); o.out(f("school")); o.out(f("address")); o.out(date);
  } else if (t === "proceedings") {
    o.out(eds || f("organization")); o.block(); o.out(btitle); o.out(bvolume); o.out(numSeries());
    if (!f("address")) {
      if (!eds) o.sentenceIf(f("publisher")); else { o.sentenceIf(f("organization"), f("publisher")); o.out(f("organization")); }
      o.out(f("publisher")); o.out(date);
    } else { o.out(f("address")); o.out(date); o.sentence(); if (eds) o.out(f("organization")); o.out(f("publisher")); }
  } else if (t === "techreport") {
    o.out(authors); o.block(); o.out(title); o.block();
    const tr = f("type") || "Technical Report";
    o.out(f("number") ? tie(tr, f("number")) : titleCase(tr)); o.out(f("institution")); o.out(f("address")); o.out(date);
  } else if (t === "unpublished") {
    o.out(authors); o.block(); o.out(title); o.block(); o.out(f("note")); o.out(date);
  } else {
    // (misc, and any type plain doesn't know, as plain's default.type: misc)
    o.out(authors); o.blockIf(f("title"), f("howpublished")); o.out(title); o.blockIf(f("howpublished")); o.out(f("howpublished")); o.out(date);
  }
  if (t !== "unpublished") { o.block(); o.out(f("note")); }
  // (a doi, an eprint and a url, which plain leaves out: shown, simply, in a block of their own)
  const eprint = f("eprint") ? (/^arxiv$/i.test(f("archiveprefix") || f("eprinttype") || "arxiv") ? "arXiv:" + f("eprint") : f("eprint")) : "";
  o.block(); o.out(f("doi") ? "doi:" + f("doi") : ""); o.out(eprint); o.out(f("url") ? "\\url{" + f("url") + "}" : "");
  return o.s ? addPeriod(o.s) : "";
}

/** Strip TeX comments: "%" to the line's end, not "\%". */
const uncomment = (s: string) => s.replace(/(^|[^\\])%.*$/gm, "$1");
/** The keys a document cites (\cite, \citep, \nocite, ... in its own and its included texts), in order, and whether it
 * has \nocite{*}. */
export function citedKeys(texts: string[]): { all: boolean; keys: string[] } {
  const keys: string[] = []; let all = false;
  for (const t of texts) for (const m of uncomment(t).matchAll(/\\(?:no)?cite[a-zA-Z]*\*?\s*(?:\[[^\]]*\]\s*){0,2}\{([^}]*)\}/g))
    for (const k of m[1].split(",").map((x) => x.trim()).filter(Boolean)) { if (k === "*") all = true; else keys.push(k); }
  return { all, keys };
}
/** The .bib names a document's \bibliography gives (".bib" added where it isn't written), in order. */
export function bibNames(texts: string[]): string[] {
  const out: string[] = [];
  for (const t of texts) for (const m of uncomment(t).matchAll(/\\bibliography\s*\{([^}]*)\}/g))
    for (const x of m[1].split(",").map((s) => s.trim()).filter(Boolean)) { const nm = /\.bib$/i.test(x) ? x : x + ".bib"; if (!out.includes(nm)) out.push(nm); }
  return out;
}

/** The thebibliography for `bibs` (the .bib texts, in \bibliography's order) and the keys cited, as plain's .bbl: the
 * cited entries (all of them for \nocite{*}) sorted by author, year and title, each with the key as cited; a crossref'd
 * entry with the fields it lacks from its parent. A key that isn't in the .bib has no item (\cite shows "?"). */
export function bibToBbl(bibs: string[], cited: { all: boolean; keys: string[] }): string {
  const bib = newBib();
  for (const b of bibs) parseBib(b, bib);
  const asCited = new Map<string, string>();
  for (const k of cited.keys) if (!asCited.has(k.toLowerCase())) asCited.set(k.toLowerCase(), k);
  const chosen = cited.all ? [...bib.entries.keys()] : [...asCited.keys()].filter((k) => bib.entries.has(k));
  const items = chosen.map((lk) => {
    const e = bib.entries.get(lk)!, p = e.fields.get("crossref"), parent = p ? bib.entries.get(p.toLowerCase()) : undefined;
    const fields = new Map(e.fields);
    if (parent) { for (const [k, v] of parent.fields) if (!fields.has(k) && k !== "crossref") fields.set(k, v); if (!e.fields.has("booktitle") && parent.fields.has("title")) fields.set("booktitle", parent.fields.get("title")!); }
    const ent = { type: e.type, key: asCited.get(lk) ?? e.key, fields };
    return { ent, sort: sortKey(ent) };
  });
  items.sort((a, b) => (a.sort < b.sort ? -1 : a.sort > b.sort ? 1 : 0));
  return "\\begin{thebibliography}{" + Math.max(1, items.length) + "}\n\n" + items.map(({ ent }) => "\\bibitem{" + ent.key + "}\n" + formatEntry(ent) + "\n").join("\n") + "\n\\end{thebibliography}\n";
}

/** The .bbl for a document's texts (its own and its included files'), the .bib files its \bibliography names read by
 * `read` (undefined for one not read): null if none is. inputs.ts's engineInputs takes it as its `makeBbl`. */
export function bblFor(texts: string[], read: (name: string) => string | undefined): string | null {
  const bibs = bibNames(texts).map(read).filter((t): t is string => typeof t === "string");
  return bibs.length ? bibToBbl(bibs, citedKeys(texts)) : null;
}
