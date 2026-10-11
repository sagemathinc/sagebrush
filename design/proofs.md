# Proofs and assumptions in Sagebrush: proposals

**Status:** a proposal for discussion (October 9, 2026). Nothing here is implemented.

## The problem

**Sage's model.** Sage has one global switch per subsystem: `proof.arithmetic()`, `proof.number_field()`, `proof.elliptic_curve()`, `proof.polynomial()`, `proof.linear_algebra()`, `proof.other()`, all True by default. That is too coarse for research use. You cannot say "assume GRH for class groups, but do not assume BSD", because both live under number theory.

**What Sagebrush relies on today** without proving it:

| Result | What it rests on |
|---|---|
| Class groups, unit groups, regulators (every field; the quadratic algorithms too) | GRH for the Dedekind zeta function of the field (a field-specific Bach-type bound) |
| `EllipticCurve.rank()` via 2-descent over a cubic field | the same GRH, through that field's class group |
| `rank()` and `gens()` with `proof=False` | the analytic rank, i.e. BSD, computed numerically |
| `analytic_rank()` | numerical evaluation of $L^{(r)}(E,1)$: deciding "is zero" from floating-point values |
| `is_prime` above $3.3 \times 10^{24}$ | Baillie–PSW: no counterexample is known, but infinitely many are expected |
| `factor()` above $2^{40}$ | Miller–Rabin with 20 fixed bases. Worse, a cofactor it cannot split is returned as prime (a bug, found by Astra; to be fixed regardless) |
| Gröbner bases over $\mathbb{Q}$ with `proof.polynomial(False)` | multimodular reconstruction without the exact check: there may be unlucky primes |
| Galois groups without `proof=True` | identification from Frobenius cycle types (already tracked: `G.proven`) |

These are different kinds of thing:
- open conjectures that are widely believed (GRH, BSD);
- statements believed false in general but with no known counterexample (BPSW);
- probabilistic algorithms with tiny, quantifiable failure probability (multimodular reconstruction, random Frobenius sampling);
- floating-point decisions without error bounds.

One flag cannot describe all of that.

## Proposal 1: a registry of named hypotheses (recommended)

A curated, versioned list. Each hypothesis has:
- a stable id;
- a precise statement;
- a status;
- references;
- which functions rely on it.

The ids are hierarchical, so a broad name implies its parts. The first version:

| id | Statement | Status |
|---|---|---|
| `grh` | GRH for every L-function Sagebrush uses (implies the next two) | open conjecture |
| `grh.dedekind` | GRH for Dedekind zeta functions (class group generation bounds) | open conjecture |
| `grh.elliptic` | GRH for $L(E,s)$ (analytic rank bounds, if used) | open conjecture |
| `bsd` | the rank part of BSD: $\operatorname{rank} E(\mathbb{Q}) = \operatorname{ord}_{s=1} L(E,s)$ | open conjecture (known for analytic rank $\le 1$) |
| `sha_finite` | Ш is finite (gives parity of the rank) | open conjecture |
| `bpsw` | Baillie–PSW has no counterexample in the range used | **believed false in general**: none known, infinitely many expected |
| `numerical` | floating-point decisions at the stated precision are correct (a value is zero, a sign) | reliability assumption |
| `probabilistic` | Monte Carlo steps with failure probability $< 2^{-64}$ are correct (unlucky primes, random sampling) | quantified probability |

**Yes, it should include statements known to be false.** BPSW is the standard example: the honest description is "false in general, but no counterexample is known, and you are betting there is none in your range". Listing it with that status is more honest than hiding it in a "probable prime" setting. The same applies later to heuristics like Cohen–Lenstra, if any computation leans on them.

**Behavior:**
- **The default allows nothing:** every result is proven, as in Sage's default.
- **A result that needs a hypothesis that isn't allowed:**
  - Sagebrush proves it another way where it can (e.g. exact class groups of small imaginary quadratic fields; a Pocklington or ECPP primality certificate);
  - otherwise it raises `UnprovenError`, a subclass of `NotImplementedError`, naming the hypothesis and saying how to allow it.
  - `EllipticCurve.rank()` already works this way.
