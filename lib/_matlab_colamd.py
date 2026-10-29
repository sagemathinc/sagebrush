"""A fill-reducing column ordering for MATLAB mode's sparse LU (internal: no
public colamd or symamd; plan-matlab-nocliffs r6 section 2.1).

order_columns orders the columns of a sparse A so that the LU factors of
A(:, q) fill in little: an approximate minimum degree ordering of the
structure of A'*A, without forming A'*A.  It is written from the published
papers only (no SuiteSparse, Octave or MATLAB source was read):

- P. R. Amestoy, T. A. Davis, I. S. Duff, An approximate minimum degree
  ordering algorithm, SIAM J. Matrix Anal. Appl. 17(4):886-905, 1996: the
  quotient graph, the approximate external degree (an upper bound of the
  true one, their Theorem 4.1), element absorption and supervariables;
- T. A. Davis, J. R. Gilbert, S. I. Larimore, E. G. Ng, A column approximate
  minimum degree ordering algorithm, ACM Trans. Math. Softw. 30(3):353-376,
  2004: A's rows as the initial elements, and the dense rows and columns
  set aside;
- A. George, J. W. H. Liu, The evolution of the minimum degree ordering
  algorithm, SIAM Review 31(1):1-19, 1989.

The invariants (r6 section 2.1):
- the graph: the variables are A's columns; the elements are A's rows at
  first (each the columns it holds), then each eliminated pivot's new
  element; a variable keeps its elements (E) and its variable neighbours
  (A, empty at first, as A'*A's structure is all through the rows);
- each variable's degree is the approximate external degree, an upper
  bound of the true external degree; an elimination updates only the
  variables of the new element;
- an element whose variables all lie in the new element is absorbed
  (deleted): the remaining degrees describe the same structure;
- ties: the smallest degree, then the smallest representative index;
  indistinguishable variables (the same elements and neighbours) become one
  supervariable, whose members are ordered together, in increasing index;
- a column with no entries outside the dense rows goes first, in
  increasing index; a dense column (more than max(16, 10 sqrt(n)) entries)
  goes last, in increasing index, and a dense row (as many entries) is left
  out of the graph: they set the ordering's quality only, never what is
  solved, and every column is ordered;
- each step eliminates at least one variable, so there are at most n steps;
- the storage is O(nnz(A) + n): a new element is no larger than the
  elements it absorbs and the pivot's own neighbours together, which it
  replaces, and each variable's lists only shrink or swap absorbed elements
  for the new one.

The degrees and the fill they imply are heuristics, used for the ordering
and for routing only; admission counts actual bytes (_matlab_lu).

charge(units) is called before each piece of work with its size, in the
units of matlab.lu_work (one integer read from an element or variable
list); the Python loops between charges poll for Stop.
"""

import math as _math
import heapq as _heapq


def dense_threshold(n):
    """the entries past which a row or a column is dense (Davis et al. 2004):
    max(16, ceil(10 sqrt(n)))"""
    return max(16, int(_math.ceil(10 * _math.sqrt(n))))


