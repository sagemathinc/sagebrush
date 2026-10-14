// Highlighting MATLAB, for the notebook's editor (the classes of
// highlight.js: hc comment, hs string, hn number, hk keyword, hb builtin, hf a
// function being defined).  A small scanner, no dependency: a quote right
// after a name, a closing bracket, a dot or another quote is a transpose,
// anywhere else it starts a character vector; "..." is a string; % and the
// rest of a line after ... are comments, and %{ and %} alone on their lines
// enclose a block comment.
import { esc } from "./highlight.js";

const KW = new Set("break case catch classdef continue else elseif end for function global if otherwise parfor persistent return spmd switch try while arguments methods properties events enumeration".split(" "));
const BI = new Set(("disp fprintf sprintf num2str mat2str str2num str2double num2cell cell2mat struct cell fieldnames isfield rmfield " +
  "zeros ones eye rand randn randi linspace logspace size numel length ndims isempty reshape repmat cat horzcat vertcat " +
  "sum prod cumsum cumprod max min mean median mode std var sort unique find any all abs sqrt exp log log2 log10 " +
  "sin cos tan asin acos atan atan2 sinh cosh tanh floor ceil round fix mod rem gcd lcm factorial nchoosek primes isprime " +
  "inv det rank trace norm eig svd lu qr chol kron dot cross pinv expm magic diag triu tril " +
  "plot plot3 scatter scatter3 bar barh histogram hist surf mesh contour contourf imagesc image imshow pcolor quiver " +
  "figure subplot tiledlayout nexttile hold title xlabel ylabel zlabel legend grid axis xlim ylim zlim colorbar colormap " +
  "error warning assert isnumeric ischar iscell isstruct islogical isa class double single int8 int16 int32 int64 " +
  "uint8 uint16 uint32 uint64 logical char string strcat strsplit strjoin strrep strtrim upper lower regexp regexprep " +
  "true false pi inf Inf nan NaN eps i j end numel feval cellfun arrayfun isequal tic toc load save format").split(" "));

function scan(src) {
  // [start, end, class] spans, in order
  const out = [];
  // (after: "function" while its line names the function; depth: inside its [outputs])
  let i = 0, prevSig = "", lineStart = true, after = "", depth = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === "\n") { i++; lineStart = true; prevSig = ""; after = ""; depth = 0; continue; }
    if (c === " " || c === "\t" || c === "\r") { i++; prevSig = prevSig && " "; continue; }
    // block comment: %{ alone on its line, up to %} alone on its line
    const eol = src.indexOf("\n", i) < 0 ? n : src.indexOf("\n", i);
    if (lineStart && /^%\{[ \t]*$/.test(src.slice(i, eol))) {
      const m = /^[ \t]*%\}[ \t]*$/m.exec(src.slice(i + 2));
      const e = m ? i + 2 + m.index + m[0].length : n;
      out.push([i, e, "hc"]);
      i = e;
      continue;
    }
    lineStart = false;
    if (c === "%") {
      const e = src.indexOf("\n", i);
      out.push([i, e < 0 ? n : e, "hc"]);
      i = e < 0 ? n : e;
      continue;
    }
    if (src.startsWith("...", i)) {
      // (continuation: the rest of the line is a comment)
      const e = src.indexOf("\n", i);
      out.push([i, e < 0 ? n : e, "hc"]);
      i = e < 0 ? n : e;
      continue;
    }
    if (c === '"' || (c === "'" && !/[\w)\]}.']/.test(prevSig))) {
      let j = i + 1;
      while (j < n && src[j] !== "\n") {
        if (src[j] === c) {
          if (src[j + 1] === c) { j += 2; continue; }
          j++;
          break;
        }
        j++;
      }
      out.push([i, j, "hs"]);
      i = j;
      prevSig = "s";
      continue;
    }
    const num = /^(?:0[xX][\da-fA-F]+|0[bB][01]+|(?:\d+\.?\d*|\.\d+)(?:[eEdD][+-]?\d+)?)(?:[ij](?!\w))?/.exec(src.slice(i, i + 64));
    if (num && /\d/.test(c + src[i + 1])) {
      out.push([i, i + num[0].length, "hn"]);
      i += num[0].length;
      prevSig = "0";
      continue;
    }
    const w = /^[A-Za-z_]\w*/.exec(src.slice(i, i + 256));
    if (w) {
      const word = w[0];
      let cls = "";
      if (after === "function" && !KW.has(word)) {
        // (function [a, b] = name(...), function a = name(...), function name: the
        // name is the word outside the brackets not followed by "=")
        if (depth === 0 && !/^\s*=/.test(src.slice(i + word.length, eol))) { cls = "hf"; after = ""; }
      } else cls = KW.has(word) && prevSig !== "." ? "hk" : BI.has(word) && prevSig !== "." ? "hb" : "";
      if (word === "function") after = "function";
      if (cls) out.push([i, i + word.length, cls]);
      i += word.length;
      prevSig = "a";
      continue;
    }
    if (after === "function" && c === "[") depth++;
    if (after === "function" && c === "]") depth--;
    prevSig = c;
    i++;
  }
  return out;
}

export function highlightMatlab(src) {
  let html = "", last = 0;
  for (const [s, e, cls] of scan(src)) {
    html += esc(src.slice(last, s)) + `<span class="${cls}">${esc(src.slice(s, e))}</span>`;
    last = e;
  }
  return html + esc(src.slice(last)) + "\n"; // a final newline keeps the last line's height
}
