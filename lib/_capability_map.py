"""A short map of what Sagebrush can do, per language, generated from the
search indexes: for each area, how many functions it has, a few of them,
and a search to start from (it finds some of the area's functions, not
necessarily all).  Markdown, for llms.txt and agents.

    sagebrush -m _capability_map        (web/build.ts: capabilities.md)

The areas and their descriptions are Sagebrush's own.
"""

import sys as _sys

# Sage: the area of each module of the index (lib/_pyjs_docsearch.py PUBLIC),
# with a search that finds some of its functions (test/docsearch.test.ts)
SAGE_AREAS = [
    ("sage_all", "integers, rationals and elementary number theory", "prime"),
    ("_sage_poly", "univariate polynomials", "polynomial"),
    ("_sage_mpoly", "multivariate polynomials, ideals and Groebner bases", "groebner"),
    ("_sage_frac", "fraction fields and rational functions", "fraction field"),
    ("_sage_series", "power series", "series"),
    ("_sage_ff", "finite fields and integers modulo n", "finite field"),
    ("_sage_ffmat", "linear algebra over finite fields", "matrix finite"),
    ("_sage_matrix", "matrices and linear algebra over Z and Q", "matrix"),
    ("_sage_nf", "number fields, class groups and units", "number field"),
    ("_sage_qqbar", "algebraic numbers", "algebraic"),
    ("_sage_real", "real and complex numbers to arbitrary precision", "precision"),
    ("_sage_rdf", "double precision reals and complexes", "double"),
    ("_sage_modular", "modular forms, modular symbols and elliptic curves", "modular"),
    ("_sage_expr", "symbolic expressions and calculus", "integrate"),
    ("_sage_lang", "the Sage language (preparser, ranges, helpers)", "ellipsis"),
    ("sage_permgroup", "permutation groups", "permutation group"),
    ("_sage_lie", "Lie theory: root systems, Weyl groups, representations", "weyl"),
    ("_sage_crystals", "crystals and tableaux", "crystal"),
    ("_sage_graph", "graphs", "edges"),
    ("_sage_sandpile", "sandpiles", "sandpile"),
    ("_sage_polyhedra", "polyhedra and polytopes", "polyhedron"),
    ("_sage_coding", "coding theory", "code"),
    ("_sage_manifolds", "manifolds and differential geometry", "manifold"),
    ("_sage_milp", "linear and mixed integer programming", "program"),
    ("sage_plot", "2D plots", "graphics"),
    ("sage_plot3d", "3D plots", "plot3d"),
    ("_interact", "interacts (live controls)", "interact"),
]

MAGMA_QUERIES = {
    "structures": "ring", "integers": "prime", "rationals and reals": "real", "strings and printing": "string",
    "sequences and sets": "sequence", "records": "record", "polynomials": "polynomial",
    "maps": "map", "modular forms": "modular", "elliptic curves": "elliptic", "number fields": "number field", "matrices": "matrix",
}

# MATLAB: areas by the module that implements a function, then by its name
_MATLAB_PLOT = set(("plot plot3 scatter scatter3 bar barh hist histogram histogram2 surf surfc mesh meshc meshz contour contourf "
                    "contour3 figure axis xlabel ylabel zlabel title legend grid hold subplot colormap colorbar quiver quiver3 patch "
                    "line text area pie pie3 stem stairs errorbar fill fill3 image imagesc view loglog semilogx semilogy polarplot "
                    "fplot fsurf fcontour fimplicit spy waterfall ribbon pcolor clf gca gcf set get xlim ylim zlim xticks yticks "
                    "zticks xticklabels yticklabels box daspect caxis clim shading lighting camlight light annotation rectangle "
                    "histcounts pareto compass feather comet rose scatterhistogram heatmap bar3 bar3h stem3 cylinder sphere "
                    "ellipsoid peaks").split())
_MATLAB_LINALG = set(("inv det eig eigs svd svds qr lu chol norm normest rank null orth pinv kron trace expm logm sqrtm funm "
                      "linsolve mldivide mrdivide cond rcond condest lsqnonneg lsqminnorm schur hess balance cross dot "
                      "triu tril diag mtimes mpower vecnorm subspace gsvd qz ordschur rref").split())
