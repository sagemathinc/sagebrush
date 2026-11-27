// TeX as plain text, for what is drawn on a canvas (an object's face in the space, the reading panel in VR), where
// KaTeX can't draw: $\frac{4}{3}\pi r^3$ reads as "4/3 π r³". The drawer typesets the same text with KaTeX.
const SYMBOLS = {
  alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ε", varepsilon: "ε", zeta: "ζ", eta: "η", theta: "θ", vartheta: "ϑ",
  iota: "ι", kappa: "κ", lambda: "λ", mu: "μ", nu: "ν", xi: "ξ", pi: "π", rho: "ρ", sigma: "σ", tau: "τ", upsilon: "υ",
  phi: "φ", varphi: "φ", chi: "χ", psi: "ψ", omega: "ω", Gamma: "Γ", Delta: "Δ", Theta: "Θ", Lambda: "Λ", Xi: "Ξ", Pi: "Π",
  Sigma: "Σ", Phi: "Φ", Psi: "Ψ", Omega: "Ω",
  le: "≤", leq: "≤", ge: "≥", geq: "≥", ne: "≠", neq: "≠", approx: "≈", equiv: "≡", cong: "≅", sim: "∼", simeq: "≃",
  cdot: "·", times: "×", div: "÷", pm: "±", mp: "∓", infty: "∞", partial: "∂", nabla: "∇", int: "∫", iint: "∬", oint: "∮",
  sum: "∑", prod: "∏", to: "→", rightarrow: "→", leftarrow: "←", mapsto: "↦", Rightarrow: "⇒", iff: "⇔", implies: "⇒",
  in: "∈", notin: "∉", subset: "⊂", subseteq: "⊆", cup: "∪", cap: "∩", emptyset: "∅", forall: "∀", exists: "∃",
  ldots: "…", cdots: "⋯", dots: "…", circ: "∘", otimes: "⊗", oplus: "⊕", langle: "⟨", rangle: "⟩", mid: "|",
  lfloor: "⌊", rfloor: "⌋", lceil: "⌈", rceil: "⌉", ell: "ℓ", hbar: "ħ", deg: "°", prime: "′", setminus: "∖",
  log: "log", ln: "ln", exp: "exp", sin: "sin", cos: "cos", tan: "tan", det: "det", dim: "dim", ker: "ker", lim: "lim",
  max: "max", min: "min", gcd: "gcd", mod: "mod", bmod: "mod", pmod: "mod",
};
const BLACKBOARD = { Z: "ℤ", Q: "ℚ", R: "ℝ", C: "ℂ", N: "ℕ", P: "ℙ", H: "ℍ", F: "𝔽", A: "𝔸" };
const SUP = { 0: "⁰", 1: "¹", 2: "²", 3: "³", 4: "⁴", 5: "⁵", 6: "⁶", 7: "⁷", 8: "⁸", 9: "⁹", "+": "⁺", "-": "⁻", "=": "⁼", "(": "⁽", ")": "⁾", n: "ⁿ", i: "ⁱ", k: "ᵏ", x: "ˣ", "*": "*", "′": "′" };
const SUB = { 0: "₀", 1: "₁", 2: "₂", 3: "₃", 4: "₄", 5: "₅", 6: "₆", 7: "₇", 8: "₈", 9: "₉", "+": "₊", "-": "₋", "=": "₌", "(": "₍", ")": "₎", n: "ₙ", i: "ᵢ", k: "ₖ", j: "ⱼ", x: "ₓ", p: "ₚ", m: "ₘ" };

// a braced group or one token at s[i]: [its text, the index after it]
function arg(s, i) {
  while (s[i] === " ") i++;
  if (s[i] === "{") {
    let depth = 1, j = i + 1;
    while (j < s.length && depth) { if (s[j] === "{") depth++; else if (s[j] === "}") depth--; j++; }
    return [s.slice(i + 1, j - 1), j];
  }
  if (s[i] === "\\") { const m = /^\\([A-Za-z]+|.)/.exec(s.slice(i)); return [m[0], i + m[0].length]; }
  return [s[i] ?? "", i + 1];
}
const script = (t, map, mark) => {
  const plain = math(t);
  return [...plain].every((c) => map[c]) ? [...plain].map((c) => map[c]).join("") : mark + (plain.length > 1 ? `(${plain})` : plain);
};
const group = (t) => (/^[\w.′]+$/.test(t) ? t : `(${t})`);

/** TeX math (without its $ delimiters) as text */
export function math(s) {
  let out = "";
  for (let i = 0; i < s.length; ) {
    const c = s[i];
    if (c === "\\") {
      const m = /^\\([A-Za-z]+|.)/.exec(s.slice(i));
      const name = m[1];
      i += m[0].length;
      if (name === "frac" || name === "dfrac" || name === "tfrac") {
        const [a, j] = arg(s, i), [b, k] = arg(s, j);
        out += `${group(math(a))}/${group(math(b))}`;
        i = k;
      } else if (name === "sqrt") {
        const [a, j] = arg(s, i);
        out += `√${group(math(a))}`;
        i = j;
      } else if (name === "mathbb") {
        const [a, j] = arg(s, i);
        out += [...a].map((ch) => BLACKBOARD[ch] ?? ch).join("");
        i = j;
      } else if (["text", "mathrm", "mathbf", "mathit", "operatorname", "textbf", "textit", "mathcal", "mathfrak", "boldsymbol", "mathsf"].includes(name)) {
        const [a, j] = arg(s, i);
        out += name.startsWith("text") ? a : math(a);
        i = j;
      } else if (["left", "right", "big", "Big", "bigl", "bigr", "Bigl", "Bigr", "displaystyle", "limits", "nolimits"].includes(name)) {
        // (sizes only)
      } else if (name === "," || name === ";" || name === ":" || name === " " || name === "quad" || name === "qquad") out += " ";
      else if (name === "!") {
        // (a negative space)
      } else if (name === "{" || name === "}" || name === "|" || name === "%" || name === "$" || name === "#" || name === "&") out += name === "|" ? "‖" : name;
      else if (name === "\\") out += "; ";
      else out += SYMBOLS[name] ?? name;
    } else if (c === "^" || c === "_") {
      const [a, j] = arg(s, i + 1);
      out += c === "^" ? script(a, SUP, "^") : script(a, SUB, "_");
      i = j;
    } else if (c === "{" || c === "}") i++;
    else if (c === "~") { out += " "; i++; }
    else { out += c; i++; }
  }
  return out.replace(/\s+/g, " ").trim();
}

/** Markdown-ish text with $...$, $$...$$, \(...\), \[...\] math: the math as text, the rest as it is ($...$ as
 * web/markdown.ts reads it: no space just inside the dollars and no digit right after, so prices stay prices) */
export function texToText(s) {
  return String(s ?? "").replace(/\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\$(?!\s)((?:\\.|[^\\$\n])+?)(?<!\s)\$(?!\d)|\\\(([\s\S]+?)\\\)/g, (_, a, b, c, d) => {
    const t = math(a ?? b ?? c ?? d);
    return a !== undefined || b !== undefined ? `\n    ${t}\n` : t;
  });
}
