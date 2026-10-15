import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// MATLAB's TeX markup (lib/_matlab_tex.py), the default Interpreter of
// titles, labels, legends, text and tick labels, as its documentation's
// "TeX Markup" table describes it; anything else an error, never drawn.

const cli = (...args: string[]) => execFileSync(process.execPath, [__dirname + "/../src/cli.js", ...args], { encoding: "utf8" });

test("the TeX interpreter: scripts, modifiers, the symbols' table, escapes; errors for the rest", () => {
  const out = cli("-c", String.raw`
import json, _matlab_tex as t
def p(s):
    try:
        print(json.dumps(t.runs(s, 1.0), ensure_ascii=False))
    except Exception as e:
        print("error:", e)
p(r"f(x) = x^2 + \alpha_1")
p(r"x^{a_b}")
p(r"{\bf a} b")
p(r"\bf a \rm b \it c \sl d")
p(r"\color{magenta}m \color[rgb]{0,0.5,0.5}t \fontsize{15}s \fontname{Courier}c")
p(r"\_ \^ \{ \} \\")
p(r"$x$ and 50% and C:/x")
print(t.svg(r"f(x) = x^2 + \alpha_1", 10))
print(t.plain(r"\theta (rad)"), t.literal(r"a_b \x {y}^"))
# (a subscript and a superscript on one base: stacked, the second back by the first's width, the text after from the wider)
print(t.svg(r"a_1^2 b", 11))
print(t.svg(r"a^{22}_1 b", 11))
print(t.svg(r"a_1 b^2", 11))
print(json.dumps(t.runs(r"a_1^2 b", 10)))
print(json.dumps(t.runs(r"x^{a_1^2}", 10)))
names = "alpha angle ast beta gamma delta epsilon zeta eta theta vartheta iota kappa lambda mu nu xi pi rho sigma varsigma tau equiv Im otimes cap supset int rfloor lfloor perp wedge rceil vee upsilon phi chi psi omega Gamma Delta Theta Lambda Xi Pi Sigma Upsilon Phi Psi Omega forall exists ni cong approx Re oplus cup subseteq in lceil cdot neg times surd varpi rangle langle sim leq infty clubsuit diamondsuit heartsuit spadesuit leftrightarrow leftarrow Leftarrow uparrow rightarrow Rightarrow downarrow circ pm geq propto partial bullet div neq aleph wp oslash supseteq subset o nabla ldots prime 0 mid copyright".split()
print(len(names), all(len(t.plain("\\" + n)) == 1 for n in names), len(set(t.SYMBOLS)) == len(names))
for s in [r"\foo", r"x^", r"a_", r"{a", r"a}", r"\color{orange}x", r"\color{purple}x", r"\color[cmyk]{0,0,0,1}x",
          r"\color[rgb]{2,0,0}x", r"\fontsize{big}x", r"\fontname{a;b}x", "a\\", r"\$5", r"x^\bf y", r"\color red"]:
    p(s)
`);
  assert.deepEqual(out.trim().split("\n"), [
    '[{"t": "f(x) = x"}, {"t": "2", "s": 0.7, "r": 0.385}, {"t": " + α"}, {"t": "1", "s": 0.7, "r": -0.245}]',
    '[{"t": "x"}, {"t": "a", "s": 0.7, "r": 0.385}, {"t": "b", "s": 0.49, "r": 0.2135}]',
    '[{"t": " a", "b": true}, {"t": " b"}]',
    '[{"t": " a ", "b": true}, {"t": " b ", "b": false, "i": false}, {"t": " c ", "b": false, "i": true}, {"t": " d", "b": false, "i": true}]',
    '[{"t": "m ", "c": "#ff00ff"}, {"t": "t ", "c": "#008080"}, {"t": "s ", "s": 20.8333, "c": "#008080"}, {"t": "c", "s": 20.8333, "c": "#008080", "f": "Courier"}]',
    '"_ ^ { } \\\\"',
    '"$x$ and 50% and C:/x"',
    'f(x) = x<tspan font-size="7" dy="-3.85">2</tspan><tspan dy="3.85"> + α</tspan><tspan font-size="7" dy="2.45">1</tspan>',
    "θ (rad) a\\_b \\\\x \\{y\\}\\^",
    'a<tspan font-size="7.7" dy="2.69" textLength="4.24" lengthAdjust="spacingAndGlyphs">1</tspan><tspan dx="-4.24" font-size="7.7" dy="-6.93" textLength="4.24" lengthAdjust="spacingAndGlyphs">2</tspan><tspan dy="4.24"> b</tspan>',
    'a<tspan font-size="7.7" dy="-4.24" textLength="8.47" lengthAdjust="spacingAndGlyphs">22</tspan><tspan dx="-8.47" font-size="7.7" dy="6.93" textLength="4.24" lengthAdjust="spacingAndGlyphs">1</tspan><tspan dx="4.24" dy="-2.69"> b</tspan>',
    'a<tspan font-size="7.7" dy="2.69">1</tspan><tspan dy="-2.69"> b</tspan><tspan font-size="7.7" dy="-4.24">2</tspan>',
    '[{"t": "a"}, {"t": "1", "s": 0.7, "r": -0.245, "j": [[1, 0]]}, {"t": "2", "s": 0.7, "r": 0.385, "j": [[1, 1]]}, {"t": " b"}]',
    '[{"t": "x"}, {"t": "a", "s": 0.7, "r": 0.385}, {"t": "1", "s": 0.49, "r": 0.2135, "j": [[2, 0]]}, {"t": "2", "s": 0.49, "r": 0.6545, "j": [[2, 1]]}]',
    "102 True True",
    "error: TeX markup in '\\foo': \\foo is not supported (MATLAB's documented TeX markup only)",
    "error: TeX markup in 'x^': ^ with nothing after it",
    "error: TeX markup in 'a_': _ with nothing after it",
    "error: TeX markup in '{a': an opening brace with no closing one",
    "error: TeX markup in 'a}': a closing brace with no opening one",
    "error: TeX markup in '\\color{orange}x': \\color{orange} is not supported (its color is not documented): use \\color[rgb]{r,g,b}",
    "error: TeX markup in '\\color{purple}x': \\color{purple}: not one of the documented color names",
    "error: TeX markup in '\\color[cmyk]{0,0,0,1}x': \\color[...]: only [rgb] is documented",
    "error: TeX markup in '\\color[rgb]{2,0,0}x': \\color[rgb]{2,0,0}: not three values from 0 to 1",
    "error: TeX markup in '\\fontsize{big}x': \\fontsize{big}: not a size in points",
    "error: TeX markup in '\\fontname{a;b}x': \\fontname{a;b}: not a font name",
    "error: TeX markup in 'a\\': a backslash at the end",
    "error: TeX markup in '\\$5': \\$ is not TeX markup (to show a backslash, write \\\\)",
    "error: TeX markup in 'x^\\bf y': \\bf cannot be the one character of a superscript or subscript",
    "error: TeX markup in '\\color red': \\color needs its argument in braces",
  ]);
});

