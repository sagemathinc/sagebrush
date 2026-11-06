# A bracket-notation symbolic language mode for Sagebrush: feasibility spike

@sagebrush-matlab, Nov 6 2026. Assignment: William via @sagebrush (Nov 6, 1:20 PM PST).

## In plain words

It is feasible, and most of the mathematics is already there. Sagebrush's Sage
symbolic layer already does the calculus, algebra, equation solving, linear
algebra and plotting that undergraduate homework needs. A new language mode
needs three new things: a parser for the bracket syntax (`f[x]`, `{lists}`,
`x -> 2`, `x_`), an evaluator that rewrites expressions with rules, and a
printer. Each converts to the Sage layer and back.

In about half a day I built a working prototype: one Python module (1,800 non-blank
lines) plus a `--sprig` CLI flag. It agrees with Mathics3 (the open-source
oracle) on **155 of 166** test inputs. Of the other 11:
- 6 are inputs Mathics3 itself leaves unevaluated, which we answer.
- 1 is a Mathics3 error.
- 2 are gaps in our own Sage layer, where real Sage gets the answer.
- 2 are cosmetic (term order, TeX braces).

The spike also found **5 bugs or gaps in our Sage layer** that affect Sage
mode today (section 5).

My estimate for a usable MVP (homework, notebook and LaTeX embedding, about
150 functions) is **8 to 10 agent-weeks**. The long tail is in evaluator
semantics and output formatting, not mathematics.

Proposed mode name: **Sprig** (`--sprig`, `.sprig` files). It is botanical
like Sage and Sagebrush, short, and not associated with any vendor.

## Ground rules followed

- No Wolfram engine, product, cloud or wolfram.com page was used or read.
- Mathics3 10.0.1 (`pip install mathics3`, under `/scratch/matlab-tmp/mathics/venv`)
  was run only as a black box, through `oracle.sh`: input text in, `InputForm`
  text out. I did not read, copy or port any of its source, and I did not
  need its user docs.
- The syntax and evaluation model come from general knowledge of the
  language's notation; every behaviour claim below is checked against
  Mathics3 output or is plain mathematics.
- The prototype's code is new and Sagebrush's own. Its mathematics is all
  delegated to `lib/_sage_expr.py` and friends.

## 1. The syntax subset, and how it maps onto the engine

### Parser

The prototype's parser is a Pratt (precedence-climbing) parser in Python,
about 300 lines in `lib/_sprig.py`. It produces **FullForm trees**:
`Expr(head, *args)` with atoms `int`, `Fraction`, `float`, `str` and
interned `Sym`.

