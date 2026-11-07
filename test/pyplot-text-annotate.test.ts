// matplotlib text and annotations as matplotlib 3.11.1 draws them (each
// expected line is matplotlib's own output for the same figure, read from
// its artists where ours is read from the SVG): annotate's coordinates
// (textcoords, xycoords, offsets) and annotation_clip; text clipping (ax.text
// unclipped unless clip_on=True, annotations never); legend locations (the
// centred ones, a coordinate tuple, matplotlib's errors); bbox= boxes (style,
// pad, colors); lines of a multi-line text 1.2 em apart; arrowprops= arrows,
// every vertex of their paths (styles, arc3 bends, shrinking, linewidth,
// matplotlib's YAArrow look-alike); mathtext symbols, each the character
// matplotlib's parser gives (friction W13, W14, W15, W29, W30, W44).
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const run = (program: string) => {
  const dir = mkdtempSync(join(tmpdir(), "sb-text-"));
  try {
    return execFileSync(process.execPath, [__dirname + "/../src/cli.js", "-c", program], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 120000 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

test("annotate's coordinates, annotation_clip, text clipping, legend locations, bbox boxes, text lines: matplotlib 3.11.1's (W13, W15, W29, W44)", () => {
  const out = run("import matplotlib.pyplot as plt\nimport re\n\nH = 480\n\n\ndef svg_of(fig):\n    fig.savefig('t_text.svg')\n    plt.close(fig)\n    return open('t_text.svg').read()\n\n\ndef texts(svg):\n    \"\"\"[(string, x, y, clipped)] of the <text> elements, clipped if inside a clip-path group\"\"\"\n    out, stack = [], []\n    for m in re.finditer(r'<(/?)(g|text)\\b([^>]*)>([^<]*)', svg):\n        close, tag, attrs, body = m.groups()\n        if tag == 'g':\n            if close:\n                stack.pop()\n            elif not attrs.rstrip().endswith('/'):\n                stack.append('clip-path=' in attrs)\n        elif not close:\n            x = float(re.search(r' x=\"([-0-9.]+)\"', attrs).group(1))\n            y = float(re.search(r' y=\"([-0-9.]+)\"', attrs).group(1))\n            out.append((body, x, y, any(stack)))\n    return out\n\n\nfig = plt.figure()\nax = fig.add_axes([0.125, 0.11, 0.775, 0.77])\nax.set_xlim(0, 2); ax.set_ylim(0, 2)\ncases = [('offset points', (7, 7)), ('offset pixels', (7, -3)), ('offset fontsize', (1, 2)), ('axes fraction', (0.25, 0.75)),\n         ('figure fraction', (0.25, 0.75)), ('data', (1.5, 0.5)), ('axes pixels', (40, 30)), ('figure pixels', (40, 30)),\n         ('axes points', (40, 30)), ('figure points', (40, 30))]\nnames = {}\nfor i, (tc, xt) in enumerate(cases):\n    ax.annotate('A%d' % i, (1, 1), xytext=xt, textcoords=tc)\n    names['A%d' % i] = tc\nax.annotate('B1', (0.5, 0.25), xycoords='axes fraction')\nnames['B1'] = 'xy axes fraction'\nax.annotate('B2', (100, 50), xycoords='figure pixels', xytext=(-5, 10), textcoords='offset points')\nnames['B2'] = 'xy figure pixels, offset points'\nax.text(0.1, 0.9, 'TA', transform=ax.transAxes)\nnames['TA'] = 'ax.text transAxes'\nax.annotate('OUT', (3, 3))\nax.annotate('OUT2', (3, 3), annotation_clip=False)\nax.annotate('IN', (0.5, 0.5), xycoords='axes fraction', xytext=(0.5, 1.2), textcoords='axes fraction')\nax.annotate('OUTF', (1.5, 0.5), xycoords='axes fraction', annotation_clip=True)\nax.text(0.5, 2.2, 'T1')\nax.text(0.5, 2.2, 'T2', clip_on=True)\nax.set_xlim(0, 4)\nts = {s: (x, y, c) for s, x, y, c in texts(svg_of(fig))}\nfor s, name in names.items():\n    x, y, _ = ts[s]\n    print('anchor %s: %.2f %.2f' % (name, x, H - y))\nfor s in ['OUT', 'OUT2', 'IN', 'OUTF']:\n    print('drawn %s: %s' % (s, s in ts))\nfor s in ['T1', 'T2', 'IN']:\n    print('clipped %s: %s' % (s, ts[s][2]))\n\nfor loc in ['upper center', 'lower center', 'center left', 'center right', 'right', 'center', 9, 10, (0.1, 0.2)]:\n    fig = plt.figure()\n    ax = fig.add_axes([0.125, 0.11, 0.775, 0.77])\n    ax.plot([0, 1], [1, 1], label='a')\n    ax.legend(loc=loc)\n    m = re.search(r'<g class=\"sb-legend\"><rect x=\"([-0-9.]+)\" y=\"([-0-9.]+)\" width=\"([0-9.]+)\" height=\"([0-9.]+)\"', svg_of(fig))\n    x, y, w, h = map(float, m.groups())\n    if isinstance(loc, tuple):\n        print('legend %r: lower left %.2f %.2f' % (loc, x, H - (y + h)))\n        continue\n    name = loc if isinstance(loc, str) else ['best', 'upper right', 'upper left', 'lower left', 'lower right', 'right',\n                                             'center left', 'center right', 'lower center', 'upper center', 'center'][loc]\n    s = []\n    if 'left' not in name and 'right' not in name:\n        s.append('cx %.2f' % (x + w / 2))\n    if 'upper' not in name and 'lower' not in name:\n        s.append('cy %.2f' % (H - (y + h / 2)))\n    print('legend %r: %s' % (loc, ' '.join(s)))\nfor bad in ['middle', 11, -1, (1, 2, 3)]:\n    try:\n        ax.legend(loc=bad)\n        print('legend %r: accepted' % (bad,))\n    except Exception as e:\n        print('legend %r: %s: %s' % (bad, type(e).__name__, str(e).split(';')[0]))\n\nfor props in [dict(facecolor='#087f8c', edgecolor='none'), dict(), dict(boxstyle='round', fc='w'), dict(boxstyle='round,pad=0.5', ec='r', lw=2),\n              dict(pad=8, color='0.8'), dict(boxstyle='square', pad=0.2, alpha=0.5)]:\n    fig = plt.figure()\n    ax = fig.add_axes([0.125, 0.11, 0.775, 0.77])\n    ax.text(1, 1, 'x', fontsize=12, bbox=props)\n    svg = svg_of(fig)\n    m = re.search(r'<rect x=\"([-0-9.]+)\" y=\"[-0-9.]+\" width=\"[0-9.]+\" height=\"[0-9.]+\"( rx=\"[0-9.]+\")?([^>]*)/><text x=\"([-0-9.]+)\"', svg)\n    rx, rnd, attrs, tx = m.groups()\n    a = dict(re.findall(r'([a-z-]+)=\"([^\"]*)\"', attrs))\n    print('bbox %r: %s pad %.2f fc %s ec %s lw %.2f alpha %s' % (\n        props, 'round' if rnd else 'square', float(tx) - float(rx), a.get('fill'), a.get('stroke', 'none'),\n        float(a.get('stroke-width', 0)) if 'stroke' in a else props.get('lw', 1) * 100 / 72, a.get('opacity')))\n\nfig = plt.figure()\nax = fig.add_axes([0.125, 0.11, 0.775, 0.77])\nax.text(0.5, 0.5, 'one\\ntwo\\nthree', fontsize=10)\nt = [(s, y) for s, x, y, c in texts(svg_of(fig)) if s in ('one', 'two', 'three')]\nprint('lines: %s step %.1f' % ([s for s, y in t], t[1][1] - t[0][1]))\n");
  assert.deepEqual(out.trim().split("\n"), [
    "anchor offset points: 213.72 247.32",
    "anchor offset pixels: 211.00 234.60",
    "anchor offset fontsize: 217.89 265.38",
    "anchor axes fraction: 204.00 330.00",
    "anchor figure fraction: 160.00 360.00",
    "anchor data: 266.00 145.20",
    "anchor axes pixels: 120.00 82.80",
    "anchor figure pixels: 40.00 30.00",
    "anchor axes points: 135.56 94.47",
    "anchor figure points: 55.56 41.67",
    "anchor xy axes fraction: 328.00 145.20",
    "anchor xy figure pixels, offset points: 93.06 63.89",
    "anchor ax.text transAxes: 129.60 385.44",
    "drawn OUT: False",
    "drawn OUT2: True",
    "drawn IN: True",
    "drawn OUTF: False",
    "clipped T1: False",
    "clipped T2: True",
    "clipped IN: False",
    "legend 'upper center': cx 328.00",
    "legend 'lower center': cx 328.00",
    "legend 'center left': cy 237.60",
    "legend 'center right': cy 237.60",
    "legend 'right': cy 237.60",
    "legend 'center': cx 328.00 cy 237.60",
    "legend 9: cx 328.00",
    "legend 10: cx 328.00 cy 237.60",
    "legend (0.1, 0.2): lower left 129.60 126.72",
    "legend 'middle': ValueError: 'middle' is not a valid value for loc.",
    "legend 11: ValueError: loc must be string, coordinate tuple, or an integer 0-10, not 11",
    "legend -1: ValueError: loc must be string, coordinate tuple, or an integer 0-10, not -1",
    "legend (1, 2, 3): ValueError: loc must be string, coordinate tuple, or an integer 0-10, not (1, 2, 3)",
    "bbox {'facecolor': '#087f8c', 'edgecolor': 'none'}: square pad 5.50 fc #087f8c ec none lw 1.39 alpha None",
    "bbox {}: square pad 5.50 fc #1f77b4 ec #000000 lw 1.39 alpha None",
    "bbox {'boxstyle': 'round', 'fc': 'w'}: round pad 5.00 fc #ffffff ec #000000 lw 1.39 alpha None",
    "bbox {'boxstyle': 'round,pad=0.5', 'ec': 'r', 'lw': 2}: round pad 8.33 fc #1f77b4 ec #ff0000 lw 2.78 alpha None",
    "bbox {'pad': 8, 'color': '0.8'}: square pad 11.17 fc #cccccc ec #cccccc lw 1.39 alpha None",
    "bbox {'boxstyle': 'square', 'pad': 0.2, 'alpha': 0.5}: square pad 3.33 fc #1f77b4 ec #000000 lw 1.39 alpha 0.5",
    "lines: ['one', 'two', 'three'] step 16.7",
  ]);
});

test("arrowprops arrows: every vertex of matplotlib 3.11.1's paths (W14)", () => {
  const out = run("import matplotlib.pyplot as plt\nimport re\nCASES = [\n    dict(arrowstyle='->'),\n    dict(arrowstyle='->', lw=8, connectionstyle='arc3,rad=0.4'),\n    dict(arrowstyle='-|>', connectionstyle='arc3,rad=-0.3'),\n    dict(arrowstyle='<->', shrinkA=0, shrinkB=10),\n    dict(arrowstyle='<|-|>', lw=2),\n    dict(arrowstyle='-'),\n    dict(arrowstyle='->,head_length=0.8,head_width=0.5', mutation_scale=20),\n    dict(arrowstyle='simple'),\n    dict(arrowstyle='simple', connectionstyle='arc3,rad=0.3'),\n    dict(),\n    dict(shrink=0.1, width=2, headwidth=8),\n]\nfor ap in CASES:\n    fig = plt.figure()\n    ax = fig.add_axes([0.125, 0.11, 0.775, 0.77])\n    ax.set_xlim(0, 2); ax.set_ylim(0, 2)\n    ax.annotate('', xy=(1.5, 1.6), xytext=(0.3, 0.4), arrowprops=ap)\n    fig.savefig('t_arrow.svg')\n    plt.close(fig)\n    svg = open('t_arrow.svg').read()\n    out = []\n    for m in re.finditer(r'<path d=\"([^\"]*)\"([^>]*)stroke-linejoin=\"round\"', svg):\n        d, attrs = m.group(1), m.group(2)\n        nums = [float(v) for v in re.findall(r'-?[0-9.]+', d)]\n        pts = ['%.2f,%.2f' % (nums[i], 480 - nums[i + 1]) for i in range(0, len(nums), 2)]\n        if d.endswith('Z') and 'Q' in d:  # (matplotlib's outline lists its first point again)\n            pts.append(pts[0])\n        filled = 'fill=\"none\"' not in attrs\n        out.append(('F' if filled else 'S') + ' '.join(pts))\n    print(repr(ap), '|', ' / '.join(out))\n");
  assert.deepEqual(out.trim().split("\n"), [
    "{'arrowstyle': '->'} | S156.63,128.38 303.20,237.60 448.53,345.89 / S442.41,344.80 448.53,345.89 445.73,340.34",
    "{'arrowstyle': '->', 'lw': 8, 'connectionstyle': 'arc3,rad=0.4'} | S157.17,126.63 390.87,119.95 448.08,333.79 / S443.96,329.14 448.08,333.79 449.33,327.71",
    "{'arrowstyle': '-|>', 'connectionstyle': 'arc3,rad=-0.3'} | S155.46,129.29 237.52,325.74 447.69,348.03 / F441.87,350.21 447.69,348.03 442.46,344.68",
    "{'arrowstyle': '<->', 'shrinkA': 0, 'shrinkB': 10} | S155.65,127.65 297.63,233.45 439.62,339.25 / S161.76,128.74 155.65,127.65 158.44,133.19 / S433.50,338.16 439.62,339.25 436.82,333.71",
    "{'arrowstyle': '<|-|>', 'lw': 2} | S159.12,130.24 303.20,237.60 447.28,344.96 / F165.23,131.33 159.12,130.24 161.91,135.78 / F441.17,343.87 447.28,344.96 444.49,339.42",
    "{'arrowstyle': '-'} | S156.63,128.38 303.20,237.60 449.77,346.82",
    "{'arrowstyle': '->,head_length=0.8,head_width=0.5', 'mutation_scale': 20} | S156.63,128.38 303.20,237.60 448.72,346.04 / S422.60,343.90 448.72,346.04 439.20,321.62",
    "{'arrowstyle': 'simple'} | F155.80,129.49 299.59,236.64 443.37,343.78 442.13,345.46 445.95,346.14 449.77,346.82 448.03,343.35 446.28,339.89 445.03,341.56 301.25,234.41 157.46,127.27 155.80,129.49",
    "{'arrowstyle': 'simple', 'connectionstyle': 'arc3,rad=0.3'} | F157.02,128.39 364.46,150.39 446.94,340.08 445.03,340.91 447.99,343.36 450.94,345.91 451.19,342.02 451.40,338.14 449.49,338.97 366.36,147.80 157.31,125.62 157.02,128.39",
    "{} | F152.74,128.95 294.86,234.85 436.97,340.75 433.65,345.20 442.83,346.84 452.00,348.48 447.81,340.16 443.61,331.84 440.29,336.29 298.18,230.39 156.06,124.49 152.74,128.95",
    "{'shrink': 0.1, 'width': 2, 'headwidth': 8} | F183.33,150.01 295.69,233.73 408.05,317.46 405.56,320.80 413.90,323.55 422.24,326.30 417.22,319.10 412.20,311.89 409.71,315.23 297.35,231.51 184.99,147.78 183.33,150.01",
  ]);
});

test("mathtext symbols: the characters matplotlib 3.11.1's parser gives (W30)", () => {
  const out = run("import matplotlib.pyplot as plt\nimport re\nimport html\n\nnames = 'neg wedge vee forall exists nexists Leftarrow Leftrightarrow leftrightarrow Longrightarrow Longleftarrow Longleftrightarrow longrightarrow longleftarrow longleftrightarrow mapsto longmapsto hookrightarrow hookleftarrow uparrow downarrow updownarrow Uparrow Downarrow nearrow searrow swarrow nwarrow rightleftharpoons leftrightarrows rightharpoonup leadsto top bot vdash dashv models cup cap subset subseteq supset supseteq subsetneq supsetneq setminus smallsetminus emptyset varnothing notin ni sqcup sqcap sqsubseteq sqsupseteq uplus ll gg prec succ preceq succeq cong perp parallel mid nmid leqslant geqslant asymp doteq lesssim gtrsim nleq ngeq nsim ncong nequiv oplus otimes ominus odot oslash ast star bullet dagger ddagger amalg wr diamond triangleleft triangleright bigtriangleup bigtriangledown bigcup bigcap bigoplus bigotimes bigodot bigsqcup biguplus bigvee bigwedge coprod iint iiint oiint aleph beth gimel daleth wp angle measuredangle triangle checkmark therefore because lfloor rfloor lceil rceil lbrace rbrace vert Vert backslash imath jmath flat sharp natural clubsuit diamondsuit heartsuit spadesuit S P copyright varkappa digamma mho hslash Finv Game complement ddots vdots colon slash circledR blacksquare lhd rhd unlhd unrhd intercal barwedge veebar pitchfork bowtie rightarrowtail twoheadrightarrow circlearrowleft circlearrowright curvearrowleft curvearrowright'.split()\nextra = [r'\\mathfrak{g}', r'\\mathscr{L}', r'\\mathfrak{R}']\nfig = plt.figure()\nax = fig.add_axes([0.125, 0.11, 0.775, 0.77])\nsrcs = ['\\\\' + n for n in names] + extra\nfor i, s in enumerate(srcs):\n    ax.text(0.5, 0.5, 'Q%d $%s$' % (i, s))\nfig.savefig('t_sym.svg')\nsvg = open('t_sym.svg').read()\ngot = {}\nfor m in re.finditer(r'<text\\b[^>]*>(.*?)</text>', svg):\n    t = html.unescape(re.sub(r'<[^>]*>', '', m.group(1)))\n    k, _, v = t.partition(' ')\n    if k.startswith('Q'):\n        got[int(k[1:])] = v.strip('  ​ ')\nfor i, s in enumerate(srcs):\n    print('%s %s' % (s[1:] if i < len(names) else s, got[i]))\n");
  assert.deepEqual(out.trim().split("\n"), [
    "neg ¬",
    "wedge ∧",
    "vee ∨",
    "forall ∀",
    "exists ∃",
    "nexists ∄",
    "Leftarrow ⇐",
    "Leftrightarrow ⇔",
    "leftrightarrow ↔",
    "Longrightarrow ⟹",
    "Longleftarrow ⟸",
    "Longleftrightarrow ⟺",
    "longrightarrow ⟶",
    "longleftarrow ⟵",
    "longleftrightarrow ⟷",
    "mapsto ↦",
    "longmapsto ⟼",
    "hookrightarrow ↪",
    "hookleftarrow ↩",
    "uparrow ↑",
    "downarrow ↓",
    "updownarrow ↕",
    "Uparrow ⇑",
    "Downarrow ⇓",
    "nearrow ↗",
    "searrow ↘",
    "swarrow ↙",
    "nwarrow ↖",
    "rightleftharpoons ⇌",
    "leftrightarrows ⇆",
    "rightharpoonup ⇀",
    "leadsto ⇝",
    "top ⊤",
    "bot ⊥",
    "vdash ⊢",
    "dashv ⊣",
    "models ⊧",
    "cup ∪",
    "cap ∩",
    "subset ⊂",
    "subseteq ⊆",
    "supset ⊃",
    "supseteq ⊇",
    "subsetneq ⊊",
    "supsetneq ⊋",
    "setminus ∖",
    "smallsetminus ∖",
    "emptyset ∅",
    "varnothing ∅",
    "notin ∉",
    "ni ∋",
    "sqcup ⊔",
    "sqcap ⊓",
    "sqsubseteq ⊑",
    "sqsupseteq ⊒",
    "uplus ⊎",
    "ll ≪",
    "gg ≫",
    "prec ≺",
    "succ ≻",
    "preceq ≼",
    "succeq ≽",
    "cong ≅",
    "perp ⟂",
    "parallel ∥",
    "mid ∣",
    "nmid ∤",
    "leqslant ⩽",
    "geqslant ⩾",
    "asymp ≍",
    "doteq ≐",
    "lesssim ≲",
    "gtrsim ≳",
    "nleq ≰",
    "ngeq ≱",
    "nsim ≁",
    "ncong ≇",
    "nequiv ≢",
    "oplus ⊕",
    "otimes ⊗",
    "ominus ⊖",
    "odot ⊙",
    "oslash ⊘",
    "ast ∗",
    "star ⋆",
    "bullet ∙",
    "dagger †",
    "ddagger ‡",
    "amalg ⨿",
    "wr ≀",
    "diamond ⋄",
    "triangleleft ◁",
    "triangleright ▷",
    "bigtriangleup △",
    "bigtriangledown ▽",
    "bigcup ⋃",
    "bigcap ⋂",
    "bigoplus ⨁",
    "bigotimes ⨂",
    "bigodot ⨀",
    "bigsqcup ⨆",
    "biguplus ⨄",
    "bigvee ⋁",
    "bigwedge ⋀",
    "coprod ∐",
    "iint ∬",
    "iiint ∭",
    "oiint ∯",
    "aleph ℵ",
    "beth ℶ",
    "gimel ℷ",
    "daleth ℸ",
    "wp ℘",
    "angle ∠",
    "measuredangle ∡",
    "triangle △",
    "checkmark ✓",
    "therefore ∴",
    "because ∵",
    "lfloor ⌊",
    "rfloor ⌋",
    "lceil ⌈",
    "rceil ⌉",
    "lbrace {",
    "rbrace }",
    "vert |",
    "Vert ‖",
    "backslash \\",
    "imath ı",
    "jmath ȷ",
    "flat ♭",
    "sharp ♯",
    "natural ♮",
    "clubsuit ♣",
    "diamondsuit ♢",
    "heartsuit ♡",
    "spadesuit ♠",
    "S §",
    "P ¶",
    "copyright ©",
    "varkappa ϰ",
    "digamma ϝ",
    "mho ℧",
    "hslash ℏ",
    "Finv Ⅎ",
    "Game ⅁",
    "complement ∁",
    "ddots ⋱",
    "vdots ⋮",
    "colon :",
    "slash ∕",
    "circledR ®",
    "blacksquare ■",
    "lhd ◁",
    "rhd ▷",
    "unlhd ⊴",
    "unrhd ⊵",
    "intercal ⊺",
    "barwedge ⊼",
    "veebar ⊻",
    "pitchfork ⋔",
    "bowtie ⋈",
    "rightarrowtail ↣",
    "twoheadrightarrow ↠",
    "circlearrowleft ↺",
    "circlearrowright ↻",
    "curvearrowleft ↶",
    "curvearrowright ↷",
    "\\mathfrak{g} 𝔤",
    "\\mathscr{L} ℒ",
    "\\mathfrak{R} ℜ",
  ]);
});

// (Sagebrush's own: matplotlib draws \mathbb and \mathcal from its fonts'
// private-use glyphs, Sagebrush with Unicode's mathematical letters for them)
test("\\mathbb, \\mathcal, multi-line text and a text box in a saved SVG (W29, W30, W44)", () => {
  const out = run("import matplotlib.pyplot as plt\nfig, ax = plt.subplots()\nax.set_ylabel(r'$\\mathbb{F}_2$')\nax.set_title(r'$\\mathcal{O}_K \\subseteq \\mathbb{Q}$')\nax.text(0.5, 0.5, 'one\\ntwo', va='top')\nax.text(0.2, 0.2, 'test', color='white', bbox=dict(facecolor='#087f8c', edgecolor='none'))\nfig.savefig('own.svg')\nsvg = open('own.svg').read()\nsvg = svg[svg.index('</title>'):]  # (what is drawn: not the description, which keeps the source)\nprint('F2', '\\U0001d53d' in svg, 'mathbb' in svg)\nprint('O_K', '\\U0001d4aa' in svg, 'ℚ' in svg, 'mathcal' in svg)\nprint('lines', svg.count('>one</text>'), svg.count('>two</text>'), 'one\\ntwo' in svg)\nprint('box', 'fill=\"#087f8c\"' in svg)\n");
  assert.deepEqual(out.trim().split("\n"), [
    "F2 True False",
    "O_K True True False",
    "lines 1 1 False",
    "box True",
  ]);
});

test("arrows of huge, infinite and NaN coordinates: drawn as matplotlib 3.11.1 draws them (ANNOT-LOOP-1)", () => {
  // (matplotlib draws not a pixel of a curve arrow with an infinite or NaN
  // point, given or reached on the way from finite ends near the double limit
  // ("edge" rows: its path's points come out non-finite; "wide" rows: a
  // finite curve whose arrow overflows, as its (1 - t) p + t q splits keep
  // the curve finite); Sagebrush draws no arrow.  matplotlib raises for a "simple" arrow's (ValueError) and an
  // infinite xytext (StopIteration), and so does Sagebrush, when drawn)
  const out = run("import matplotlib.pyplot as plt\nimport math\nimport re\n\nCASES = [\n    ('ordinary', dict(xy=(1.5, 1.6), xytext=(0.3, 0.4)), dict(arrowstyle='->')),\n    ('huge xy', dict(xy=(1e300, 1.6), xytext=(0.3, 0.4), annotation_clip=False), dict(arrowstyle='->')),\n    ('huge xy text', dict(xy=(1e300, 1.6), xytext=(0.3, 0.4), annotation_clip=False, text='T'), dict(arrowstyle='->')),\n    ('huge both', dict(xy=(1e300, 1e300), xytext=(-1e300, -1e300), annotation_clip=False), dict(arrowstyle='->')),\n    ('huge simple', dict(xy=(1e300, 1.6), xytext=(0.3, 0.4), annotation_clip=False), dict(arrowstyle='simple')),\n    ('huge default', dict(xy=(1e300, 1.6), xytext=(0.3, 0.4), annotation_clip=False), dict()),\n    ('1e17 offset', dict(xy=(1e17, 1.6), xytext=(1e17 + 1, 0.4), annotation_clip=False), dict(arrowstyle='->')),\n    ('same point', dict(xy=(1, 1), xytext=(1, 1)), dict(arrowstyle='->')),\n    ('inf xy', dict(xy=(math.inf, 1.6), xytext=(0.3, 0.4), annotation_clip=False), dict(arrowstyle='->')),\n    ('nan xy', dict(xy=(math.nan, 1.6), xytext=(0.3, 0.4), annotation_clip=False), dict(arrowstyle='->')),\n    ('nan rad', dict(xy=(1.5, 1.6), xytext=(0.3, 0.4)), dict(arrowstyle='->', connectionstyle='arc3,rad=nan')),\n    ('huge rad', dict(xy=(1.5, 1.6), xytext=(0.3, 0.4)), dict(arrowstyle='->', connectionstyle='arc3,rad=1e300')),\n    ('edge both', dict(xy=(6e305, 6e305), xytext=(-6e305, -6e305), annotation_clip=False), dict(arrowstyle='->')),\n    ('edge x', dict(xy=(7e305, 1.6), xytext=(-7e305, 0.4), annotation_clip=False), dict(arrowstyle='->')),\n    ('edge x <->', dict(xy=(7e305, 1.6), xytext=(-7e305, 0.4), annotation_clip=False), dict(arrowstyle='<->')),\n    ('edge x text', dict(xy=(7e305, 1.6), xytext=(-7e305, 0.4), annotation_clip=False, text='T'), dict(arrowstyle='->')),\n    ('edge x simple', dict(xy=(7e305, 1.6), xytext=(-7e305, 0.4), annotation_clip=False), dict(arrowstyle='simple')),\n    ('edge x default', dict(xy=(7e305, 1.6), xytext=(-7e305, 0.4), annotation_clip=False), dict()),\n    ('edge one', dict(xy=(7.2e305, 1.6), xytext=(0.3, 0.4), annotation_clip=False), dict(arrowstyle='->')),\n    ('edge rad', dict(xy=(3e305, 1.6), xytext=(-3e305, 0.4), annotation_clip=False), dict(arrowstyle='->', connectionstyle='arc3,rad=0.5')),\n    ('rad 1e305 simple', dict(xy=(1.5, 1.6), xytext=(0.3, 0.4)), dict(arrowstyle='simple', connectionstyle='arc3,rad=1e305')),\n    ('inf xy simple', dict(xy=(math.inf, 1.6), xytext=(0.3, 0.4), annotation_clip=False), dict(arrowstyle='simple')),\n    ('inf xytext', dict(xy=(1.5, 1.6), xytext=(math.inf, 0.4)), dict(arrowstyle='->')),\n    ('wide rad 1 ->', dict(xy=(3.59e305, 4.8e305), xytext=(-3.59e305, -4.8e305), annotation_clip=False), dict(arrowstyle='->', connectionstyle='arc3,rad=1')),\n    ('wide rad 1 simple', dict(xy=(3.59e305, 4.8e305), xytext=(-3.59e305, -4.8e305), annotation_clip=False), dict(arrowstyle='simple', connectionstyle='arc3,rad=1')),\n    ('wide rad 1 default', dict(xy=(3.59e305, 4.8e305), xytext=(-3.59e305, -4.8e305), annotation_clip=False), dict(connectionstyle='arc3,rad=1')),\n    ('split far', dict(xy=(0.0, 0.5e308 / 184.8), xytext=(-1e308 / 248, -0.5e308 / 184.8), annotation_clip=False), dict(arrowstyle='-', connectionstyle='arc3,rad=1.5')),\n]\nfor name, kw, ap in CASES:\n    fig = plt.figure()\n    ax = fig.add_axes([0.125, 0.11, 0.775, 0.77])\n    ax.set_xlim(0, 2); ax.set_ylim(0, 2)\n    kw = dict(kw)\n    text = kw.pop('text', '')\n    try:\n        ax.annotate(text, arrowprops=ap, **kw)\n        fig.savefig('t_loop.svg')\n        svg = open('t_loop.svg').read()\n        paths = re.findall(r'<path d=\"([^\"]*)\"[^>]*stroke-linejoin=\"round\"', svg)\n        if not paths:\n            print(name, '=> no arrow')\n            continue\n        vs = []\n        for d in paths:\n            nums = re.findall(r'-?[0-9.]+(?:e[-+]?[0-9]+)?|nan|inf', d)\n            n = len(nums) // 2 + (1 if d.endswith('Z') and 'Q' in d else 0)\n            vs.append(n)\n            fin = all(v not in ('nan', 'inf') for v in nums)\n        print(name, '=> drawn, %d vertices, all finite: %s' % (sum(vs), fin))\n    except Exception as e:\n        print(name, '!!', type(e).__name__, (str(e).splitlines() or [''])[0][:100])\n    plt.close(fig)\n");
  assert.deepEqual(out.trim().split("\n"), [
    "ordinary => drawn, 6 vertices, all finite: True",
    "huge xy => drawn, 6 vertices, all finite: True",
    "huge xy text => drawn, 6 vertices, all finite: True",
    "huge both => drawn, 6 vertices, all finite: True",
    "huge simple => drawn, 12 vertices, all finite: True",
    "huge default => drawn, 12 vertices, all finite: True",
    "1e17 offset => drawn, 6 vertices, all finite: True",
    "same point => drawn, 3 vertices, all finite: True",
    "inf xy => no arrow",
    "nan xy => no arrow",
    "nan rad => no arrow",
    "huge rad => drawn, 6 vertices, all finite: True",
    "edge both => no arrow",
    "edge x => no arrow",
    "edge x <-> => no arrow",
    "edge x text => no arrow",
    "edge x simple !! ValueError 'path' is not a valid quadratic Bezier curve",
    "edge x default !! ValueError 'path' is not a valid quadratic Bezier curve",
    "edge one => drawn, 6 vertices, all finite: True",
    "edge rad => drawn, 6 vertices, all finite: True",
    "rad 1e305 simple => drawn, 12 vertices, all finite: True",
    "inf xy simple !! ValueError 'path' is not a valid quadratic Bezier curve",
    "inf xytext !! StopIteration ",
    "wide rad 1 -> => no arrow",
    "wide rad 1 simple => no arrow",
    "wide rad 1 default => no arrow",
    "split far => drawn, 3 vertices, all finite: True",
  ]);
});

test("the bisection ends where halving no longer moves the point (ANNOT-LOOP-1)", () => {
  const out = run("from matplotlib._annotations import _clip_parts\n# (at 1e300 halving the parameter soon stops moving the point, though the\n# ends are still far apart: the bisection stops there, as matplotlib's)\nleft, right = _clip_parts([(0.0, 0.0), (1e300, 0.0), (2e300, 0.0)], lambda x, y: x < 1e300 + 1)\nprint(left[2] == right[0], 9e299 < left[2][0] < 1.1e300)\n");
  assert.deepEqual(out.trim().split("\n"), ["True True"]);
});

test("style names, parameters and annotate's arguments refused as matplotlib 3.11.1 refuses them (ANNOT-STYLE-PARAM-1, ANNOT-SIGNATURE-1)", () => {
  const out = run("import matplotlib\nif 'site-packages' in (getattr(matplotlib, '__file__', '') or ''):\n    matplotlib.use('Agg')\nimport matplotlib.pyplot as plt\nfig = plt.figure()\nax = fig.add_axes([0.125, 0.11, 0.775, 0.77])\n\n\ndef t(label, f):\n    try:\n        f()\n        fig.savefig('t_err.svg')\n        print(label, 'ok')\n    except Exception as e:\n        print(label, '!!', type(e).__name__, str(e)[:200])\n    for a in list(ax.texts) if hasattr(ax, 'texts') else []:\n        a.remove()\n\n\nt('arc3,foo=1', lambda: ax.annotate('', (1, 1), (0, 0), arrowprops=dict(arrowstyle='->', connectionstyle='arc3,foo=1')))\nt('->,foo=1', lambda: ax.annotate('', (1, 1), (0, 0), arrowprops=dict(arrowstyle='->,foo=1')))\nt('->,widthA=2', lambda: ax.annotate('', (1, 1), (0, 0), arrowprops=dict(arrowstyle='->,widthA=2')))\nt('simple,foo=1', lambda: ax.annotate('', (1, 1), (0, 0), arrowprops=dict(arrowstyle='simple,foo=1')))\nt('round,foo=1', lambda: ax.text(0, 0, 'x', bbox=dict(boxstyle='round,foo=1')))\nt('square,foo=1', lambda: ax.text(0, 0, 'x', bbox=dict(boxstyle='square,foo=1')))\nt('round,rounding_size=0.2', lambda: ax.text(0, 0, 'x', bbox=dict(boxstyle='round,rounding_size=0.2')))\nt('arrowstyle zz', lambda: ax.annotate('', (1, 1), (0, 0), arrowprops=dict(arrowstyle='zz')))\nt('connectionstyle zz', lambda: ax.annotate('', (1, 1), (0, 0), arrowprops=dict(arrowstyle='->', connectionstyle='zz')))\nt('boxstyle zz', lambda: ax.text(0, 0, 'x', bbox=dict(boxstyle='zz')))\nt('->,head_length=x', lambda: ax.annotate('', (1, 1), (0, 0), arrowprops=dict(arrowstyle='->,head_length=x')))\nt('8 positional', lambda: ax.annotate('t', (1, 1), (0, 0), 'data', 'data', None, None))\ntry:\n    ax.annotate('t', (1, 1), (0, 0), 'data', 'data', None, None, 12)\n    print('9 positional ok')\nexcept TypeError:\n    print('9 positional !! TypeError')\nt('fontsize keyword', lambda: ax.annotate('t', (1, 1), fontsize=12))\n");
  assert.deepEqual(out.trim().split("\n"), [
    "arc3,foo=1 !! TypeError ConnectionStyle.Arc3.__init__() got an unexpected keyword argument 'foo'",
    "->,foo=1 !! TypeError ArrowStyle._Curve.__init__() got an unexpected keyword argument 'foo'",
    "->,widthA=2 ok",
    "simple,foo=1 !! TypeError ArrowStyle.Simple.__init__() got an unexpected keyword argument 'foo'",
    "round,foo=1 !! TypeError BoxStyle.Round.__init__() got an unexpected keyword argument 'foo'",
    "square,foo=1 !! TypeError BoxStyle.Square.__init__() got an unexpected keyword argument 'foo'",
    "round,rounding_size=0.2 ok",
    "arrowstyle zz !! ValueError Unknown style: 'zz'",
    "connectionstyle zz !! ValueError Unknown style: 'zz'",
    "boxstyle zz !! ValueError Unknown style: 'zz,pad=0.30'",
    "->,head_length=x !! ValueError Incorrect style argument: '->,head_length=x'",
    "8 positional ok",
    "9 positional !! TypeError",
    "fontsize keyword ok",
  ]);
});

// (each expected line matplotlib 3.11.1's own, for the same program: the
// errors it raises, and when, annotate() or the drawing (savefig): an offset
// unit as xycoords at once; an unknown coordinate or unit, a style that is
// neither a string nor a style object (it calls it), a "simple" arrow whose
// path is not finite (given so, or overflowed from finite ends near the
// double limit) and an infinite xytext, each when drawn, and only if drawn)
test("annotate's errors, and when matplotlib 3.11.1 raises them (#801 S5, C5, N8)", () => {
  const out = run("import matplotlib\nREAL = 'site-packages' in (getattr(matplotlib, '__file__', '') or '')\nif REAL:\n    matplotlib.use('Agg')\nimport matplotlib.pyplot as plt, math\nclass Obj: pass\ndef t(label, kw, ap=None, bbox=None):\n    fig = plt.figure(); ax = fig.add_axes([0.125, 0.11, 0.775, 0.77]); ax.set_xlim(0, 2); ax.set_ylim(0, 2)\n    try:\n        extra = {}\n        if ap is not None: extra['arrowprops'] = ap\n        if bbox is not None: extra['bbox'] = bbox\n        ax.annotate(kw.pop('text', ''), **kw, **extra)\n    except Exception as e:\n        print(label, 'annotate !!', type(e).__name__, str(e)[:120]); plt.close(fig); return\n    try:\n        fig.savefig('t_when.svg'); print(label, 'ok')\n    except Exception as e:\n        print(label, 'savefig !!', type(e).__name__, str(e)[:120])\n    plt.close(fig)\nt('C5 offset points', dict(xy=(1, 2), xycoords='offset points'))\nt('C5 bogus xycoords', dict(xy=(1, 2), xycoords='bogus'))\nt('C5 bogus textcoords', dict(xy=(1, 1), xytext=(0, 0), textcoords='bogus'))\nt('S5 arrowstyle Obj', dict(xy=(1, 1), xytext=(0.2, 0.2)), dict(arrowstyle=Obj()))\nt('S5 arrowstyle 5', dict(xy=(1, 1), xytext=(0.2, 0.2)), dict(arrowstyle=5))\nt('S5 connectionstyle Obj', dict(xy=(1, 1), xytext=(0.2, 0.2)), dict(arrowstyle='->', connectionstyle=Obj()))\nt('S5 boxstyle Obj', dict(xy=(1, 1), text='t'), None, dict(boxstyle=Obj()))\nt('S5 boxstyle 5', dict(xy=(1, 1), text='t'), None, dict(boxstyle=5))\nt('S5 bbox boxstyle Obj text', dict(xy=(1, 1), text='t'), None, dict(boxstyle=Obj(), pad=0.5))\nt('N8 inf xy simple', dict(xy=(math.inf, 1.6), xytext=(0.3, 0.4), annotation_clip=False), dict(arrowstyle='simple'))\nt('N8 inf xy default', dict(xy=(math.inf, 1.6), xytext=(0.3, 0.4), annotation_clip=False), dict())\nt('N8 nan rad simple', dict(xy=(1.5, 1.6), xytext=(0.3, 0.4)), dict(arrowstyle='simple', connectionstyle='arc3,rad=nan'))\nt('N8 edge x simple', dict(xy=(7e305, 1.6), xytext=(-7e305, 0.4), annotation_clip=False), dict(arrowstyle='simple'))\nt('N8 edge x default', dict(xy=(7e305, 1.6), xytext=(-7e305, 0.4), annotation_clip=False), dict())\nt('N8 edge x ->', dict(xy=(7e305, 1.6), xytext=(-7e305, 0.4), annotation_clip=False), dict(arrowstyle='->'))\nt('N8 inf xy ->', dict(xy=(math.inf, 1.6), xytext=(0.3, 0.4), annotation_clip=False), dict(arrowstyle='->'))\n\ndef u(label, **kw):\n    fig = plt.figure(); ax = fig.add_axes([0.125, 0.11, 0.775, 0.77]); ax.set_xlim(0, 2); ax.set_ylim(0, 2)\n    try:\n        ax.annotate(kw.pop('text', ''), **kw)\n        fig.savefig('t_inf.svg'); print(label, 'ok')\n    except Exception as e:\n        print(label, '!!', type(e).__name__, str(e)[:80])\n    plt.close(fig)\nu('inf xytext ->', xy=(1.5, 1.6), xytext=(math.inf, 0.4), arrowprops=dict(arrowstyle='->'))\nu('nan xytext ->', xy=(1.5, 1.6), xytext=(math.nan, 0.4), arrowprops=dict(arrowstyle='->'))\nu('-inf ytext ->', xy=(1.5, 1.6), xytext=(0.4, -math.inf), arrowprops=dict(arrowstyle='->'))\nu('inf xytext no arrow', xy=(1.5, 1.6), xytext=(math.inf, 0.4), text='T')\nu('inf xytext text ->', xy=(1.5, 1.6), xytext=(math.inf, 0.4), text='T', arrowprops=dict(arrowstyle='->'))\nu('inf xytext xy outside ->', xy=(5, 5), xytext=(math.inf, 0.4), arrowprops=dict(arrowstyle='->'))\nu('inf xytext offset ->', xy=(1.5, 1.6), xytext=(math.inf, 10), textcoords='offset points', arrowprops=dict(arrowstyle='->'))\nu('huge xytext 1e306 ->', xy=(1.5, 1.6), xytext=(1e306, 0.4), annotation_clip=False, arrowprops=dict(arrowstyle='->'))\nu('inf xy and xytext ->', xy=(math.inf, 1.6), xytext=(math.inf, 0.4), annotation_clip=False, arrowprops=dict(arrowstyle='->'))\n\ndef v(label, f):\n    fig, ax = plt.subplots()\n    try:\n        f(ax)\n    except Exception as e:\n        print(label, 'annotate !!', type(e).__name__, str(e)[:120]); plt.close(fig); return\n    try:\n        fig.savefig('t2.svg'); print(label, 'ok')\n    except Exception as e:\n        print(label, 'savefig !!', type(e).__name__, str(e)[:120])\n    plt.close(fig)\nv('offset bogus', lambda ax: ax.annotate('t', (1, 1), xycoords='offset bogus'))\nv('textcoords offset bogus', lambda ax: ax.annotate('t', (1, 1), (0, 0), textcoords='offset bogus'))\nv('both bad', lambda ax: ax.annotate('t', (1, 1), (0, 0), xycoords='bogus', arrowprops=dict(arrowstyle=5)))\nv('bad style and offset xy', lambda ax: ax.annotate('t', (1, 1), xycoords='offset points', arrowprops=dict(arrowstyle=5)))\nv('arrowstyle 5 clipped', lambda ax: ax.annotate('t', (5, 5), (0.5, 0.5), arrowprops=dict(arrowstyle=5)))\nv('text bbox 5', lambda ax: ax.text(0.5, 0.5, 't', bbox=dict(boxstyle=5)))\n");
  assert.deepEqual(out.trim().split("\n").map((l) => l.trimEnd()), [
    "C5 offset points annotate !! ValueError xycoords cannot be an offset coordinate",
    "C5 bogus xycoords savefig !! ValueError 'bogus' is not a valid coordinate",
    "C5 bogus textcoords savefig !! ValueError 'bogus' is not a valid coordinate",
    "S5 arrowstyle Obj savefig !! TypeError 'Obj' object is not callable",
    "S5 arrowstyle 5 savefig !! TypeError 'int' object is not callable",
    "S5 connectionstyle Obj savefig !! TypeError 'Obj' object is not callable",
    "S5 boxstyle Obj savefig !! TypeError 'Obj' object is not callable",
    "S5 boxstyle 5 savefig !! TypeError 'int' object is not callable",
    "S5 bbox boxstyle Obj text savefig !! TypeError 'Obj' object is not callable",
    "N8 inf xy simple savefig !! ValueError 'path' is not a valid quadratic Bezier curve",
    "N8 inf xy default savefig !! ValueError 'path' is not a valid quadratic Bezier curve",
    "N8 nan rad simple savefig !! ValueError 'path' is not a valid quadratic Bezier curve",
    "N8 edge x simple savefig !! ValueError 'path' is not a valid quadratic Bezier curve",
    "N8 edge x default savefig !! ValueError 'path' is not a valid quadratic Bezier curve",
    "N8 edge x -> ok",
    "N8 inf xy -> ok",
    "inf xytext -> !! StopIteration",
    "nan xytext -> !! StopIteration",
    "-inf ytext -> !! StopIteration",
    "inf xytext no arrow ok",
    "inf xytext text -> !! StopIteration",
    "inf xytext xy outside -> ok",
    "inf xytext offset -> !! StopIteration",
    "huge xytext 1e306 -> ok",
    "inf xy and xytext -> !! StopIteration",
    "offset bogus annotate !! ValueError xycoords cannot be an offset coordinate",
    "textcoords offset bogus savefig !! ValueError 'bogus' is not a recognized unit",
    "both bad savefig !! ValueError 'bogus' is not a valid coordinate",
    "bad style and offset xy annotate !! ValueError xycoords cannot be an offset coordinate",
    "arrowstyle 5 clipped ok",
    "text bbox 5 savefig !! TypeError 'int' object is not callable",
  ]);
});

// (Sagebrush's own: a style object of matplotlib's, which matplotlib calls,
// is refused; give the style as a string)
test("a style given as an object is refused, not implemented here (#801 S5)", () => {
  const out = run("import matplotlib.pyplot as plt\nstyle = lambda *a, **k: None\nfor kw in (dict(arrowprops=dict(arrowstyle=style)), dict(arrowprops=dict(arrowstyle='->', connectionstyle=style)), dict(bbox=dict(boxstyle=style))):\n    fig, ax = plt.subplots()\n    try:\n        ax.annotate('t', (1, 1), (0, 0), **kw)\n        print('accepted')\n    except Exception as e:\n        print(type(e).__name__, e)\n    plt.close(fig)\n");
  assert.deepEqual(out.trim().split("\n"), [
    "NotImplementedError a arrowstyle object is not implemented in Sagebrush; give the style as a string, such as '->'",
    "NotImplementedError a connectionstyle object is not implemented in Sagebrush; give the style as a string, such as 'arc3,rad=0.2'",
    "NotImplementedError a boxstyle object is not implemented in Sagebrush; give the style as a string, such as 'round,pad=0.3'",
  ]);
});

// (matplotlib 3.11.1 resolves each coordinate system when it uses it: bad
// textcoords raise only if the annotation is drawn (annotation_clip hides one
// outside the axes, by default and with True); bad xycoords only for the clip
// check (annotation_clip=True), an arrow or offset text; each line its own)
test("bad coordinates raise as matplotlib 3.11.1's, only where it uses them (#801 ANNOT-TEXTCOORDS-CLIP-1)", () => {
  const out = run("import matplotlib\nREAL = 'site-packages' in (getattr(matplotlib, '__file__', '') or '')\nif REAL:\n    matplotlib.use('Agg')\nimport matplotlib.pyplot as plt\ndef t(label, f):\n    fig, ax = plt.subplots()\n    try:\n        f(ax)\n    except Exception as e:\n        print(label, 'annotate !!', type(e).__name__, str(e)[:100]); plt.close(fig); return\n    for i in range(3):\n        try:\n            fig.savefig('c4.svg'); print(label, 'draw', i, 'ok')\n        except Exception as e:\n            print(label, 'draw', i, '!!', type(e).__name__, str(e)[:100])\n    plt.close(fig)\nfor clip in (None, True, False):\n    t('textcoords bogus, outside, clip=%s' % clip, lambda ax: ax.annotate('t', (5, 5), (0, 0), textcoords='bogus', annotation_clip=clip))\nt('textcoords bogus, inside', lambda ax: ax.annotate('t', (0.5, 0.5), (0, 0), textcoords='bogus'))\nfor clip in (None, True, False):\n    t('xycoords bogus, clip=%s' % clip, lambda ax: ax.annotate('t', (5, 5), (0, 0), xycoords='bogus', textcoords='data', annotation_clip=clip))\nfor clip in (None, True, False):\n    t('textcoords offset bogus, outside, clip=%s' % clip, lambda ax: ax.annotate('t', (5, 5), (0, 0), textcoords='offset bogus', annotation_clip=clip))\nt('arrowstyle 5, outside, clip=False', lambda ax: ax.annotate('t', (5, 5), (0.5, 0.5), annotation_clip=False, arrowprops=dict(arrowstyle=5)))\nt('text bbox 5', lambda ax: ax.text(0.5, 0.5, 't', bbox=dict(boxstyle=5)))\nt('inf xytext, inside', lambda ax: ax.annotate('t', (0.5, 0.5), (float('inf'), 0), arrowprops=dict(arrowstyle='->')))\n");
  assert.deepEqual(out.trim().split("\n").map((l) => l.trimEnd()), [
    "textcoords bogus, outside, clip=None draw 0 ok",
    "textcoords bogus, outside, clip=None draw 1 ok",
    "textcoords bogus, outside, clip=None draw 2 ok",
    "textcoords bogus, outside, clip=True draw 0 ok",
    "textcoords bogus, outside, clip=True draw 1 ok",
    "textcoords bogus, outside, clip=True draw 2 ok",
    "textcoords bogus, outside, clip=False draw 0 !! ValueError 'bogus' is not a valid coordinate",
    "textcoords bogus, outside, clip=False draw 1 !! ValueError 'bogus' is not a valid coordinate",
    "textcoords bogus, outside, clip=False draw 2 !! ValueError 'bogus' is not a valid coordinate",
    "textcoords bogus, inside draw 0 !! ValueError 'bogus' is not a valid coordinate",
    "textcoords bogus, inside draw 1 !! ValueError 'bogus' is not a valid coordinate",
    "textcoords bogus, inside draw 2 !! ValueError 'bogus' is not a valid coordinate",
    "xycoords bogus, clip=None draw 0 ok",
    "xycoords bogus, clip=None draw 1 ok",
    "xycoords bogus, clip=None draw 2 ok",
    "xycoords bogus, clip=True draw 0 !! ValueError 'bogus' is not a valid coordinate",
    "xycoords bogus, clip=True draw 1 !! ValueError 'bogus' is not a valid coordinate",
    "xycoords bogus, clip=True draw 2 !! ValueError 'bogus' is not a valid coordinate",
    "xycoords bogus, clip=False draw 0 ok",
    "xycoords bogus, clip=False draw 1 ok",
    "xycoords bogus, clip=False draw 2 ok",
    "textcoords offset bogus, outside, clip=None draw 0 ok",
    "textcoords offset bogus, outside, clip=None draw 1 ok",
    "textcoords offset bogus, outside, clip=None draw 2 ok",
    "textcoords offset bogus, outside, clip=True draw 0 ok",
    "textcoords offset bogus, outside, clip=True draw 1 ok",
    "textcoords offset bogus, outside, clip=True draw 2 ok",
    "textcoords offset bogus, outside, clip=False draw 0 !! ValueError 'bogus' is not a recognized unit",
    "textcoords offset bogus, outside, clip=False draw 1 !! ValueError 'bogus' is not a recognized unit",
    "textcoords offset bogus, outside, clip=False draw 2 !! ValueError 'bogus' is not a recognized unit",
    "arrowstyle 5, outside, clip=False draw 0 !! TypeError 'int' object is not callable",
    "arrowstyle 5, outside, clip=False draw 1 !! TypeError 'int' object is not callable",
    "arrowstyle 5, outside, clip=False draw 2 !! TypeError 'int' object is not callable",
    "text bbox 5 draw 0 !! TypeError 'int' object is not callable",
    "text bbox 5 draw 1 !! TypeError 'int' object is not callable",
    "text bbox 5 draw 2 !! TypeError 'int' object is not callable",
    "inf xytext, inside draw 0 !! StopIteration",
    "inf xytext, inside draw 1 !! StopIteration",
    "inf xytext, inside draw 2 !! StopIteration",
  ]);
});

// (each draw raises a fresh exception object, the same each time, no
// traceback kept growing; the figure draws again once the annotation is hidden, and others
// draw throughout: matplotlib 3.11.1's lines)
test("an annotation's error, drawn again and again: the same each draw, then a healthy draw (#801 ANNOT-ERROR-RETAIN-1)", () => {
  const out = run("import matplotlib\nREAL = 'site-packages' in (getattr(matplotlib, '__file__', '') or '')\nif REAL:\n    matplotlib.use('Agg')\nimport matplotlib.pyplot as plt\nimport traceback\ndef redraws(label, make, heal=None):\n    fig, ax = plt.subplots()\n    make(ax)\n    seen, objs = [], []\n    for i in range(4):\n        try:\n            fig.savefig('rd.svg')\n            seen.append('ok')\n        except Exception as e:\n            seen.append((type(e).__name__, str(e), len(traceback.extract_tb(e.__traceback__))))\n            objs.append(e)\n    errs = [s for s in seen if s != 'ok']\n    same = len(set(errs)) <= 1\n    fresh = all(a is not b for a, b in zip(objs, objs[1:]))\n    print(label, '=>', errs[0][:2] if errs else 'ok', 'x%d,' % len(errs), 'the same each draw:', same, '- a fresh exception each draw:', fresh)\n    if heal:\n        heal(ax)\n        try:\n            fig.savefig('rd.svg'); print(label, 'healed => ok')\n        except Exception as e:\n            print(label, 'healed !!', type(e).__name__, e)\n    plt.close(fig)\n    fig2, ax2 = plt.subplots(); ax2.plot([0, 1]); fig2.savefig('rd2.svg'); plt.close(fig2)\nredraws('textcoords bogus, inside', lambda ax: ax.annotate('t', (0.5, 0.5), (0, 0), textcoords='bogus'), lambda ax: ax.set_xlim(2, 3))\nredraws('xycoords bogus, clip=True', lambda ax: ax.annotate('t', (5, 5), (0, 0), xycoords='bogus', textcoords='data', annotation_clip=True))\nredraws('arrowstyle 5, inside', lambda ax: ax.annotate('t', (0.5, 0.5), (0.2, 0.2), arrowprops=dict(arrowstyle=5)), lambda ax: ax.set_xlim(2, 3))\nredraws('text bbox boxstyle 5', lambda ax: ax.text(0.5, 0.5, 't', bbox=dict(boxstyle=5)))\nredraws('inf xytext arrow, inside', lambda ax: ax.annotate('t', (0.5, 0.5), (float('inf'), 0), arrowprops=dict(arrowstyle='->')), lambda ax: ax.set_xlim(2, 3))\nprint('a healthy figure after each: ok')\n");
  assert.deepEqual(out.trim().split("\n"), [
    "textcoords bogus, inside => ('ValueError', \"'bogus' is not a valid coordinate\") x4, the same each draw: True - a fresh exception each draw: True",
    "textcoords bogus, inside healed => ok",
    "xycoords bogus, clip=True => ('ValueError', \"'bogus' is not a valid coordinate\") x4, the same each draw: True - a fresh exception each draw: True",
    "arrowstyle 5, inside => ('TypeError', \"'int' object is not callable\") x4, the same each draw: True - a fresh exception each draw: True",
    "arrowstyle 5, inside healed => ok",
    "text bbox boxstyle 5 => ('TypeError', \"'int' object is not callable\") x4, the same each draw: True - a fresh exception each draw: True",
    "inf xytext arrow, inside => ('StopIteration', '') x4, the same each draw: True - a fresh exception each draw: True",
    "inf xytext arrow, inside healed => ok",
    "a healthy figure after each: ok",
  ]);
});

// (which error matplotlib 3.11.1 raises first, in its drawing order: the
// text's place, the arrow's point (xycoords), the connection's style, its
// search for the text's edge (StopIteration), the arrow's style, the box)
test("several bad parts: matplotlib 3.11.1's first error (#801 X1-X5)", () => {
  const out = run("import matplotlib\nREAL = 'site-packages' in (getattr(matplotlib, '__file__', '') or '')\nif REAL:\n    matplotlib.use('Agg')\nimport matplotlib.pyplot as plt\ndef t(label, f):\n    fig, ax = plt.subplots()\n    try:\n        f(ax)\n    except Exception as e:\n        print(label, 'annotate !!', type(e).__name__, str(e)[:100]); plt.close(fig); return\n    try:\n        fig.savefig('xc.svg'); print(label, 'ok')\n    except Exception as e:\n        print(label, '!!', type(e).__name__, str(e)[:100])\n    plt.close(fig)\nt('X1 offset text, bad xycoords', lambda ax: ax.annotate('t', (0.5, 0.5), (5, 5), xycoords='bogus', textcoords='offset points'))\nt('X1 offset text, bad xycoords, clip=False', lambda ax: ax.annotate('t', (0.5, 0.5), (5, 5), xycoords='bogus', textcoords='offset points', annotation_clip=False))\nt('X2 arrow, bad xycoords', lambda ax: ax.annotate('t', (0.5, 0.5), (0.2, 0.2), xycoords='bogus', textcoords='data', arrowprops=dict(arrowstyle='->')))\nt('X2 arrow, bad xycoords, clip=False', lambda ax: ax.annotate('t', (0.5, 0.5), (0.2, 0.2), xycoords='bogus', textcoords='data', annotation_clip=False, arrowprops=dict(arrowstyle='->')))\nt('X5 inf xytext, bad textcoords, arrow', lambda ax: ax.annotate('t', (0.5, 0.5), (float('inf'), 0), textcoords='bogus', arrowprops=dict(arrowstyle='->')))\nt('X5 inf xytext, bad arrowstyle', lambda ax: ax.annotate('t', (0.5, 0.5), (float('inf'), 0), arrowprops=dict(arrowstyle=5)))\nt('X5 inf xytext, bad xycoords, arrow', lambda ax: ax.annotate('t', (0.5, 0.5), (float('inf'), 0), xycoords='bogus', textcoords='data', arrowprops=dict(arrowstyle='->')))\nt('X3 bad textcoords and arrowstyle', lambda ax: ax.annotate('t', (0.5, 0.5), (0, 0), textcoords='bogus', arrowprops=dict(arrowstyle=5)))\n");
  assert.deepEqual(out.trim().split("\n").map((l) => l.trimEnd()), [
    "X1 offset text, bad xycoords !! ValueError 'bogus' is not a valid coordinate",
    "X1 offset text, bad xycoords, clip=False !! ValueError 'bogus' is not a valid coordinate",
    "X2 arrow, bad xycoords !! ValueError 'bogus' is not a valid coordinate",
    "X2 arrow, bad xycoords, clip=False !! ValueError 'bogus' is not a valid coordinate",
    "X5 inf xytext, bad textcoords, arrow !! ValueError 'bogus' is not a valid coordinate",
    "X5 inf xytext, bad arrowstyle !! StopIteration",
    "X5 inf xytext, bad xycoords, arrow !! ValueError 'bogus' is not a valid coordinate",
    "X3 bad textcoords and arrowstyle !! ValueError 'bogus' is not a valid coordinate",
  ]);
});

// (the box's style is called before the arrow's, after the connection's and
// its search: matplotlib 3.11.1's first error, a float style told from an int)
test("a bad box with other bad parts: matplotlib 3.11.1's first error (#801 X9)", () => {
  const out = run("import matplotlib\nREAL = 'site-packages' in (getattr(matplotlib, '__file__', '') or '')\nif REAL:\n    matplotlib.use('Agg')\nimport matplotlib.pyplot as plt\ndef t(label, f):\n    fig, ax = plt.subplots()\n    try:\n        f(ax)\n        fig.savefig('x9.svg'); print(label, 'ok')\n    except Exception as e:\n        print(label, '!!', type(e).__name__, str(e)[:100])\n    plt.close(fig)\nt('bad connectionstyle (int), bad bbox (float)', lambda ax: ax.annotate('t', (0.5, 0.5), (0.2, 0.2), arrowprops=dict(arrowstyle='->', connectionstyle=5), bbox=dict(boxstyle=5.5)))\nt('bad arrowstyle (int), bad bbox (float)', lambda ax: ax.annotate('t', (0.5, 0.5), (0.2, 0.2), arrowprops=dict(arrowstyle=5), bbox=dict(boxstyle=5.5)))\nt('inf xytext arrow, bad bbox (float)', lambda ax: ax.annotate('t', (0.5, 0.5), (float('inf'), 0), arrowprops=dict(arrowstyle='->'), bbox=dict(boxstyle=5.5)))\nt('inf xytext, bad connectionstyle (int)', lambda ax: ax.annotate('t', (0.5, 0.5), (float('inf'), 0), arrowprops=dict(arrowstyle='->', connectionstyle=5)))\nt('bad connectionstyle (int), bad arrowstyle (float)', lambda ax: ax.annotate('t', (0.5, 0.5), (0.2, 0.2), arrowprops=dict(arrowstyle=5.5, connectionstyle=5)))\nt('bad textcoords, bad bbox (float)', lambda ax: ax.annotate('t', (0.5, 0.5), (0, 0), textcoords='bogus', bbox=dict(boxstyle=5.5)))\nt('bad xycoords arrow, bad bbox (float)', lambda ax: ax.annotate('t', (0.5, 0.5), (0.2, 0.2), xycoords='bogus', textcoords='data', arrowprops=dict(arrowstyle='->'), bbox=dict(boxstyle=5.5)))\nt('bbox (float) without arrow, point outside', lambda ax: ax.annotate('t', (5, 5), (0.2, 0.2), bbox=dict(boxstyle=5.5)))\n");
  assert.deepEqual(out.trim().split("\n").map((l) => l.trimEnd()), [
    "bad connectionstyle (int), bad bbox (float) !! TypeError 'int' object is not callable",
    "bad arrowstyle (int), bad bbox (float) !! TypeError 'float' object is not callable",
    "inf xytext arrow, bad bbox (float) !! StopIteration",
    "inf xytext, bad connectionstyle (int) !! TypeError 'int' object is not callable",
    "bad connectionstyle (int), bad arrowstyle (float) !! TypeError 'int' object is not callable",
    "bad textcoords, bad bbox (float) !! ValueError 'bogus' is not a valid coordinate",
    "bad xycoords arrow, bad bbox (float) !! ValueError 'bogus' is not a valid coordinate",
    "bbox (float) without arrow, point outside ok",
  ]);
});

// (the connection's style is called after the text's place and the arrow's
// point: a bad textcoords or xycoords is matplotlib 3.11.1's first error)
test("a bad connection style with bad coordinates: matplotlib 3.11.1's first error (#801 X3)", () => {
  const out = run("import matplotlib\nREAL = 'site-packages' in (getattr(matplotlib, '__file__', '') or '')\nif REAL:\n    matplotlib.use('Agg')\nimport matplotlib.pyplot as plt\ndef t(label, f):\n    fig, ax = plt.subplots()\n    try:\n        f(ax)\n        fig.savefig('x3.svg'); print(label, 'ok')\n    except Exception as e:\n        print(label, '!!', type(e).__name__, str(e)[:100])\n    plt.close(fig)\nt('X3 bad textcoords, bad connectionstyle', lambda ax: ax.annotate('t', (0.5, 0.5), (0, 0), textcoords='bogus', arrowprops=dict(arrowstyle='->', connectionstyle=5)))\nt('X3 bad xycoords, arrow, bad connectionstyle', lambda ax: ax.annotate('t', (0.5, 0.5), (0.2, 0.2), xycoords='bogus', textcoords='data', arrowprops=dict(arrowstyle='->', connectionstyle=5)))\nt('X3 bad offset unit, bad connectionstyle', lambda ax: ax.annotate('t', (0.5, 0.5), (5, 5), textcoords='offset bogus', arrowprops=dict(arrowstyle='->', connectionstyle=5)))\nt('X3 bad connectionstyle alone', lambda ax: ax.annotate('t', (0.5, 0.5), (0.2, 0.2), arrowprops=dict(arrowstyle='->', connectionstyle=5)))\n");
  assert.deepEqual(out.trim().split("\n").map((l) => l.trimEnd()), [
    "X3 bad textcoords, bad connectionstyle !! ValueError 'bogus' is not a valid coordinate",
    "X3 bad xycoords, arrow, bad connectionstyle !! ValueError 'bogus' is not a valid coordinate",
    "X3 bad offset unit, bad connectionstyle !! ValueError 'bogus' is not a recognized unit",
    "X3 bad connectionstyle alone !! TypeError 'int' object is not callable",
  ]);
});