test("MATLAB figures draw text as TeX (Interpreter 'tex'), 'none' as typed; 'latex' and bad markup refused, leaving nothing", async () => {
  const { notebookSession } = require("../src/notebook-session");
  const msgs: any[] = [];
  const s = notebookSession((m: any) => msgs.push(m), { captureStreams: true });
  await s.ready;
  const cells = [
    "close all; x = 0:0.1:6; plot(x, x.^2, x, sin(x)); title('f(x) = x^2 + \\alpha_1'); xlabel('\\theta (rad)'); legend('x^2', 'sin \\pi'); xticks([0 3 6]); xticklabels({'t_0', '$3$', '6'})",
    "plot(1:3); title('a_b \\alpha', 'Interpreter', 'none'); text(2, 2, 'x_{max}')",
    "plot(1:3); try, title('ok', 'Interpreter', 'latex'), catch e, disp(e.message), end; title('still \\alpha'); disp(get(get(gca, 'Title'), 'Interpreter'))",
    "plot(1:3); n = numel(get(gca, 'Children')); try, text([1 2], [1 2], {'fine', '\\bogus'}), catch e, disp(e.message), end; disp(numel(get(gca, 'Children')) - n)",
    "try, legend('\\color{orange}a'), catch e, disp(e.message), end",
    "surf(peaks(5)); title('z = x^2'); zlabel('\\it z'); text(3, 3, 5, '\\pi')",
    // (the styled runs in all within the viewer's budget, 20000, or the SVG alone: 11 runs a text)
    "surf(peaks(5)); text(linspace(1, 5, 2000), 3*ones(1, 2000), 0, repmat({'a^1b^1c^1d^1e^1f'}, 1, 2000));",
    "surf(peaks(5)); text(linspace(1, 5, 1500), 3*ones(1, 1500), 0, repmat({'a^1b^1c^1d^1e^1f'}, 1, 1500));",
    // (a refused legend leaves the lines and the old legend as they were)
    "close all; h = plot(1:3); legend('original'); try, legend('\\bogus'), catch e, disp(e.message), end; try, legend('x', 'Interpreter', 'latex'), catch e, disp(e.message), end; fprintf('%s\\n', get(h, 'DisplayName')); disp(get(legend(), 'String'))",
    "close all; h = plot(1:3, 1:3, 1:3, 3:-1:1); legend('a', 'b'); try, legend('ok', '\\bad'), catch e, disp(e.message), end; fprintf('%s %s\\n', get(h(1), 'DisplayName'), get(h(2), 'DisplayName'))",
    // (\\fontsize's points as pixels in the 3-D view too, and a script in a font-size group; a stacked pair)
    "surf(peaks(5)); title('\\fontsize{15}x^2'); xlabel('a_1^2')",
  ];
  for (let i = 0; i < cells.length; i++) await s.handle({ id: i + 1, code: cells[i], matlab: true });
  const svg = (id: number) => msgs.find((m) => m.id === id && m.display)?.display["image/svg+xml"] ?? "";
  const out = (id: number) => msgs.filter((m) => m.id === id && m.stream).map((m) => m.text).join("");
  const one = svg(1);
  assert.match(one, />f\(x\) = x<tspan font-size="[\d.]+" dy="-[\d.]+">2<\/tspan><tspan dy="[\d.]+"> \+ α<\/tspan><tspan font-size="[\d.]+" dy="[\d.]+">1<\/tspan><\/text>/);
  assert.match(one, />θ \(rad\)</);
  assert.match(one, /sin π</);
  // (tick labels: t with a subscript 0; a dollar is a dollar)
  assert.match(one, />t<tspan font-size="[\d.]+" dy="[\d.]+">0<\/tspan><\/text>/);
  assert.match(one, />\$3\$</);
  assert.match(one, /aria-label="Plot: &quot;f\(x\) = x2 \+ α1&quot;/);
  assert.match(svg(2), />a_b \\alpha</);
  assert.match(svg(2), />x<tspan font-size="[\d.]+" dy="[\d.]+">max<\/tspan>/);
  assert.equal(out(3), "The 'latex' interpreter is not supported in Sagebrush: use 'tex' (MATLAB's TeX markup) or 'none'.\ntex\n");
  assert.match(svg(3), />still α</);
  assert.equal(out(4), "TeX markup in '\\bogus': \\bogus is not supported (MATLAB's documented TeX markup only)\n     0\n");
  assert.equal(out(5), "TeX markup in '\\color{orange}a': \\color{orange} is not supported (its color is not documented): use \\color[rgb]{r,g,b}\n");
  // (the interactive 3-D view: the same markup, as runs)
  const scene = JSON.parse(msgs.find((m) => m.id === 6 && m.display).display["application/vnd.sagebrush.scene3d+json"]);
  assert.deepEqual(scene.title, [{ t: "z = x" }, { t: "2", s: 0.7, r: 0.385 }]);
  assert.deepEqual(scene.labels[2], [{ t: " z", i: true }]);
  assert.equal(scene.objects.find((o: any) => o.type === "text").text, "π");
  const sceneOf = (id: number) => msgs.find((m) => m.id === id && m.display)?.display["application/vnd.sagebrush.scene3d+json"];
  assert.ok(svg(7) && !sceneOf(7), "22000 runs: the SVG alone");
  assert.equal(JSON.parse(sceneOf(8)).objects.filter((o: any) => o.type === "text").length, 1500);
  assert.equal(out(9), "TeX markup in '\\bogus': \\bogus is not supported (MATLAB's documented TeX markup only)\n"
    + "The 'latex' interpreter is not supported in Sagebrush: use 'tex' (MATLAB's TeX markup) or 'none'.\noriginal\n    {'original'}\n");
  assert.equal(out(10), "TeX markup in '\\bad': \\bad is not supported (MATLAB's documented TeX markup only)\na b\n");
  const big = JSON.parse(sceneOf(11));
  assert.deepEqual(big.title, [{ t: "x", s: 1.3889 }, { t: "2", s: 0.9722, r: 0.5347 }]);
  assert.deepEqual(big.labels[0], [{ t: "a" }, { t: "1", s: 0.7, r: -0.245, j: [[1, 0]] }, { t: "2", s: 0.7, r: 0.385, j: [[1, 1]] }]);
  const g = globalThis as any;
  g.window = {};
  new Function(require("node:fs").readFileSync(__dirname + "/../../web/viewer3d.js", "utf8"))();
  assert.equal(g.window.SagebrushViewer3d.checkScene(big), null);
  // (the viewer's 15 px title times 1.3889 em: the SVG's 20.83 px)
  assert.match(svg(11), /<tspan font-size="20\.83">x<\/tspan><tspan font-size="14\.58" dy="-8\.02">2<\/tspan>/);
});
