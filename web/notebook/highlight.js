// Highlighting, for the notebook's editor and anything else that edits
// Python or Markdown (the board's note editor): a small regex tokenizer, no
// dependency, and nothing else of the notebook's, so it loads on its own.
// A small regex tokenizer for Python (and Sage's ^ and ^^): good enough for
// a notebook, and no dependency.
const KW = new Set("False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case type self cls".split(" "));
const BI = new Set("abs all any ascii bin bool breakpoint bytearray bytes callable chr classmethod compile complex delattr dict dir divmod enumerate eval exec filter float format frozenset getattr globals hasattr hash help hex id input int isinstance issubclass iter len list locals map max memoryview min next object oct open ord pow print property range repr reversed round set setattr slice sorted staticmethod str sum super tuple type vars zip __import__ Exception ValueError TypeError KeyError IndexError StopIteration ZeroDivisionError ArithmeticError RuntimeError NotImplementedError AttributeError NameError".split(" "));
const SAGE_BI = new Set("factor is_prime is_prime_power is_square next_prime previous_prime nth_prime prime_range primes primes_first_n prime_pi divisors number_of_divisors sigma euler_phi moebius gcd lcm xgcd inverse_mod power_mod crt binomial factorial fibonacci isqrt sqrt srange prod continued_fraction numerator denominator valuation digits Rational Integer ZZ QQ RR n N".split(" "));
const TOKEN = /(#.*)|((?:\b[rRbBuUfFtT]{1,2})?(?:"""[\s\S]*?(?:"""|$(?![\s\S]))|'''[\s\S]*?(?:'''|$(?![\s\S]))|"(?:\\.|[^"\\\n])*(?:"|$)|'(?:\\.|[^'\\\n])*(?:'|$)))|(^[ \t]*@[\w.]+)|(\b(?:0[xX][\da-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|(?:\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(?:[eE][+-]?\d+)?[jJ]?)\b)|([A-Za-z_]\w*)/gm;
export const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
export function highlight(src, sage) {
  let out = "", last = 0, prev = "";
  for (const m of src.matchAll(TOKEN)) {
    out += esc(src.slice(last, m.index));
    last = m.index + m[0].length;
    let cls = m[1] ? "hc" : m[2] ? "hs" : m[3] ? "hd" : m[4] ? "hn" : "";
    if (m[5]) {
      const w = m[5];
      cls = prev === "def" || prev === "class" ? "hf" : KW.has(w) ? "hk" : BI.has(w) || (sage && SAGE_BI.has(w)) ? "hb" : "";
      prev = w;
    }
    out += cls ? `<span class="${cls}">${esc(m[0])}</span>` : esc(m[0]);
  }
  return out + esc(src.slice(last)) + "\n"; // a final newline keeps the last line's height
}

// Markdown source, for the editor of a Markdown cell: headings, emphasis,
// code (fenced Python or Sage highlighted as code), links, HTML, and math
// ($...$, $$...$$, \(...\), \[...\]) with its TeX: delimiters, \commands,
// digits, letters and the {}^_& structure.  Colours only, so the text keeps
// the textarea's widths.
const MD = new RegExp([
  /^(```|~~~)([^\n]*)\n([\s\S]*?)(?:^(\1[ \t]*)$|$(?![\s\S]))/.source, // 1-4 fenced code
  /(\$\$[\s\S]*?(?:\$\$|$(?![\s\S]))|\\\[[\s\S]*?(?:\\\]|$(?![\s\S])))/.source, // 5 display math
  /(`+)([\s\S]*?)\6/.source, // 6-7 inline code
  /((?<![\\$])\$(?![\s$])(?:\\.|[^$\\\n])*?(?<!\s)\$|\\\((?:[^\n]|\n(?!\n))*?\\\))/.source, // 8 inline math
  /(^#{1,6}[ \t].*$)/.source, // 9 heading
  /(^[ \t]*(?:[-*+]|\d+[.)])(?=[ \t])|^[ \t]*>)/.source, // 10 list item, quote
  /(\*\*(?=\S)[^*\n]*?\S\*\*|__(?=\S)[^_\n]*?\S__|(?<![*\w])\*(?=\S)[^*\n]*?\S\*(?!\*)|(?<![_\w])_(?=\S)[^_\n]*?\S_(?![_\w]))/.source, // 11 emphasis
  /(!?\[)([^\]\n]*)(\]\()([^)\n]*)(\))/.source, // 12-16 link, image
  /(<\/?[A-Za-z][^>\n]*>|\\[\\`*_{}\[\]()#+\-.!$|])/.source, // 17 HTML, escape
].join("|"), "gm");
const span = (cls, text) => (text ? `<span class="${cls}">${esc(text)}</span>` : "");
function highlightTex(t) {
  // delimiters, then \commands, digits, letters and structure
  const m = /^(\$\$|\$|\\\[|\\\()([\s\S]*?)(\$\$|\$|\\\]|\\\))?$/.exec(t);
  const [open, body, close] = m ? [m[1], m[2], m[3] ?? ""] : ["", t, ""];
  const inner = body.replace(/(\\(?:[A-Za-z]+|.))|(\d+(?:\.\d+)?)|([A-Za-z]+)|([{}^_&])|([^\\\dA-Za-z{}^_&]+)/g,
    (_, c, d, l, st, o) => (c ? span("hk", c) : d ? span("hn", d) : l ? span("hb", l) : st ? span("hp", st) : esc(o)));
  return span("hd", open) + inner + span("hd", close);
}
export function highlightMarkdown(src, sage) {
  let out = "", last = 0;
  for (const m of src.matchAll(MD)) {
    out += esc(src.slice(last, m.index));
    last = m.index + m[0].length;
    if (m[1]) {
      const lang = m[2].trim().toLowerCase(), code = m[3];
      const body = /^(py|python|python3|sage|ipython|)$/.test(lang) ? highlight(code, sage || lang === "sage").slice(0, -1) : span("hs", code);
      out += span("hp", m[1] + m[2] + "\n") + body + span("hp", m[4] ?? "");
    } else if (m[5]) out += highlightTex(m[5]);
    else if (m[6]) out += span("hp", m[6]) + span("hs", m[7]) + span("hp", m[6]);
    else if (m[8]) out += highlightTex(m[8]);
    else if (m[9]) out += span("hf", m[9]);
    else if (m[10]) out += span("hk", m[10]);
    else if (m[11]) out += span("hk", m[11]);
    else if (m[12]) out += span("hp", m[12]) + span("hb", m[13]) + span("hp", m[14]) + span("hd", m[15]) + span("hp", m[16]);
    else if (m[17]) out += span("hd", m[17]);
    else out += esc(m[0]);
  }
  return out + esc(src.slice(last)) + "\n";
}

