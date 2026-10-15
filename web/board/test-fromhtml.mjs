// A board downloaded as HTML, read back from its text alone (fromhtml.ts):
// the JSON an export embeds, whose every "<" exportHtml writes as \u003c, so
// that no "</script>" is in it and the first "</script>" after it is its end
// (the comment's argument, DOC-36E-3); a page that is not an export, or
// whose JSON is not whole, is refused.
//   bun web/board/test-fromhtml.mjs
import { boardFromHtml, embeddedJson, isHtml } from "./fromhtml.ts";

let checks = 0;
const fails = [];
const check = (ok, what) => { checks++; if (!ok) fails.push(what); };

// (\u003c, made here: a backslash, then u003c)
const LT = String.fromCharCode(92) + "u003c";
const GEN = '<meta name="generator" content="Sagebrush boards (sagebrush.space/board), exported 2026-10-15">';
const page = (json, head = GEN) => `<!doctype html><html><head>\n${head}</head><body><script type="application/json" id="sb-doc">${json}</script><script>window.after = 1</script></body></html>`;
const doc = { title: "T", nodes: [{ id: "a", text: "</script><img src=x onerror=alert(1)>" }] };

// as exportHtml writes it: each "<" as <, so no "</script>" in it
const written = JSON.stringify(doc).replaceAll("<", LT);
check(!written.includes("</script>") && written.includes(LT + "/script>"), "as written, the JSON has no </script>: " + written);
check(JSON.stringify(embeddedJson(page(written), "sb-doc", "Sagebrush boards")) === JSON.stringify(doc), "read back, the same document (its </script> text and all)");
check(JSON.stringify(boardFromHtml(page(written))) === JSON.stringify(doc), "boardFromHtml: the same");

// a raw </script> in the JSON (not as an export writes it): the script ends there, the rest is not JSON: refused
check(embeddedJson(page(JSON.stringify(doc)), "sb-doc", "Sagebrush boards") === null, "a raw </script> in the JSON ends it there: refused");
// no generator, or another's: refused
check(embeddedJson(page(written, ""), "sb-doc", "Sagebrush boards") === null, "without the generator: refused");
check(embeddedJson(page(written, '<meta name="generator" content="Something else">'), "sb-doc", "Sagebrush boards") === null, "another generator: refused");
let threw = false;
try { boardFromHtml(page(written, "")); } catch (e) { threw = /not a board downloaded from Sagebrush/.test(String(e?.message)); }
check(threw, "boardFromHtml says why it refuses");
// HTML or not
check(isHtml(page(written)) && isHtml("  <html lang=en>") && !isHtml("{}") && !isHtml("graph TD\n a --> b"), "an HTML file is told from JSON and Mermaid");

console.log(`${checks - fails.length}/${checks} checks passed`);
for (const f of fails) console.log("FAIL", f);
process.exit(fails.length ? 1 : 0);