- **Sage compatibility:** Sage's flags remain as aliases.
  - `proof.number_field(False)` allows `grh.dedekind`;
  - `proof.arithmetic(False)` allows `bpsw`;
  - `proof.elliptic_curve(False)` allows `bsd`, `grh.elliptic`, `numerical`;
  - `proof.polynomial(False)` allows `probabilistic` for polynomials.
- **API:**

```python
proof.assume("grh")                  # allow GRH (everything under it)
proof.assume("grh.dedekind", "bpsw")
proof.forbid("bsd")
with proof.assuming("grh"): ...      # for one block
proof.assumptions()                  # what is allowed now
K.class_group(assume=["grh"])        # for one call
```

## Proposal 2: record what each result rests on

Gating alone leaves the user to remember what they allowed. So every computation that relies on a hypothesis also records it:
- **The notebook** keeps a per-cell ledger, and the cell shows a small badge such as "uses GRH, BPSW". Hovering explains each hypothesis.
- **Results:** where the result type allows it, it carries the record: `K.class_group().assumptions()` returns `{'grh.dedekind'}`.
- **Agents:** the MCP and WebMCP `run_python` results include the hypotheses used, so an agent cannot quietly cite a conditional result as proven.

This is the difference between "Sagebrush was configured to assume GRH" and "this number depends on GRH". The second is what a paper needs. It also makes a "prove later" workflow possible: recompute exactly the cells that used a hypothesis once a proof method exists.

## Proposal 3: presets for people who don't want to think about it

The individual switches stay available, but most people pick a preset:

| Preset | Allows | For |
|---|---|---|
| **Proven** (default) | nothing | papers, teaching, checking |
| **Standard conjectures** | `grh`, `bsd`, `sha_finite` | most computational number theory practice (what PARI and Magma users usually accept) |
| **Fast** | everything in the registry, including `bpsw`, `numerical`, `probabilistic` | exploration, agents doing large searches |

**Where to set it:**
- **Command line:** `sagebrush --assume grh,bsd`, or `--preset fast`. `--no-proof` means Fast.
- **Environment:** `SAGEBRUSH_ASSUME=grh,bsd`, read by the pip package, the CLI and the MCP server.
- **sagebrush.space:** a switch on the page. "Proven" is on by default; turning it off picks a preset. A small gear opens the full list as checkboxes, grouped by status (open conjectures, probabilistic, believed false in general), each with a one-line explanation and a link. The toolbar always shows the current state, e.g. "Assuming: GRH", so a screenshot of a notebook says what its results rest on.

## Proposal 4 (alternative): no gating, only recording

Compute everything as fast as possible, and only record the hypotheses used, as in Proposal 2.
- **For:** nothing ever raises; agents and exploration never stall.
- **Against:** a researcher who copies a number into a paper without looking at the badge has a conditional result. That breaks Sage's promise that the default is proven, which is your stated requirement.

Also possible: gate in the library and the CLI, but use a non-strict default in the web demo. That hides the difference exactly where newcomers see it, so I would not.

## Recommendation

1. Proposals 1 + 2 + 3 together: a hypothesis registry, the Proven default with clear errors, a ledger and badges, presets, and Sage's flags as aliases.
2. Grow proof methods so the Proven default stays pleasant. In rough order of value:
   1. exact class groups of imaginary quadratic fields by reduced forms (fast up to $|D|$ of about $10^{12}$);
   2. primality certificates: Pocklington/BLS when $n-1$ factors far enough, then ECPP;
   3. class group certification for small general fields (a Minkowski or Zimmert bound plus the unit index check, as in PARI's `bnfcertify`);
   4. interval arithmetic where floating point decides exact facts.
3. Fix the `factor()` bug independently. A composite must never be reported as a prime, whatever is assumed.

## Open questions for William

- Hypothesis granularity: is `grh.dedekind` versus `grh.elliptic` the right split, or is plain `grh` enough for now?
- Should a "believed false" hypothesis like `bpsw` be allowed by the Standard preset, or only by Fast?
- Ledger display: a badge on every cell that used a hypothesis, or only a summary in the toolbar?