_MATLAB_NUMERIC = set(("ode45 ode23 ode113 ode15s ode23s ode23t ode23tb ode15i odeset odeget deval integral integral2 integral3 "
                       "quad quadgk quadl quadv trapz cumtrapz fzero fminsearch fminbnd optimset optimget interp1 interp2 interp3 "
                       "interpn spline pchip ppval mkpp unmkpp polyfit polyval polyder polyint roots poly conv deconv residue "
                       "fft ifft fft2 ifft2 fftn ifftn fftshift ifftshift filter filter2 conv2 convn gradient del2 diff "
                       "cumsum cumprod").split())


_MATLAB_SPARSE = set(("sparse issparse nnz nonzeros nzmax spones spalloc speye sprand sprandn sprandsym spdiags spfun "
                      "spconvert spparms sprank pcg gmres bicg bicgstab bicgstabl cgs minres qmr tfqmr lsqr symmlq ichol ilu "
                      "amd colamd symamd symrcm dmperm etree treelayout gplot").split())
_MATLAB_STATS = set(("mean median mode std var max min sum prod range quantile prctile cov corrcoef histcounts bounds "
                     "normalize rescale zscore cummax cummin smoothdata").split())
_MATLAB_TYPES = set(("double single int8 int16 int32 int64 uint8 uint16 uint32 uint64 logical class isa cast typecast "
                     "isnumeric isreal isfloat isinteger islogical ischar isstring iscellstr isa intmax intmin realmax realmin "
                     "eps flintmax func2str str2func feval").split())


def _matlab_area(name, module):
    """The area of a MATLAB built-in, by its name (Sagebrush's grouping)."""
    if name in _MATLAB_SPARSE:
        return "sparse matrices and iterative solvers"
    if name in _MATLAB_STATS or name.startswith("mov"):
        return "statistics and data analysis"
    if name in _MATLAB_TYPES:
        return "types and conversions"
    if name in _MATLAB_PLOT:
        return "plotting"
    if name in _MATLAB_LINALG:
        return "linear algebra"
    if name in _MATLAB_NUMERIC or name.startswith("ode"):
        return "numerical methods (ODEs, integration, optimization, interpolation, FFT)"
    if name.startswith(("str", "regexp")) or name in ("num2str", "sprintf", "upper", "lower", "strip", "split", "join",
                                                     "contains", "startsWith", "endsWith", "replace", "extractAfter",
                                                     "extractBefore", "pad", "blanks", "deblank", "char", "string",
                                                     "int2str", "mat2str", "str2num", "str2double"):
        return "strings and text"
    if name.startswith(("cell", "struct")) or name in ("fieldnames", "isfield", "rmfield", "setfield", "getfield",
                                                       "num2cell", "iscell", "isstruct", "orderfields", "deal"):
        return "cell arrays and structs"
    if name.startswith("f") and name[1:] in ("open", "close", "printf", "read", "write", "gets", "getl", "scanf", "seek",
                                             "tell", "eof", "rewind") or name in ("load", "save", "exist", "dir", "disp",
                                                                                   "display", "input", "fileread",
                                                                                   "readmatrix", "writematrix",
                                                                                   "csvread", "csvwrite", "dlmread",
                                                                                   "dlmwrite", "mkdir", "delete"):
        return "input, output and files"
    return "arrays and elementary mathematics"


def _examples(entries, k=6):
    """A few names: functions and classes first, those with the most tested
    examples first."""
    tops = [e for e in entries if e.get("kind") in ("function", "class") and not e["name"].endswith("_")] or list(entries)
    tops.sort(key=lambda e: (-e.get("examples", 0), e["name"]))
    return [e["name"] for e in tops[:k]]


def _table(rows, mode):
    out = ["| area | functions | for example | a search to start from |", "|---|---:|---|---|"]
    for area, entries, query in rows:
        names = ", ".join("`%s`" % n for n in _examples(entries))
        flag = "" if mode == "sage" else " --mode %s" % mode
        out.append("| %s | %d | %s | `sagebrush --search \"%s\"%s` |" % (area, len(entries), names, query, flag))
    return out