| Syntax | Tree | Notes |
|---|---|---|
| `f[x, y]` | `f[x, y]` | the head can be any expression: `Derivative[1][f][x]` |
| `{a, b}` | `List[a, b]` | |
| `a + b`, `a - b`, `-a` | `Plus[a, b]`, `Plus[a, Times[-1, b]]` | flattened |
| `a b`, `2 x`, `a*b`, `a/b` | `Times[...]`, `Times[a, Power[b, -1]]` | **implicit multiplication** by juxtaposition |
| `a^b` | `Power[a, b]` | right-associative |
| `==  !=  <  >  <=  >=` | `Equal[...]` and so on | chains: `a < b < c` |
| `&&  \|\|  !` | `And`, `Or`, `Not` | |
| `x -> v`, `x :> v` | `Rule`, `RuleDelayed` | |
| `e /. r`, `e //. r` | `ReplaceAll`, `ReplaceRepeated` | |
| `x_`, `x_Integer`, `x__`, `x___`, `x_.` | `Pattern[x, Blank[]]` and so on | |
| `p /; c`, `p ? t`, `a \| b` | `Condition`, `PatternTest`, `Alternatives` | |
| `x = v`, `f[x_] := rhs` | `Set`, `SetDelayed` | own values and down values |
| `e // f`, `f @ e`, `f /@ l`, `f @@ l` | `f[e]`, `f[e]`, `Map`, `Apply` | |
| `#`, `#2`, `body &` | `Slot`, `Function` | pure functions |
| `f'[x]`, `f''[x]` | `Derivative[1][f][x]` | |
| `l[[i, j]]` | `Part[l, i, j]` | |
| `n!` | `Factorial[n]` | |
| `a; b`, `a;` | `CompoundExpression[a, b]`, `...[a, Null]` | a trailing `;` hides the output |
| `(* comment *)`, `"string"`, `1.5*^3`, `` 3.14`20 `` | | |
| `i++`, `x += d` | `Increment`, `AddTo` | |

Newlines end a statement at bracket depth 0, as in a notebook cell.

**Where the parser should live.** It should stay in Python, inside the
engine. MATLAB mode translates to Python in TypeScript (`src/matlab.ts`), but
this language is different. It must parse at run time (`ToExpression`, `Get`,
reading a `.sprig` file from a notebook), and its programs are data. A Python
parser runs the same in the CLI, the kernel and the web worker. TypeScript
only needs `is_incomplete` for the REPL's continuation prompt; that can call
into Python or be a 30-line bracket counter.

### Evaluator

`ev()` rewrites until nothing changes, the language's standard evaluation
loop:
- evaluate the head, then the arguments, unless held (attributes
  `HoldAll`, `HoldFirst`, `HoldRest`);
- splice `Sequence`, flatten `Flat` heads, thread `Listable` heads over lists;
- try the user's down values in order, most specific first, by pattern
  matching with sequence patterns, conditions, tests and alternatives;
- then try the built-in;
- repeat.

**How it maps onto our engine.** The arithmetic heads and functions (`Plus`,
`Times`, `Power`, `Sin`, …) and every calculus or algebra builtin convert
their arguments to Sage symbolic expressions (`to_sr`). They operate with the
existing Sage layer and convert back (`from_sr`), using the layer's tagged
encoding (`add`, `mul`, `pow`, `fun:sin`, `rel:Eq`, numbers, constants,
derivatives). So:
- `x + x` becomes `2*x` because Sage canonicalises it;
- an undefined `f[x]` becomes Sage's `function('f')(x)`, so `D[f[x] g[x], x]`
  gives the product rule with `Derivative[1][f][x]`.

Lists, rules, patterns, strings and graphics never enter Sage.

**Plots** are Sage's `plot`, `plot3d`, `parametric_plot`, `contour_plot` and
`list_plot`. `Export["f.png", g]` writes a PNG or SVG; 3D writes SVG, or HTML
through our 3D viewer. Both renderings checked out visually (`demo-out/`).

**TeX** comes from `TeXForm` through Sage's `latex()`. This is what lets
snippets embed in LaTeX documents.

## 2. Coverage: about 40 core undergraduate functions

The verdict column is against Mathics3 on the corpora in section 3:
- **maps** means it wraps an existing Sage-layer function (tens of lines),
  done in the prototype;
- **small** means under a day;
- **hard** means a week or more.

| # | Function(s) | Class | Prototype status |
|---|---|---|---|
| 1 | `D` (partials, `{x, n}`, undefined `f`) | maps | agrees |
| 2 | `Integrate` indefinite | maps | agrees (equivalent forms) |
| 3 | `Integrate` definite, multiple | maps | agrees; improper `1/x^2` on $[1,\infty)$ is a **Sage-layer gap** (G1) |
| 4 | `NIntegrate` | maps | agrees |
| 5 | `Limit` (incl. `Direction`) | maps | agrees |
| 6 | `Series`, `Normal` | maps | agrees (`SeriesData` with the same coefficients and orders) |
| 7 | `Sum` finite and symbolic | maps | agrees; the alternating series $\sum (-1)^k/(2k+1)$ is a **Sage-layer gap** (G2) |
| 8 | `Product` | maps | agrees (finite) |
| 9 | `Solve` (polynomial, systems, `&&`) | maps | agrees; real roots first, as the oracle orders them |
| 10 | `NSolve` | maps | Mathics3 leaves it unevaluated; we give the roots |
| 11 | `FindRoot` | small | done (Newton, 20 lines), agrees |
| 12 | `DSolve` (incl. initial conditions) | maps | agrees; with initial conditions Mathics3 leaves it unevaluated |
| 13 | `Simplify` | maps | agrees; assumptions are ignored, **as Mathics3 ignores them** (`Simplify[Sqrt[x^2], x > 0]`) |
| 14 | `FullSimplify` | maps | same as `Simplify` for now |
| 15 | `Expand`, `ExpandAll` | maps | agrees |
| 16 | `Factor` | maps | agrees |
| 17 | `Together`, `Cancel`, `Apart` | maps | agrees |
| 18 | `Collect`, `Coefficient` | maps | agrees |
| 19 | `TrigExpand`, `TrigReduce` | maps | Mathics3 leaves them unevaluated; ours are correct |
| 20 | `N[e]`, `N[e, digits]` | maps | agrees; arbitrary-precision reals cannot re-enter Sage's SR (G5) |
| 21 | `Plot` (several curves) | maps | renders; options (`PlotRange`, `PlotStyle`, `AxesLabel`) are **small** |
| 22 | `Plot3D` | maps | renders |
| 23 | `ParametricPlot`, `ContourPlot`, `ListPlot` | maps | render; Mathics3 leaves `ContourPlot` unevaluated |
| 24 | `Show`, `Export` | maps | done |
| 25 | `Table`, `Range`, `Do`, `While` | small | done, agrees |
| 26 | `Map`, `Apply`, `Select`, `Nest`, `NestList`, pure functions | small | done, agrees |
| 27 | `Part`, `Length`, `First`, `Last`, `Join`, `Sort`, `Flatten`, `Total` | small | done, agrees |
| 28 | `Det`, `Inverse`, `Transpose`, `Dot`, `Tr` | maps | agrees |
| 29 | `Eigenvalues`, `Eigenvectors`, `CharacteristicPolynomial` | small | done exactly (characteristic polynomial, then elimination); symbolic order differs (Sage's order) |
| 30 | `RowReduce`, `LinearSolve`, `NullSpace`, `MatrixRank` | maps | agrees (G3, G4 worked around) |
| 31 | `IdentityMatrix`, `Cross`, `Norm` | small | done |
| 32 | `Prime`, `PrimeQ`, `FactorInteger`, `GCD`, `LCM`, `Mod`, `Divisors`, `Binomial` | maps | agrees |
| 33 | `Mean`, `Variance`, `StandardDeviation` | small | done (`Mean` agrees) |
| 34 | `If`, `Module`, `Block`, `With`, `Function` | small | done (simple scoping) |
| 35 | `TeXForm` | maps | done; cosmetic difference: `x^{2}` against `x^2` |
| 36 | `Assuming`, assumptions in `Simplify`/`Integrate`/`Limit` | small | not done; Sage's `assume` exists |
| 37 | `Piecewise`, `UnitStep`, `Abs` in integrals | small–hard | not done; depends on the Sage layer |
| 38 | `NDSolve`, `Interpolation`, `Fit` | small–hard | not done; MATLAB mode's ODE and fitting code can serve |
| 39 | `Manipulate` | hard | not done; maps onto `lib/_interact.py`, but fidelity is a long tail |
| 40 | `Graphics[{Circle[], Line[...], ...}]` primitives | small–hard | not done; Sage has the primitives |
| 41 | Strings (`StringJoin`, `StringLength`, `StringReplace`, …) | small | two done |
| 42 | `MatrixForm`, `TableForm`, `Grid` (display) | small | pass-through now; needs notebook rendering |

**Hard, but not functions.** These are cross-cutting:
- full `Orderless`/`Flat` pattern matching (`a_ + b_` matching any split
  of a sum);
- `Hold`/`Unevaluated`/`Evaluate` corner cases and up values;
- `OutputForm` 2D layout and notebook typesetting (StandardForm-like
  boxes, best done by our own TeX renderer);
- precision tracking for arbitrary-precision reals;
- importing `.nb` notebook files.

## 3. The prototype

**Branch:** `spike-symbolic-mode` (local worktree `/scratch/matlab-tmp/wtmx`;
not a PR).
- `lib/_sprig.py`: parser, evaluator, 158 builtins, printer, `run()`.
- `src/cli.ts`: `--sprig` and `.sprig` files hand the program to
  `_sprig.run`, about 15 lines.
- `design/sprig-spike/`: this report, the corpora, the oracle outputs, the
  comparison harness, the demo.

```
$ sagebrush homework.sprig
{{x -> -1}, {x -> 1}}                          (* crit = Solve[f'[x] == 0, x] *)
{2, -2}                                        (* f[x] /. crit *)
-2                                             (* Integrate[f[x], {x, 0, 2}] *)
1 - x^2/6 + x^4/120 - x^6/5040 + O[x]^7        (* Series[Sin[x]/x, {x, 0, 6}] *)
E^a                                            (* Limit[(1 + a/n)^n, n -> Infinity] *)
{3, 1}                                         (* Eigenvalues[{{2, 1}, {1, 2}}] *)
{2, 3, 5, 7, 11, 13, 17, 19}                   (* Table[Prime[k], {k, 8}] *)
{{y[x] -> C[2]*Cos[x] + C[1]*Sin[x]}}          (* DSolve[y''[x] + y[x] == 0, y[x], x] *)
```

### Checked against Mathics3

`oracle.sh` evaluates each input in one Mathics3 session and prints
`InputForm`. `compare.py` runs the same inputs in one Sprig session, inside
Sagebrush. It parses the Mathics3 output with Sprig's own parser and counts
agreement two ways:
- **exactly**: the same text;
- **semantically**: structurally the same lists, rules and series; the
  difference of two expressions simplifies to 0 or vanishes numerically at
  three points; numbers agree to $10^{-9}$ relative.

**BEYOND** means Mathics3 returned the input unevaluated and we did not.

| Corpus | Inputs | Exactly | Semantically | BEYOND | Differ |
|---|---|---|---|---|---|
| `corpus.txt` (core: the coverage table) | 95 | 78 | 16 | 0 | 1 |
| `corpus2.txt` (harder: looking for gaps) | 71 | 48 | 13 | 6 | 4 |
| **total** | **166** | **126** | **29** | **6** | **5** |

The 5 differences:

| Input | Sprig | Mathics3 | Why |
|---|---|---|---|
| `ToString[TeXForm[x^2/Sqrt[y]]]` | `\frac{x^{2}}{\sqrt{y}}` | `\frac{x^2}{\sqrt{y}}` | cosmetic; the same TeX |
| `Integrate[x y, {x, 0, 1}, {y, 0, x}]` | `1/8` | `x^2/4` | **Mathics3 is wrong**: a definite integral over a region is a number, $\int_0^1\int_0^x xy\,dy\,dx = 1/8$; it returned a function of $x$ |
| `Integrate[1/x^2, {x, 1, Infinity}]` | unevaluated | `1` | **Sage-layer gap G1** |
| `Sum[(-1)^k/(2 k + 1), {k, 0, Infinity}]` | unevaluated | `Pi/4` | **Sage-layer gap G2** |
| `Eigenvalues[{{a, b}, {b, a}}]` | `{a - b, a + b}` | `{a + b, a - b}` | ordering: ours is real Sage's order |

The 29 semantic agreements are the same values written differently. Most are
term order, such as `E^x*(-1 + x)` against `(-1 + x)*E^x`. Some are
equivalent forms of an antiderivative, such as `-Cos[x] + Cos[x]^3/3` against
`Cos[x]*(-3 + Cos[x]^2)/3`. Matching Mathics3's text exactly would take
reproducing its canonical order and its integrator's choice of form. I don't
recommend aiming for that; semantic agreement plus a stable order of our own
is the right bar, as with Octave for MATLAB.

### Timings

16-core project with load average about 16, so these are relative only;
best of 5:

| | ms |
|---|---|
| `sagebrush -c 'pass'` (engine start) | 406 |
| `sagebrush -c 'import sage_all'` | 964 |
| `sagebrush --sprig -c '1 + 1'` | 995 |
| `sagebrush --sprig -c 'Integrate[x^2 Sin[x], x]'` | 1046 |
| `sagebrush --sprig homework.sprig` (9 inputs) | 1185 |
| Mathics3 `-c 'Integrate[x^2 Sin[x], x]'` (CPython) | 2633 |

The mode's own import costs about 30 ms on top of `sage_all`. A typical
homework input takes 10 to 60 ms (`demo.py`). The evaluator is plain Python
on our engine, at about 0.3 ms per loop iteration: a 2,000-step `Do` loop
takes about 0.65 s. That is fine for homework and too slow for $10^5$-step
loops. The real mode needs a fast path for numeric loops (MATLAB mode's
"turbo" approach).

**Size:** `lib/_sprig.py` is 70 KB of source and adds about 30 KB to the
CLI bundle. In the web build it would be a lazy chunk, loaded only in this
mode, and would need a growth marker.

## 4. Effort estimate for an MVP, and the main risks

**MVP:** the CLI, REPL, Jupyter kernel and web notebook mode; LaTeX
embedding through a `sprig` code block; the coverage table above; Mathics3
as the CI oracle.

| Work | Estimate |
|---|---|
| Parser: full operator table, error messages with positions, incomplete input | 3–4 days |
| Evaluator: attributes (`Hold*`, `Flat`, `Orderless`, `Listable`, `OneIdentity`, `Protected`); `Orderless`/`Flat` pattern matching; up values; `Module`/`Block`/`With`; `Return`/`Break`/`Throw` | 2 weeks |
| Builtins: about 150 functions, each with Mathics3-checked tests | 2–3 weeks |
| Output: a stable canonical order; notebook typesetting through TeX; `MatrixForm`/`Grid` | 1 week |
| Graphics: options and primitives, `Show`, 3D in the viewer | 1 week |
| Integration: `kernel.ts` mode, web worker, completion, docsearch, examples, the LaTeX code-block hook | 1 week |
| Fixing the Sage-layer gaps (section 5); this also fixes Sage mode | 3–5 days |
| Test infrastructure: a `sprig-tests/` runner and Mathics3 outputs, as `matlab-tests/` has Octave's | 2–3 days |
| **Total** | **8–10 agent-weeks** (one agent); less wall time split across two |

**Risks**

1. **Expectations.** People will paste real-world code and expect identical
   output text, 2D typeset output, `Manipulate` and `.nb` files. Semantic
   agreement will be high, but textual agreement will not be, and we must
   say so up front.
2. **The oracle is imperfect.** Mathics3 leaves common functions unevaluated
   (`NSolve`, `TrigExpand`, `ContourPlot`, `DSolve` with initial conditions,
   `CharacteristicPolynomial`). It also gets at least one integral wrong and
   ignores `Simplify` assumptions. We need the MATLAB-mode rule with a
   twist: Mathics3 output where it answers, mathematics where it is wrong
   or silent, and each difference recorded.
3. **Our symbolic layer bounds the quality.** Every Sage-layer gap shows up
   in this mode as an unevaluated result (G1, G2), and new users will hit
   more. That is also the opportunity: the fixes improve Sage mode.
4. **The evaluation semantics have a long tail.** The first 80% (this spike)
   is easy. `Orderless` matching, `Hold` corners and up values are where the
   weeks go.
5. **Performance.** A rewriting evaluator in Python with Sage round trips is
   fine at homework sizes and slow for tight loops.
6. **Naming and licence.** The language's syntax is not ours to name.
   Avoiding vendor names in the product is easy. Whether to accept the
   vendor's file extensions (`.wl`, `.m`, `.nb`) for import is a product and
   legal question for William, not something to decide in code.

## 5. Bugs found in Sagebrush's Sage layer (they affect Sage mode today)

Each was checked against real Sage 10.10 (`/scratch/sage-oracle/sage/sage`):

| | Input (Sage syntax) | Sagebrush | Real Sage |
|---|---|---|---|
| G1 | `integrate(1/x^2, x, 1, oo)` | unevaluated `integrate(...)` | `1` |
| G2 | `sum((-1)^k/(2*k+1), k, 0, oo)` | unevaluated `sum(...)` | `1/4*pi` |
| G3 | `matrix(SR, [[a, b], [b, a]]).eigenvalues()`; `matrix(SR, [[SR(2), SR(1)], [SR(1), SR(2)]]).eigenvectors_right()` | `TypeError` in `sagebrush/linalg.py` `_num` (`Fraction` of an SR number) | `[a - b, a + b]`; the eigenvectors |
| G4 | `matrix(QQ, [[1, 1], [1, -1]]).solve_right(vector(SR, [SR(3), SR(1)]))` | `TypeError` in `linalg._scaled_rows` (`int(x.denominator)`, a method) | `(2, 1)` |
| G5 | `SR(pi.n(digits=30)) + 1` | `TypeError: cannot convert ... to a symbolic expression` | `4.14159265358979323846264338328` |

G3 and G4 come from the same root cause: `linalg` converts entries with
`Fraction(x)`/`int(x.denominator)`, which works for Python ints and `QQ`
elements but not for SR numbers. I'd take these as a small separate PR in
the engine lane, whether or not the mode goes ahead.

## Files

Everything is in `/scratch/sagebrush-reviews/mathics-spike/`, frozen with
`SHA256SUMS`, and copied onto the branch under `design/sprig-spike/`:
- `REPORT.md`: this report.
- `corpus.txt`, `corpus2.txt`: the inputs.
- `oracle.txt`, `oracle2.txt`: Mathics3 10.0.1's outputs.
- `results.tsv`, `results2.tsv`: verdict, input, Sprig, Mathics3.
- `oracle.sh`, `compare.py`: the harness.
- `demo.py`, `demo-out/`: timings and rendered plots.
- `homework.sprig`: the example above.
- `probe*.sage`, `probe*.py`, `gaps.sage`, `gaps2.py`: probes of the Sage
  layer.

**To reproduce:** build the branch (`npm run build:cli`), then run
`./oracle.sh corpus.txt > oracle.txt` and
`sagebrush compare.py <branch>/lib corpus.txt oracle.txt > results.tsv`.