def order_columns(m, n, jc, ir, charge=None, stats=None):
    """a permutation q (a list of n column indices) of the m-by-n sparse
    matrix with column starts jc and row indices ir (CSC, as Python lists or
    arrays), ordering A(:, q)'s columns by approximate minimum degree of
    A'*A's structure.  stats, a dict, gets "fill": the elimination's own
    estimate of nnz(L + U) (a routing heuristic, plan r6 section 2.4's s-hat):
    each pivot's supervariable of s columns, with l the weight of its new
    element, counts s^2 + 2 s l (its diagonal block and its rows and columns
    of L and U, the approximate degrees being upper bounds); each empty
    column 1; the d dense columns, ordered last, d (2n - d), as if dense"""
    charge = charge or (lambda units: None)
    jc = [int(v) for v in jc]
    nnz = jc[n]
    charge(nnz + n + m)
    ir = [int(v) for v in ir[:nnz]]
    dense = dense_threshold(n)
    # (each row's columns; the dense rows and dense columns set aside)
    rowcnt = [0] * m
    for r in ir:
        rowcnt[r] += 1
    dense_col = [jc[j + 1] - jc[j] > dense for j in range(n)]
    rows = [[] for _ in range(m)]
    for j in range(n):
        if dense_col[j]:
            continue
        for t in range(jc[j], jc[j + 1]):
            r = ir[t]
            if rowcnt[r] <= dense:
                rows[r].append(j)
    first, last = [], [j for j in range(n) if dense_col[j]]
    # the graph: ids 0..n-1 are the variables and the pivots' new elements
    # (a pivot's element takes its id), n..n+m-1 the rows' elements
    N = n + m
    L = [None] * N          # an element's variables
    lw = [0] * N            # an element's weight, sum of nv over L (fixed once made)
    alive_e = [False] * N
    E = [None] * n          # a variable's elements
    Adj = [None] * n        # a variable's variable neighbours
    nv = [0] * n            # a variable's supervariable size (0: merged or eliminated)
    members = [None] * n
    for r in range(m):
        if rows[r]:
            L[n + r] = rows[r]
            lw[n + r] = len(rows[r])
            alive_e[n + r] = True
    for j in range(n):
        E[j] = []
    for r in range(m):
        for j in rows[r]:
            E[j].append(n + r)
    live = 0
    deg = [0] * n
    for j in range(n):
        if dense_col[j]:
            continue
        if not E[j]:
            first.append(j)
            continue
        Adj[j] = []
        nv[j] = 1
        members[j] = [j]
        live += 1
    for j in range(n):
        if nv[j]:
            deg[j] = min(live - 1, sum(lw[e] - 1 for e in E[j]))
    heap = [(deg[j], j) for j in range(n) if nv[j]]
    _heapq.heapify(heap)
    order = []
    mark = [0] * N          # the new element's variables (stamped)
    wstamp = [0] * N        # w's elements (stamped)
    w = [0] * N             # |L_e \ L_p| by weight, for the elements met
    stamp = 0
    fill = 0
    remaining = live        # the live variables' total weight
    while remaining > 0:
        # the pivot: the smallest degree, then the smallest index (lazy heap)
        while True:
            d, p = _heapq.heappop(heap)
            if nv[p] and deg[p] == d:
                break
        Ep, Ap = E[p], Adj[p]
        charge(len(Ap) + sum(len(L[e]) for e in Ep) + len(Ep))
        stamp += 1
        # the new element: the absorbed elements' variables and the pivot's
        # neighbours, live ones, without the pivot
        Lp = []
        for e in Ep:
            for i in L[e]:
                if nv[i] and i != p and mark[i] != stamp:
                    mark[i] = stamp
                    Lp.append(i)
            alive_e[e] = False
            L[e] = None
        for i in Ap:
            if nv[i] and i != p and mark[i] != stamp:
                mark[i] = stamp
                Lp.append(i)
        order.extend(sorted(members[p]))
        remaining -= nv[p]
        sp = nv[p]
        nv[p] = 0
        E[p] = Adj[p] = members[p] = None
        lp = sum(nv[i] for i in Lp)
        fill += sp * sp + 2 * sp * lp
        L[p], lw[p], alive_e[p] = Lp, lp, True
        charge(sum(len(E[i]) + len(Adj[i]) for i in Lp))
        # |L_e \ L_p| for each element e met through L_p's variables
        for i in Lp:
            for e in E[i]:
                if alive_e[e] and e != p:
                    if wstamp[e] != stamp:
                        wstamp[e] = stamp
                        w[e] = lw[e]
                    w[e] -= nv[i]
        # (an element inside L_p is absorbed into it)
        for i in Lp:
            for e in E[i]:
                if alive_e[e] and e != p and wstamp[e] == stamp and w[e] == 0:
                    alive_e[e] = False
                    L[e] = None
        for i in Lp:
            Ei = [e for e in E[i] if alive_e[e] and e != p]
            Ei.append(p)
            E[i] = Ei
            Adj[i] = [j for j in Adj[i] if nv[j] and mark[j] != stamp and j != p]
            # the approximate external degree (Amestoy, Davis, Duff, eq. 4.1)
            ext = sum(nv[j] for j in Adj[i]) + (lp - nv[i]) + sum(w[e] for e in Ei if e != p)
            deg[i] = max(0, min(remaining - nv[i], deg[i] + lp - nv[i], ext))
        # supervariables: the variables of L_p with the same elements and
        # neighbours merge into the smallest index
        buckets = {}
        for i in Lp:
            h = (sum(E[i]) * 31 + sum(Adj[i]) * 7 + len(E[i]) * 3 + len(Adj[i])) % 1000003
            buckets.setdefault(h, []).append(i)
        for group in buckets.values():
            if len(group) < 2:
                continue
            group.sort()
            for a in range(len(group)):
                i = group[a]
                if not nv[i]:
                    continue
                si, sa = sorted(E[i]), sorted(Adj[i])
                for b in range(a + 1, len(group)):
                    j = group[b]
                    if nv[j] and len(E[j]) == len(si) and len(Adj[j]) == len(sa) and sorted(E[j]) == si and sorted(Adj[j]) == sa:
                        nv[i] += nv[j]
                        deg[i] = max(0, deg[i] - nv[j])
                        members[i].extend(members[j])
                        nv[j] = 0
                        E[j] = Adj[j] = members[j] = None
        L[p] = [i for i in Lp if nv[i]]
        for i in L[p]:
            _heapq.heappush(heap, (deg[i], i))
        # (the lazy heap stays O(n): rebuilt from the live variables)
        if len(heap) > 2 * n + 16:
            heap = [(deg[j], j) for j in range(n) if nv[j]]
            _heapq.heapify(heap)
    q = first + order + last
    if stats is not None:
        d = len(last)
        stats["fill"] = fill + len(first) + d * (2 * n - d)
    return q