def sage_rows():
    import _pyjs_docsearch
    idx = _pyjs_docsearch.index_for("sage")
    rows = []
    for module, area, query in SAGE_AREAS:
        entries = [e for e in idx if e["module"] == module]
        if entries:
            rows.append((area, entries, query))
    return rows


def magma_rows():
    import _magma_docsearch
    idx = _magma_docsearch.build_index()
    areas = []
    for e in idx:
        for a in e["areas"]:
            if a not in areas:
                areas.append(a)
    order = list(MAGMA_QUERIES)
    areas.sort(key=lambda a: order.index(a) if a in order else len(order))
    return [(a, [e for e in idx if a in e["areas"]], MAGMA_QUERIES.get(a, a)) for a in areas]


def matlab_rows():
    import _matlab
    import _matlab_docsearch
    idx = _matlab_docsearch.build_index()
    by = {}
    for e in idx:
        b = _matlab._B.get(e["name"])
        module = getattr(getattr(b, "f", None), "__module__", "_matlab")
        area = _matlab_area(e["name"], module) or "arrays and elementary mathematics"
        by.setdefault(area, []).append(e)
    queries = {"plotting": "plot", "linear algebra": "matrix", "sparse matrices and iterative solvers": "sparse",
               "strings and text": "str", "cell arrays and structs": "cell", "input, output and files": "file",
               "statistics and data analysis": "mean", "types and conversions": "class",
               "numerical methods (ODEs, integration, optimization, interpolation, FFT)": "fft",
               "arrays and elementary mathematics": "array"}
    rows = [(a, es, queries.get(a, a.split()[0])) for a, es in by.items()]
    rows.sort(key=lambda r: -len(r[1]))
    return rows


def build():
    """The capability map, as Markdown."""
    import _magma_docsearch
    out = ["# What Sagebrush can do", "",
           "Generated from Sagebrush's search indexes (`sagebrush -m _capability_map`). Each area gives a search to",
           "start from: it finds some of the area's functions, not necessarily all of them. Search with",
           "`sagebrush --search WORDS --mode sage|python|magma|matlab` from a shell, or read the JSON indexes",
           "(`docs-index.json` for the Sage library, which Python mode shares; `docs-index-magma.json`;",
           "`docs-index-matlab.json`). The search box at https://sagebrush.space searches in Sage, Magma and MATLAB",
           "notebooks; Python notebooks have no search there.", ""]
    rows = sage_rows()
    out += ["## Sage and Python", "",
            "Sage mode (`--sage`, `.sage` files) and Python mode share one library: %d documented functions and methods"
            % sum(len(r[1]) for r in rows),
            "(Python mode imports them, e.g. `from sage_all import *`).", ""]
    out += _table(rows, "sage") + [""]
    rows = magma_rows()
    n = len(_magma_docsearch.build_index())
    out += ["## Magma", "",
            "Magma mode (`--magma`, `.mag` files, `.m` files whose code contains `:=`, the notebook's Magma mode):",
            "%d intrinsics. Written from Magma's public documentation; the tests compare Sagebrush's output with" % n,
            "Magma 2.18's, byte for byte, on the cases they cover, which are not every intrinsic or option",
            "(`design/magma-coverage.md`). An intrinsic may be listed under several areas.", ""]
    out += _table(rows, "magma") + ["", "The language:", ""]
    out += ["- **%s**: %s" % (a, d) for a, d in _magma_docsearch.LANGUAGE] + [""]
    rows = matlab_rows()
    out += ["## MATLAB", "",
            "MATLAB mode (`--matlab`, `.m` files without `:=`): %d built-in functions; the tests compare their"
            % sum(len(r[1]) for r in rows),
            "results with GNU Octave's on the cases they cover.", ""]
    out += _table(rows, "matlab") + [""]
    return "\n".join(out)


def main(argv):
    print(build())
    return 0


if __name__ == "__main__":
    _sys.exit(main(_sys.argv[1:]))
