"""Crystals, as in Sage: crystals of letters (types A-D, G2, E6, E7), of
spins, of tableaux (Kashiwara-Nakashima), tensor products (Sage's
anti-Kashiwara convention), highest weight crystals, Kirillov-Reshetikhin
crystals of type A; crystal operators e_i, f_i, epsilon_i, phi_i, weights,
highest weight vectors, characters, crystal graphs and the Lusztig
involution.  Elements are enumerated in Sage's order (the preorder of the
spanning forest in which the parent of b is e_i(b) for the smallest such
i)."""

from fractions import Fraction as _F

import _sage_lie as _lie
from _sage_lie import CartanType, RootSystem_, _q, _out, _fs, _dot, _addv, _subv, _neg, _smul, _e, _data


def _sa():
    import sage_all
    return sage_all


def _zero(d):
    return tuple([_F(0)] * d)


# --------------------------------------------------------------- tableaux

class Tableau:
    """A tableau, given by its rows.

    EXAMPLES::

        sage: T = Tableau([[1,2,2], [2,3]]); T
        [[1, 2, 2], [2, 3]]
        sage: T.shape(), T.to_word()
        ([3, 2], word: 23122)
    """

    def __init__(self, rows):
        self._rows = [list(r) for r in rows]

    def __repr__(self):
        return repr(self._rows)

    def __eq__(self, other):
        if isinstance(other, Tableau):
            return self._rows == other._rows
        if isinstance(other, list):
            return self._rows == other
        return NotImplemented

    def __ne__(self, other):
        return not self == other

    def __hash__(self):
        return hash(tuple(tuple(r) for r in self._rows))

    def __iter__(self):
        return iter(self._rows)

    def __getitem__(self, i):
        return self._rows[i]

    def __len__(self):
        return len(self._rows)

    def shape(self):
        """The shape (row lengths).

        EXAMPLES::

            sage: Tableau([[1, 2, 5], [3, 4]]).shape()
            [3, 2]
        """
        return [len(r) for r in self._rows]

    def size(self):
        """The number of boxes.

        EXAMPLES::

            sage: Tableau([[1, 2, 5], [3, 4]]).size()
            5
        """
        return sum(len(r) for r in self._rows)

    def to_word(self):
        """The row reading word (rows from the bottom up).

        EXAMPLES::

            sage: Tableau([[1, 2, 5], [3, 4]]).to_word()
            word: 34125
        """
        return Word([x for r in reversed(self._rows) for x in r])

    def to_list(self):
        """The rows, as lists.

        EXAMPLES::

            sage: Tableau([[1, 2], [3]]).to_list()
            [[1, 2], [3]]
        """
        return [list(r) for r in self._rows]

    def conjugate(self):
        """The transpose.

        EXAMPLES::

            sage: Tableau([[1, 2, 5], [3, 4]]).conjugate()
            [[1, 3], [2, 4], [5]]
        """
        n = len(self._rows[0]) if self._rows else 0
        return Tableau([[r[j] for r in self._rows if j < len(r)] for j in range(n)])

    def schuetzenberger_involution(self, n=None):
        """The Schuetzenberger involution (evacuation) for entries in 1..n.

        EXAMPLES::

            sage: Tableau([[1, 2], [3]]).schuetzenberger_involution(n=4)
            [[2, 4], [3]]
        """
        w = self.to_word()
        if n is None:
            n = max(w) if w else 0
        w = [n + 1 - x for x in reversed(w)]
        return _rsk_insert(w)

    def is_semistandard(self):
        """Whether rows weakly increase and columns strictly increase.

        EXAMPLES::

            sage: Tableau([[1, 1], [2]]).is_semistandard(), Tableau([[1, 1], [1]]).is_semistandard()
            (True, False)
        """
        r = self._rows
        return all(r[i][j] <= r[i][j + 1] for i in range(len(r)) for j in range(len(r[i]) - 1)) and \
            all(r[i][j] < r[i + 1][j] for i in range(len(r) - 1) for j in range(len(r[i + 1])))


class Word:
    """A finite word (printed as Sage prints words).

    EXAMPLES::

        sage: Word([3, 1, 2]), Word([10, 2])
        (word: 312, word: 10,2)
    """

    def __init__(self, letters):
        self._w = list(letters)

    def __repr__(self):
        ls = [str(x) for x in self._w]
        return "word: " + ("".join(ls) if all(len(x) == 1 for x in ls) else ",".join(ls))

    def __iter__(self):
        return iter(self._w)

    def __len__(self):
        return len(self._w)

    def __getitem__(self, k):
        return self._w[k]

    def __eq__(self, other):
        if isinstance(other, Word):
            return self._w == other._w
        return self._w == list(other) if isinstance(other, (list, tuple)) else NotImplemented

    def __hash__(self):
        return hash(tuple(self._w))

    def __reversed__(self):
        return reversed(self._w)

    def length(self):
        """The length.

        EXAMPLES::

            sage: Word([3, 1, 2]).length()
            3
        """
        return len(self._w)


def _rsk_insert(word):
    rows = []
    for x in word:
        for r in rows:
            k = next((j for j, y in enumerate(r) if y > x), None)
            if k is None:
                r.append(x)
                break
            r[k], x = x, r[k]
        else:
            rows.append([x])
    return Tableau(rows)


# ------------------------------------------------------- generic crystals

class CrystalElement:
    """An element of a crystal.

    EXAMPLES::

        sage: B = crystals.Tableaux("A2", shape=[2,1]); b = B[0]; b, b.f(1), b.weight()
        ([[1, 1], [2]], [[1, 2], [2]], (2, 1, 0))
    """

    def parent(self):
        """The crystal.

        EXAMPLES::

            sage: B = crystals.Tableaux("A2", shape=[2,1]); B[0].parent()
            The crystal of tableaux of type ['A', 2] and shape(s) [[2, 1]]
        """
        return self._P

    # subclasses implement _e(i), _f(i), epsilon(i), phi(i), _wt(), _key()

    def e(self, i):
        """The raising operator e_i (None if undefined).

        EXAMPLES::

            sage: B = crystals.Tableaux("A2", shape=[2,1]); B[1].e(1), B[1].e(2)
            ([[1, 1], [2]], None)
        """
        return self._e(i)

    def f(self, i):
        """The lowering operator f_i (None if undefined).

        EXAMPLES::

            sage: B = crystals.Tableaux("A2", shape=[2,1]); B[0].f(1), B[0].f(1).f(1)
            ([[1, 2], [2]], None)
        """
        return self._f(i)

    def __eq__(self, other):
        return type(self) is type(other) and self._key() == other._key()

    def __ne__(self, other):
        return not self == other

    def __hash__(self):
        return hash(self._key())

    def __lt__(self, other):
        try:
            return self._P._index(self) < self._P._index(other)
        except (NotImplementedError, KeyError):
            return repr(self) < repr(other)

    def weight(self):
        """The weight (in the weight lattice realization).

        EXAMPLES::

            sage: B = crystals.Tableaux("A2", shape=[2,1]); B[3].weight()
            (1, 0, 2)
        """
        return self._P._realize(self._wt())

    def e_string(self, ls):
        """Apply e_i for i in the list (None if undefined).

        EXAMPLES::

            sage: B = crystals.Tableaux("A2", shape=[2,1]); B[4].e_string([1, 2])
            [[1, 3], [2]]
        """
        b = self
        for i in ls:
            b = b.e(i)
            if b is None:
                return None
        return b

    def f_string(self, ls):
        """Apply f_i for i in the list (None if undefined).

        EXAMPLES::

            sage: B = crystals.Tableaux("A2", shape=[2,1]); B[0].f_string([1, 2, 2])
            [[1, 3], [3]]
        """
        b = self
        for i in ls:
            b = b.f(i)
            if b is None:
                return None
        return b

    def is_highest_weight(self, index_set=None):
        """Whether e_i is undefined for all i (in the index set).

        EXAMPLES::

            sage: B = crystals.Tableaux("A2", shape=[2,1]); B[0].is_highest_weight(), B[1].is_highest_weight(), B[1].is_highest_weight(index_set=[2])
            (True, False, True)
        """
        I = index_set if index_set is not None else self._P.index_set()
        return all(self.epsilon(i) == 0 for i in I)

    def is_lowest_weight(self, index_set=None):
        """Whether f_i is undefined for all i (in the index set).

        EXAMPLES::

            sage: B = crystals.Tableaux("A2", shape=[2,1]); B[4].is_lowest_weight()
            True
        """
        I = index_set if index_set is not None else self._P.index_set()
        return all(self.phi(i) == 0 for i in I)

    def to_highest_weight(self, index_set=None):
        """(highest weight element, the list of i applied).

        EXAMPLES::

            sage: B = crystals.Tableaux("A2", shape=[2,1]); B[4].to_highest_weight()
            [[[1, 1], [2]], [1, 2, 2, 1]]
        """
        I = index_set if index_set is not None else self._P.index_set()
        b, path = self, []
        while True:
            for i in I:
                c = b.e(i)
                if c is not None:
                    b = c
                    path.append(i)
                    break
            else:
                return [b, path]

    def to_lowest_weight(self, index_set=None):
        """(lowest weight element, the list of i applied).

        EXAMPLES::

            sage: B = crystals.Tableaux("A2", shape=[2,1]); B[0].to_lowest_weight()
            [[[2, 3], [3]], [1, 2, 2, 1]]
        """
        I = index_set if index_set is not None else self._P.index_set()
        b, path = self, []
        while True:
            for i in I:
                c = b.f(i)
                if c is not None:
                    b = c
                    path.append(i)
                    break
            else:
                return [b, path]

    def Epsilon(self):
        """sum_i epsilon_i Lambda_i.

        EXAMPLES::

            sage: B = crystals.Tableaux("A2", shape=[2,1]); B[1].Epsilon()
            (1, 0, 0)
        """
        L = self._P._Lambda()
        return sum((self.epsilon(i) * L[i] for i in self._P.index_set()), L[self._P.index_set()[0]] * 0)

    def Phi(self):
        """sum_i phi_i Lambda_i.

        EXAMPLES::

            sage: B = crystals.Tableaux("A2", shape=[2,1]); B[0].Phi()
            (2, 1, 0)
        """
        L = self._P._Lambda()
        return sum((self.phi(i) * L[i] for i in self._P.index_set()), L[self._P.index_set()[0]] * 0)

    def lusztig_involution(self):
        """The Lusztig involution (on the connected component).

        EXAMPLES::

            sage: B = crystals.Tableaux(['A',3], shape=[2,1]); b = B(rows=[[1,2],[3]])
            sage: b.lusztig_involution()
            [[2, 4], [3]]
        """
        hw, path = self.to_highest_weight()
        lw = hw.to_lowest_weight()[0]
        sigma = _star(self._P.cartan_type())
        b = lw
        for i in reversed(path):
            b = b.e(sigma.get(i, i))
        return b

    def __pos__(self):
        return self


def _star(ct):
    """The diagram automorphism -w0 on the index set."""
    out, off = {}, 0
    for c in ct.component_types():
        l, n = c._letter, c._n
        m = {}
        if l == "A":
            m = {i: n + 1 - i for i in range(1, n + 1)}
        elif l == "D" and n % 2 == 1:
            m = {n - 1: n, n: n - 1}
        elif l == "E" and n == 6:
            m = {1: 6, 6: 1, 3: 5, 5: 3}
        for i in range(1, n + 1):
            out[off + i] = off + m.get(i, i) if ct._components else m.get(i, i)
        off += n
    return out


class Crystal:
    """A crystal: elements generated from module generators by the f_i (or
    an explicit list), with weights in a realization.

    EXAMPLES::

        sage: B = crystals.Tableaux("A2", shape=[2,1]); B
        The crystal of tableaux of type ['A', 2] and shape(s) [[2, 1]]
        sage: B.cardinality(), B.index_set()
        (8, (1, 2))
    """

    _repr = "A crystal"

    def __repr__(self):
        return self._repr

    def cartan_type(self):
        """The Cartan type.

        EXAMPLES::

            sage: B = crystals.Tableaux("A2", shape=[2,1]); B.cartan_type()
            ['A', 2]
        """
        return self._ct

    def index_set(self):
        """The index set.

        EXAMPLES::

            sage: B = crystals.Tableaux("A2", shape=[2,1]); B.index_set()
            (1, 2)
        """
        return tuple(self._ct.index_set())

    def weight_lattice_realization(self):
        """The ambient space in which the weights live.

        EXAMPLES::

            sage: crystals.Tableaux("A2", shape=[2,1]).weight_lattice_realization()
            Ambient space of the Root system of type ['A', 2]
        """
        return self._space

    def _realize(self, v):
        if isinstance(self._space, _lie.WeightLattice):
            return _lie.AffineWeight(self._space, v)
        return _lie.AmbientVector(self._space, v)

    def _Lambda(self):
        return self._space.fundamental_weights()

    def Lambda(self):
        """The fundamental weights.

        EXAMPLES::

            sage: crystals.Tableaux(['A',2], shape=[2,1]).Lambda()
            Finite family {1: (1, 0, 0), 2: (1, 1, 0)}
        """
        return self._Lambda()

    def _children(self, b):
        out = []
        for i in self.index_set():
            c = b.f(i)
            if c is not None and _first_e(c, self.index_set()) == i:
                out.append(c)
        return out

    def _elements(self):
        if getattr(self, "_cache", None) is None:
            if hasattr(self, "_explicit"):
                self._cache = self._explicit()
            else:
                out = []
                stack = list(reversed(self.module_generators))
                while stack:
                    b = stack.pop()
                    out.append(b)
                    stack.extend(reversed(self._children(b)))
                self._cache = out
            self._pos = {b: k for k, b in enumerate(self._cache)}
        return self._cache

    def _index(self, b):
        self._elements()
        return self._pos[b]

    def __iter__(self):
        return iter(self._elements())

    def list(self):
        """The elements, in Sage's order.

        EXAMPLES::

            sage: C = crystals.Letters("A2"); C.list()
            [1, 2, 3]
        """
        return list(self._elements())

    def __getitem__(self, k):
        return self._elements()[k]

    def __len__(self):
        return len(self._elements())

    def __contains__(self, b):
        return b in self._elements()

    def cardinality(self):
        """The number of elements.

        EXAMPLES::

            sage: crystals.Spins("B3").cardinality()
            8
        """
        return _sa().Integer(len(self._elements()))

    def is_finite(self):
        """Whether the crystal is finite.

        EXAMPLES::

            sage: B = crystals.Tableaux("A2", shape=[2,1]); B.is_finite()
            True
        """
        return True

    def an_element(self):
        """An element (the first module generator).

        EXAMPLES::

            sage: B = crystals.Tableaux("A2", shape=[2,1]); B.an_element()
            [[1, 1], [2]]
        """
        return self.module_generators[0]

    def highest_weight_vector(self):
        """The highest weight vector (of a connected crystal).

        EXAMPLES::

            sage: crystals.Tableaux("A2", shape=[2,1]).highest_weight_vector()
            [[1, 1], [2]]
        """
        h = self.highest_weight_vectors()
        if len(h) != 1:
            raise RuntimeError("the crystal is not connected")
        return h[0]

    def highest_weight_vectors(self):
        """The highest weight vectors.

        EXAMPLES::

            sage: C = crystals.Letters("A2"); T = crystals.TensorProduct(C,C,C)
            sage: T.highest_weight_vectors()
            ([1, 1, 1], [2, 1, 1], [1, 2, 1], [3, 2, 1])
        """
        return tuple(b for b in self if b.is_highest_weight())

    def lowest_weight_vectors(self):
        """The lowest weight vectors.

        EXAMPLES::

            sage: B = crystals.Tableaux("A2", shape=[2,1]); B.lowest_weight_vectors()
            ([[2, 3], [3]],)
        """
        return tuple(b for b in self if b.is_lowest_weight())

    def character(self, R=None):
        """The character, in the Weyl character ring R.

        EXAMPLES::

            sage: A2 = WeylCharacterRing("A2"); C = crystals.Letters("A2"); T = crystals.TensorProduct(C,C,C)
            sage: T.character(A2)
            A2(1,1,1) + 2*A2(2,1,0) + A2(3,0,0)
        """
        if R is None:
            R = _lie.WeylCharacterRing(self._ct)
        w = {}
        for b in self:
            v = b._wt()
            w[v] = w.get(v, 0) + 1
        return R.char_from_weights({_lie.AmbientVector(R._space, v): m for v, m in w.items()})

    def digraph(self, subset=None, index_set=None):
        """The crystal graph (edges b -> f_i(b) labelled i).

        EXAMPLES::

            sage: crystals.Letters("A2").digraph()
            Digraph on 3 vertices
        """
        I = index_set if index_set is not None else self.index_set()
        S = list(subset) if subset is not None else self.list()
        Sset = set(S)
        G = _sa().DiGraph()
        for b in S:
            G.add_vertex(b)
        for b in S:
            for i in I:
                c = b.f(i)
                if c is not None and c in Sset:
                    G.add_edge(b, c, i)
        return G

    def plot(self, **options):
        """The crystal graph, plotted.

        EXAMPLES::

            sage: crystals.Letters("A2").plot()
            Graphics object consisting of 8 graphics primitives
        """
        G = self.digraph()
        return G.plot(edge_labels=True, **options)

    def latex_file(self, filename):
        """Write a LaTeX file of the crystal graph (a stub here).

        EXAMPLES::

            sage: B = crystals.Tableaux("A2", shape=[2,1]); fn = tmp_filename(ext='.tex'); B.latex_file(fn)
        """
        open(filename, "w").write("% crystal graph\n")

    def subcrystal(self, index_set=None, generators=None, max_depth=None, direction="both", contained=None):
        """The elements reachable from the generators by e_i and f_i for i
        in the index set.

        EXAMPLES::

            sage: B = crystals.Tableaux(['A',2], shape=[2,1])
            sage: len(B.subcrystal(index_set=[1], generators=[B[0]]))
            2
        """
        I = index_set if index_set is not None else self.index_set()
        gens = list(generators) if generators is not None else list(self.module_generators)
        seen = set(gens)
        out = list(gens)
        level = list(gens)
        depth = 0
        while level and (max_depth is None or depth < max_depth):
            nxt = []
            for b in level:
                for i in I:
                    for c in ([b.f(i)] if direction in ("both", "lower") else []) + ([b.e(i)] if direction in ("both", "upper") else []):
                        if c is not None and c not in seen:
                            seen.add(c)
                            out.append(c)
                            nxt.append(c)
            level = nxt
            depth += 1
        return out

    def crystal_morphism(self, on_gens, **kwds):
        """The crystal morphism with the given images of the highest weight
        elements (a dict).

        EXAMPLES::

            sage: C = crystals.Letters('A2'); B = crystals.Tableaux('A2', shape=[1])
            sage: Psi = C.crystal_morphism({C(1): B[0]}); [Psi(x) for x in C]
            [[[1]], [[2]], [[3]]]
        """
        return crystal_morphism(self, on_gens)

    def connected_components_generators(self):
        """The highest weight vectors of the components.

        EXAMPLES::

            sage: C = crystals.Letters("A2"); crystals.TensorProduct(C, C).connected_components_generators()
            ([1, 1], [2, 1])
        """
        return self.highest_weight_vectors()


def _first_e(b, I):
    for i in I:
        if b.epsilon(i) > 0:
            return i
    return None


# -------------------------------------------------------- letters and spins

class _LetterElement(CrystalElement):
    __slots__ = ("_P", "_v")

    def __init__(self, P, v):
        self._P, self._v = P, v

    def _key(self):
        return self._v

    def __repr__(self):
        return repr(self._v) if not isinstance(self._v, int) else str(self._v)

    def value(self):
        """The letter.

        EXAMPLES::

            sage: crystals.Letters("D3")(-3).value()
            -3
        """
        return self._v

    def _e(self, i):
        v = self._P._einv[i].get(self._v)
        return None if v is None else self._P._el(v)

    def _f(self, i):
        v = self._P._fmap[i].get(self._v)
        return None if v is None else self._P._el(v)

    def epsilon(self, i):
        """epsilon_i (the length of the i-string above).

        EXAMPLES::

            sage: C = crystals.Letters("B2"); C(0).epsilon(2), C(-2).epsilon(2)
            (1, 2)
        """
        k, v = 0, self._v
        E = self._P._einv[i]
        while v in E:
            v = E[v]
            k += 1
        return _sa().Integer(k)

    def phi(self, i):
        """phi_i (the length of the i-string below).

        EXAMPLES::

            sage: C = crystals.Letters("B2"); C(2).phi(2), C(0).phi(2)
            (2, 1)
        """
        k, v = 0, self._v
        Fm = self._P._fmap[i]
        while v in Fm:
            v = Fm[v]
            k += 1
        return _sa().Integer(k)

    def _wt(self):
        return self._P._wts[self._v]


class CrystalOfLetters(Crystal):
    """The crystal of letters (the crystal of the standard representation;
    for E6 and E7 the minuscule 27 and 56).

    EXAMPLES::

        sage: crystals.Letters("C3"), crystals.Letters("C3").list()
        (The crystal of letters for type ['C', 3], [1, 2, 3, -3, -2, -1])
    """

    def __init__(self, ct, dual=False):
        self._ct = ct
        self._dual = dual
        self._space = RootSystem_(ct).ambient_space()
        self._repr = "The crystal of letters for type %r" % (ct,) + (" (dual)" if dual else "")
        l, n = ct._letter, ct._n
        d = _data(ct).dim
        fm = {i: {} for i in ct.index_set()}
        wts = {}
        if l in "ABCD":
            if l == "A":
                letters = list(range(1, n + 2))
            elif l == "B":
                letters = list(range(1, n + 1)) + [0] + list(range(-n, 0))
            else:
                letters = list(range(1, n + 1)) + list(range(-n, 0))
            for x in letters:
                wts[x] = _zero(d) if x == 0 else _e(d, (abs(x) - 1, 1 if x > 0 else -1))
            for i in range(1, n + 1):
                if l == "A" or i < n:
                    fm[i][i] = i + 1
                    if l != "A":
                        fm[i][-(i + 1)] = -i
            if l == "B":
                fm[n][n] = 0
                fm[n][0] = -n
            elif l == "C":
                fm[n][n] = -n
            elif l == "D":
                fm[n][n - 1] = -n
                fm[n][n] = -(n - 1)
        elif l == "G":
            letters = [1, 2, 3, 0, -3, -2, -1]
            W = {1: (1, 0, -1), 2: (1, -1, 0), 3: (0, 1, -1), 0: (0, 0, 0)}
            for x in letters:
                wts[x] = tuple(_F(a) for a in W[x]) if x >= 0 else _neg(tuple(_F(a) for a in W[-x]))
            fm[1] = {1: 2, 3: 0, 0: -3, -2: -1}
            fm[2] = {2: 3, -3: -2}
        elif l == "E" and n in (6, 7):
            D = _data(ct)
            top = (D.fw[5] if dual else D.fw[0]) if n == 6 else D.fw[6]
            letters, seen = [], {}
            stack = [top]
            lab = lambda w: _elabel(D, w)
            order = []
            while stack:
                w = stack.pop()
                if w in seen:
                    continue
                seen[w] = lab(w)
                order.append(w)
                for k, (a, c) in enumerate(zip(D.simple, D.coroots)):
                    if _dot(w, c) == 1:
                        stack.append(_subv(w, a))
            for w in order:
                wts[seen[w]] = w
            for k, (a, c) in enumerate(zip(D.simple, D.coroots)):
                i = D.I[k]
                for w in order:
                    if _dot(w, c) == 1:
                        fm[i][seen[w]] = seen[_subv(w, a)]
            letters = None
            self._top = seen[top]
        else:
            raise NotImplementedError("crystal of letters of type %r" % (ct,))
        self._fmap = fm
        self._einv = {i: {v: k for k, v in fm[i].items()} for i in fm}
        self._wts = wts
        self._letters = letters
        self.module_generators = (self._el(letters[0] if letters else self._top),)

    def _el(self, v):
        return _LetterElement(self, v)

    def __call__(self, v):
        """The letter with the given value.

        EXAMPLES::

            sage: C = crystals.Letters("B2"); C(0), C(-1).weight()
            (0, (-1, 0))
        """
        if isinstance(v, _LetterElement):
            return v
        if isinstance(v, (list, tuple)):
            v = tuple(int(a) for a in v)
        else:
            v = int(v)
        if v not in self._wts:
            raise ValueError("%r is not a letter" % (v,))
        return self._el(v)

    def __eq__(self, other):
        return isinstance(other, CrystalOfLetters) and self._ct == other._ct

    def __hash__(self):
        return hash(("letters", self._ct))


def _elabel(D, w):
    neg = sorted((D.I[k] for k, c in enumerate(D.coroots) if _dot(w, c) == -1))
    pos = sorted((D.I[k] for k, c in enumerate(D.coroots) if _dot(w, c) == 1))
    return tuple([-i for i in neg] + pos)


class _SpinElement(CrystalElement):
    __slots__ = ("_P", "_v")

    def __init__(self, P, v):
        self._P, self._v = P, v

    def _key(self):
        return self._v

    def __repr__(self):
        return "".join("+" if s > 0 else "-" for s in self._v)

    def signature(self):
        """The signs.

        EXAMPLES::

            sage: crystals.Spins("B3")[3].signature()
            '-++'
        """
        return repr(self)

    def _e(self, i):
        v = self._P._op(self._v, i, False)
        return None if v is None else _SpinElement(self._P, v)

    def _f(self, i):
        v = self._P._op(self._v, i, True)
        return None if v is None else _SpinElement(self._P, v)

    def epsilon(self, i):
        """epsilon_i.

        EXAMPLES::

            sage: C = crystals.Spins("B2"); C("+-").epsilon(2), C("--").epsilon(2)
            (1, 1)
        """
        return _sa().Integer(int(self._P._op(self._v, i, False) is not None))

    def phi(self, i):
        """phi_i.

        EXAMPLES::

            sage: C = crystals.Spins("B2"); C("++").phi(1), C("++").phi(2)
            (0, 1)
        """
        return _sa().Integer(int(self._P._op(self._v, i, True) is not None))

    def _wt(self):
        return tuple(_F(s, 2) for s in self._v)


class CrystalOfSpins(Crystal):
    """The crystal of spins of type B_n, or the plus/minus spins of type D_n.

    EXAMPLES::

        sage: C = crystals.Spins("B2"); C, C.list()
        (The crystal of spins for type ['B', 2], [++, +-, -+, --])
    """

    def __init__(self, ct, kind):
        self._ct, self._kind = ct, kind
        self._space = RootSystem_(ct).ambient_space()
        n = ct._n
        name = {"B": "The crystal of spins", "plus": "The plus crystal of spins", "minus": "The minus crystal of spins"}[kind]
        self._repr = "%s for type %r" % (name, ct)
        top = tuple([1] * n) if kind != "minus" else tuple([1] * (n - 1) + [-1])
        self.module_generators = (_SpinElement(self, top),)

    def _op(self, v, i, lower):
        n = self._ct._n
        v = list(v)
        a, b = (1, -1) if lower else (-1, 1)
        if i < n:
            if v[i - 1] == a and v[i] == b:
                v[i - 1], v[i] = b, a
                return tuple(v)
            return None
        if self._kind == "B":
            if v[n - 1] == a:
                v[n - 1] = b
                return tuple(v)
            return None
        if v[n - 2] == a and v[n - 1] == a:
            v[n - 2] = v[n - 1] = b
            return tuple(v)
        return None

    def __call__(self, v):
        """The spin with the given signs.

        EXAMPLES::

            sage: C = crystals.Spins("B2"); C("+-").f(2)
        """
        if isinstance(v, _SpinElement):
            return v
        if isinstance(v, str):
            v = [1 if c == "+" else -1 for c in v]
        return _SpinElement(self, tuple(int(a) for a in v))


# ---------------------------------------------------------- tensor products

def _signature(factors, i):
    """Sage's (anti-Kashiwara) signature rule: (index of the factor f_i acts
    on or None, index for e_i or None, epsilon, phi)."""
    eps = [b.epsilon(i) for b in factors]
    phs = [b.phi(i) for b in factors]
    if any(isinstance(x, float) for x in eps + phs):
        return _signature_general(factors, i, eps, phs)
    plus, minus = [], []
    for j in range(len(factors) - 1, -1, -1):
        b = factors[j]
        for _ in range(int(b.epsilon(i))):
            if plus:
                plus.pop()
            else:
                minus.append(j)
        for _ in range(int(b.phi(i))):
            plus.append(j)
    return (plus[0] if plus else None), (minus[-1] if minus else None), len(minus), len(plus)


def _signature_general(factors, i, eps, phs):
    """The tensor product rule from epsilon, phi and <wt, h_i> (also for
    crystals that are not seminormal, such as T_lambda)."""
    N = len(factors)
    c = list(range(N - 1, -1, -1))     # Kashiwara order: b_N (x) ... (x) b_1
    E = [None] * N
    Ph = [None] * N
    hi = []
    for j in c:
        b = factors[j]
        e, p = eps[j], phs[j]
        h = (p - e) if not (isinstance(e, float) or isinstance(p, float)) else b._hi(i)
        hi.append(h)
    # prefix values over the Kashiwara order
    pe, pp, ph = None, None, 0
    for t, j in enumerate(c):
        e, p, h = eps[j], phs[j], hi[t]
        if t == 0:
            pe, pp, ph = e, p, h
        else:
            pe, pp = max(pe, e - ph), max(p, pp + h)
            ph = ph + h
        E[t], Ph[t] = pe, pp

    def where(lower):
        t = N - 1
        while t > 0:
            j = c[t]
            go_left = Ph[t - 1] > eps[j] if lower else Ph[t - 1] >= eps[j]
            if go_left:
                t -= 1
            else:
                return j
        return c[0]
    # the chosen factor's own e_i / f_i decide (they may be undefined)
    return where(True), where(False), E[N - 1], Ph[N - 1]


class TensorProductElement(CrystalElement):
    """

    EXAMPLES::

        sage: C = crystals.Letters("A2"); T = crystals.TensorProduct(C, C); b = T(C(1), C(2)); b, b.f(1), b.e(1)
        ([1, 2], [2, 2], [1, 1])
    """
    __slots__ = ("_P", "_f_")

    def __init__(self, P, factors):
        self._P, self._f_ = P, tuple(factors)

    def _key(self):
        return tuple(b._key() for b in self._f_)

    def __repr__(self):
        return "[" + ", ".join(repr(b) for b in self._f_) + "]"

    def __iter__(self):
        return iter(self._f_)

    def __getitem__(self, k):
        return self._f_[k]

    def __len__(self):
        return len(self._f_)

    def _e(self, i):
        j = _signature(self._f_, i)[1]
        if j is None:
            return None
        fs = list(self._f_)
        fs[j] = fs[j].e(i)
        if fs[j] is None:
            return None
        return TensorProductElement(self._P, fs)

    def _f(self, i):
        j = _signature(self._f_, i)[0]
        if j is None:
            return None
        fs = list(self._f_)
        fs[j] = fs[j].f(i)
        if fs[j] is None:
            return None
        return TensorProductElement(self._P, fs)

    def epsilon(self, i):
        """epsilon_i (by the signature rule).

        EXAMPLES::

            sage: C = crystals.Letters("A2"); T = crystals.TensorProduct(C, C); T(C(1), C(2)).epsilon(1), T(C(2), C(1)).epsilon(1)
            (1, 0)
        """
        x = _signature(self._f_, i)[2]
        return x if isinstance(x, float) else _sa().Integer(x)

    def phi(self, i):
        """phi_i (by the signature rule).

        EXAMPLES::

            sage: C = crystals.Letters("A2"); T = crystals.TensorProduct(C, C); T(C(1), C(2)).phi(1), T(C(2), C(1)).phi(1)
            (1, 0)
        """
        x = _signature(self._f_, i)[3]
        return x if isinstance(x, float) else _sa().Integer(x)

    def _hi(self, i):
        return sum(b._hi(i) if hasattr(b, "_hi") else b.phi(i) - b.epsilon(i) for b in self._f_)

    def _wt(self):
        w = None
        for b in self._f_:
            v = b._wt()
            w = v if w is None else _addv(w, v)
        return w


class TensorProductOfCrystals(Crystal):
    """The tensor product of crystals (all of it, or the part generated by
    given elements).

    EXAMPLES::

        sage: C = crystals.Letters("A2"); T = crystals.TensorProduct(C, C); T
        Full tensor product of the crystals [The crystal of letters for type ['A', 2], The crystal of letters for type ['A', 2]]
        sage: T.list()
        [[1, 1], [1, 2], [1, 3], [2, 1], [2, 2], [2, 3], [3, 1], [3, 2], [3, 3]]
    """

    def __init__(self, crystals, generators=None):
        self._crystals = list(crystals)
        self._ct = self._crystals[0]._ct
        self._space = self._crystals[0]._space
        names = "[" + ", ".join(repr(c) for c in self._crystals) + "]"
        if generators is None:
            self._repr = "Full tensor product of the crystals " + names
            self._full = True
        else:
            self._repr = "The tensor product of the crystals " + names
            self._full = False
            self.module_generators = tuple(self(*g) if not isinstance(g, TensorProductElement) else g for g in generators)

    def crystals(self):
        """The factors.

        EXAMPLES::

            sage: C = crystals.Letters("A2"); crystals.TensorProduct(C, C).crystals()
            [The crystal of letters for type ['A', 2], The crystal of letters for type ['A', 2]]
        """
        return list(self._crystals)

    def _explicit_full(self):
        import itertools
        out = []
        for t in itertools.product(*[c.list() for c in self._crystals]):
            out.append(TensorProductElement(self, t))
        return out

    def _elements(self):
        if self._full and getattr(self, "_cache", None) is None:
            self._cache = self._explicit_full()
            self._pos = {b: k for k, b in enumerate(self._cache)}
        return Crystal._elements(self)

    def __call__(self, *args):
        """The element with the given factors.

        EXAMPLES::

            sage: C = crystals.Letters("A2"); T = crystals.TensorProduct(C, C); T(C(3), C(1))
            [3, 1]
        """
        if len(args) == 1 and isinstance(args[0], (list, tuple)):
            args = args[0]
        return TensorProductElement(self, [c(a) if not isinstance(a, CrystalElement) else a for c, a in zip(self._crystals, args)])

    def highest_weight_vectors(self):
        """The highest weight vectors.

        EXAMPLES::

            sage: C = crystals.Letters("A2"); crystals.TensorProduct(C, C).highest_weight_vectors()
            ([1, 1], [2, 1])
        """
        if not self._full:
            return Crystal.highest_weight_vectors(self)
        cs = self._crystals
        if len(cs) == 1:
            return tuple(TensorProductElement(self, [b]) for b in cs[0].highest_weight_vectors())
        tail = TensorProductOfCrystals(cs[1:])
        out = []
        for h in tail.highest_weight_vectors():
            for x in cs[0]:
                b = TensorProductElement(self, [x] + list(h._f_))
                if b.is_highest_weight():
                    out.append(b)
        return tuple(out)

    def cardinality(self):
        """The number of elements.

        EXAMPLES::

            sage: C = crystals.Letters("A2"); crystals.TensorProduct(C, C, C).cardinality()
            27
        """
        if self._full:
            r = 1
            for c in self._crystals:
                r *= int(c.cardinality())
            return _sa().Integer(r)
        return Crystal.cardinality(self)


def TensorProduct(*crystals, **options):
    """The tensor product of crystals (Sage's anti-Kashiwara convention).

    EXAMPLES::

        sage: C = crystals.Letters("A2"); T = crystals.TensorProduct(C,C,C); T.cardinality()
        27
        sage: T = crystals.TensorProduct(C, C, generators=[[C(2), C(1)]]); T.list()
        [[2, 1], [3, 1], [3, 2]]
    """
    return TensorProductOfCrystals(crystals, options.get("generators"))


# ------------------------------------------------------- crystals of tableaux

class _TableauElement(CrystalElement):
    """A Kashiwara-Nakashima tableau: a word of letters (column reading,
    columns left to right, each from the bottom up), possibly with a spin."""

    __slots__ = ("_P", "_shape", "_w", "_spin")

    def __init__(self, P, shape, word, spin=None):
        self._P, self._shape, self._w, self._spin = P, tuple(shape), tuple(word), spin

    def _key(self):
        return (self._shape, tuple(b._v for b in self._w), self._spin._v if self._spin is not None else None)

    def _factors(self):
        return ([self._spin] if self._spin is not None else []) + list(self._w)

    def _rows(self):
        cols = _col_lengths(self._shape)
        rows = [[] for _ in range(len(self._shape))]
        k = 0
        for c in cols:
            col = [self._w[k + t]._v for t in range(c)]
            k += c
            for r, x in enumerate(reversed(col)):
                rows[r].append(x)
        return [r for r in rows if r]

    def __repr__(self):
        t = repr(self._rows())
        if self._spin is not None:
            return "[%r, %s]" % (self._spin, t)
        return t

    def to_tableau(self):
        """The tableau.

        EXAMPLES::

            sage: B = crystals.Tableaux(['A',3], shape=[2,1]); B[1].to_tableau()
            [[1, 2], [2]]
        """
        return Tableau(self._rows())

    def __iter__(self):
        return iter([b._v for b in self._w])

    def _new(self, fs):
        if self._spin is not None:
            return _TableauElement(self._P, self._shape, fs[1:], fs[0])
        return _TableauElement(self._P, self._shape, fs)

    def _e(self, i):
        fs = self._factors()
        j = _signature(fs, i)[1]
        if j is None:
            return None
        fs[j] = fs[j].e(i)
        if fs[j] is None:
            return None
        return self._new(fs)

    def _f(self, i):
        fs = self._factors()
        j = _signature(fs, i)[0]
        if j is None:
            return None
        fs[j] = fs[j].f(i)
        if fs[j] is None:
            return None
        return self._new(fs)

    def epsilon(self, i):
        return _sa().Integer(_signature(self._factors(), i)[2])

    def phi(self, i):
        return _sa().Integer(_signature(self._factors(), i)[3])

    def _wt(self):
        w = _zero(_data(self._P._ct).dim)
        for b in self._factors():
            w = _addv(w, b._wt())
        return w

    def shape(self):
        return list(self._shape)


def _col_lengths(shape):
    shape = [int(x) for x in shape if x]
    if not shape:
        return []
    return [sum(1 for r in shape if r > j) for j in range(shape[0])]


class CrystalOfTableaux(Crystal):
    """The crystal of (Kashiwara-Nakashima) tableaux of given shape(s).

    EXAMPLES::

        sage: B = crystals.Tableaux(["C",2], shape=[1,1]); B
        The crystal of tableaux of type ['C', 2] and shape(s) [[1, 1]]
        sage: B.list()
        [[[1], [2]], [[1], [-2]], [[2], [-2]], [[2], [-1]], [[-2], [-1]]]
    """

    def __init__(self, ct, shapes):
        self._ct = ct
        self._space = RootSystem_(ct).ambient_space()
        self._letters = CrystalOfLetters(ct)
        self._shapes = [[_q(x) for x in s] for s in shapes]
        sh = ", ".join("[" + ", ".join(_fs(x) for x in s) + "]" for s in self._shapes)
        self._repr = "The crystal of tableaux of type %r and shape(s) [%s]" % (ct, sh)
        self.module_generators = tuple(self._hw(s) for s in self._shapes)

    def _hw(self, shape):
        l, n = self._ct._letter, self._ct._n
        spin = None
        sh = list(shape)
        if any(x.denominator == 2 for x in sh):
            sh = sh + [_F(0)] * (n - len(sh))
            if l == "B":
                spin = CrystalOfSpins(self._ct, "B").module_generators[0]
            elif l == "D":
                spin = CrystalOfSpins(self._ct, "minus" if sh[-1] < 0 else "plus").module_generators[0]
            sh = [abs(x) - _F(1, 2) for x in sh]
        sh = [int(x) for x in sh if x]
        cols = _col_lengths(sh)
        word = []
        for c in cols:
            word += [self._letters(k) for k in range(c, 0, -1)]
        return _TableauElement(self, sh, word, spin)

    def __call__(self, *args, **kwds):
        """The tableau with the given rows (or columns).

        EXAMPLES::

            sage: B = crystals.Tableaux(["A",3], shape=[2,1]); B(rows=[[1,2],[3]]), B(columns=[[1,3],[2]])
            ([[1, 2], [3]], [[1, 2], [3]])
        """
        rows = kwds.get("rows")
        if rows is None and "columns" in kwds:
            cols = kwds["columns"]
            word = []
            for c in cols:
                word += [self._letters(x) for x in reversed(c)]
            sh = [sum(1 for c in cols if len(c) > r) for r in range(max(len(c) for c in cols))]
            return _TableauElement(self, sh, word)
        if rows is None and args:
            rows = args[0]
            if isinstance(rows, (_TableauElement,)):
                return rows
        sh = [len(r) for r in rows]
        word = []
        for j in range(len(rows[0]) if rows else 0):
            col = [rows[r][j] for r in range(len(rows)) if j < len(rows[r])]
            word += [self._letters(x) for x in reversed(col)]
        g = self.module_generators[0]
        return _TableauElement(self, sh, word, g._spin)

    def shapes(self):
        """The shapes.

        EXAMPLES::

            sage: crystals.Tableaux("A2", shapes=[[2,1],[1]]).shapes()
            [[Fraction(2, 1), Fraction(1, 1)], [Fraction(1, 1)]]
        """
        return [list(s) for s in self._shapes]


def Tableaux(ct, shape=None, shapes=None):
    """The crystal of tableaux of a classical type (or G2) and shape(s).

    EXAMPLES::

        sage: B = crystals.Tableaux("A2", shape=[2,1]); B
        The crystal of tableaux of type ['A', 2] and shape(s) [[2, 1]]
        sage: B.list()
        [[[1, 1], [2]], [[1, 2], [2]], [[1, 3], [2]], [[1, 3], [3]], [[2, 3], [3]], [[1, 1], [3]], [[1, 2], [3]], [[2, 2], [3]]]
        sage: crystals.Tableaux(['B',2], shape=[3/2,1/2]).cardinality()
        16
    """
    ct = CartanType(ct)
    if shapes is None:
        shapes = [shape]
    return CrystalOfTableaux(ct, shapes)


def Letters(ct, element_print_style=None, dual=None):
    """The crystal of letters.

    EXAMPLES::

        sage: C = crystals.Letters("B2"); C, C.list()
        (The crystal of letters for type ['B', 2], [1, 2, 0, -2, -1])
        sage: crystals.Letters("E6").list()[:5]
        [(1,), (-1, 3), (-3, 4), (-4, 2, 5), (-2, 5)]
    """
    return CrystalOfLetters(CartanType(ct), bool(dual))


def Spins(ct):
    """The crystal of spins of type B.

    EXAMPLES::

        sage: crystals.Spins("B3").list()
        [+++, ++-, +-+, -++, +--, -+-, --+, ---]
    """
    return CrystalOfSpins(CartanType(ct), "B")


def SpinsPlus(ct):
    """The plus crystal of spins of type D.

    EXAMPLES::

        sage: crystals.SpinsPlus("D4").list()
        [++++, ++--, +-+-, -++-, +--+, -+-+, --++, ----]
    """
    return CrystalOfSpins(CartanType(ct), "plus")


def SpinsMinus(ct):
    """The minus crystal of spins of type D.

    EXAMPLES::

        sage: crystals.SpinsMinus("D4")[0].weight()
        (1/2, 1/2, 1/2, -1/2)
    """
    return CrystalOfSpins(CartanType(ct), "minus")


class _FastRankTwo(CrystalOfTableaux):
    def __init__(self, ct, shape):
        CrystalOfTableaux.__init__(self, ct, [shape])
        self._repr = "The fast crystal for %s with shape [%s]" % (ct._short(), ",".join(_fs(_q(x)) for x in shape))


def FastRankTwo(ct, shapes=None, shape=None, format=None):
    """The crystal of tableaux of a rank two type (as Sage's fast crystal).

    EXAMPLES::

        sage: B = crystals.FastRankTwo(['B',2], shape=[3/2,1/2]); B
        The fast crystal for B2 with shape [3/2,1/2]
        sage: B.highest_weight_vector().weight()
        (3/2, 1/2)
    """
    return _FastRankTwo(CartanType(ct), shape if shape is not None else shapes[0])


def HighestWeight(dominant_weight, model=None):
    """The highest weight crystal B(lambda) of a finite type.

    EXAMPLES::

        sage: La = CartanType(['E',6]).root_system().weight_lattice().fundamental_weights()
        sage: T = crystals.HighestWeight(La[1]); t = T[4]; t
        [(-2, 5)]
        sage: t.lusztig_involution()
        [(-3, 2)]
    """
    w = dominant_weight
    P = w._P
    ct = P._ct
    I = list(ct.index_set())
    c = {i: int(w._v[k]) for k, i in enumerate(I)}
    l = ct._letter
    if l in "ABCDG" and ct.is_irreducible():
        D = _data(ct)
        v = _zero(D.dim)
        for k, i in enumerate(I):
            v = _addv(v, _smul(c[i], D.fw[k]))
        return _HW(Tableaux(ct, shape=list(v)), dominant_weight)
    if l == "E" and ct._n in (6, 7):
        top = 1 if ct._n == 6 else 7
        if ct._n == 6 and c[6] and all(c[i] == 0 for i in I if i != 6):
            top = 6
        if all(c[i] == 0 for i in I if i != top):
            L = Letters(ct, dual=(top == 6))
            T = TensorProductOfCrystals([L] * c[top], generators=[[L.module_generators[0]] * c[top]])
            T._repr = "Finite dimensional highest weight crystal of type %r and highest weight %r" % (ct, dominant_weight)
            return T
    raise NotImplementedError("highest weight crystals of type %r and weight %r" % (ct, dominant_weight))


def _HW(B, la):
    B._repr = "Finite dimensional highest weight crystal of type %r and highest weight %r" % (B._ct, la)
    return B


# --------------------------------------------- Kirillov-Reshetikhin (type A)

class _KRElement(CrystalElement):
    __slots__ = ("_P", "_b")

    def __init__(self, P, b):
        self._P, self._b = P, b

    def _key(self):
        return self._b._key()

    def __repr__(self):
        return repr(self._b)

    def lift(self):
        """The element of the classical crystal."""
        return self._b

    def _e(self, i):
        if i == 0:
            K = self._P
            c = K._pr(self._b).e(1)
            return None if c is None else _KRElement(K, K._pr_inv(c))
        c = self._b.e(i)
        return None if c is None else _KRElement(self._P, c)

    def _f(self, i):
        if i == 0:
            K = self._P
            c = K._pr(self._b).f(1)
            return None if c is None else _KRElement(K, K._pr_inv(c))
        c = self._b.f(i)
        return None if c is None else _KRElement(self._P, c)

    def epsilon(self, i):
        if i == 0:
            return self._P._pr(self._b).epsilon(1)
        return self._b.epsilon(i)

    def phi(self, i):
        if i == 0:
            return self._P._pr(self._b).phi(1)
        return self._b.phi(i)

    def weight(self):
        K = self._P
        WL = K._WL
        n = K._ct._n
        v = [self.phi(i) - self.epsilon(i) for i in range(0, n + 1)]
        return _lie.AffineWeight(WL, [_F(int(x)) for x in v] + [_F(0)])

    def _wt(self):
        return self._b._wt()

    def Phi(self):
        L = self._P._WL.fundamental_weights()
        return sum((self.phi(i) * L[i] for i in self._P.index_set()), self._P._WL.zero())

    def Epsilon(self):
        L = self._P._WL.fundamental_weights()
        return sum((self.epsilon(i) * L[i] for i in self._P.index_set()), self._P._WL.zero())


class KirillovReshetikhinTypeA(Crystal):
    """The Kirillov-Reshetikhin crystal B^{r,s} of type A_n^(1): rectangular
    tableaux, with e_0, f_0 by promotion.

    EXAMPLES::

        sage: K = crystals.KirillovReshetikhin(["A",3,1], 2, 1); K
        Kirillov-Reshetikhin crystal of type ['A', 3, 1] with (r,s)=(2,1)
        sage: [b.f(0) for b in K]
        [None, None, None, None, [[1], [2]], [[1], [3]]]
    """

    def __init__(self, ct, r, s):
        self._ct, self._r, self._s = ct, r, s
        n = ct._n
        self._classical = Tableaux(CartanType("A%d" % n), shape=[s] * r)
        self._space = self._classical._space
        self._WL = _lie.WeightLattice(RootSystem_(ct), True)
        self._repr = "Kirillov-Reshetikhin crystal of type %r with (r,s)=(%d,%d)" % (ct, r, s)
        self.module_generators = (_KRElement(self, self._classical.module_generators[0]),)

    def index_set(self):
        """The index set 0, ..., n.

        EXAMPLES::

            sage: K = crystals.KirillovReshetikhin(["A",3,1], 2, 1); K.index_set()
            (0, 1, 2, 3)
        """
        return tuple(range(0, self._ct._n + 1))

    def _children(self, b):
        # the classical crystal order
        return []

    def _elements(self):
        if getattr(self, "_cache", None) is None:
            self._cache = [_KRElement(self, b) for b in self._classical]
            self._pos = {b: k for k, b in enumerate(self._cache)}
        return self._cache

    def classical_decomposition(self):
        """The classical crystal.

        EXAMPLES::

            sage: crystals.KirillovReshetikhin(['A',3,1], 2, 1).classical_decomposition()
            The crystal of tableaux of type ['A', 3] and shape(s) [[1, 1]]
        """
        return self._classical

    def module_generator(self):
        """The classical highest weight element.

        EXAMPLES::

            sage: K = crystals.KirillovReshetikhin(["A",3,1], 2, 1); K.module_generator()
            [[1], [2]]
        """
        return self.module_generators[0]

    def weight_lattice_realization(self):
        """The extended weight lattice.

        EXAMPLES::

            sage: K = crystals.KirillovReshetikhin(["A",3,1], 2, 1); K.weight_lattice_realization()
            Extended weight lattice of the Root system of type ['A', 3, 1]
        """
        return self._WL

    def _Lambda(self):
        return self._WL.fundamental_weights()

    def __call__(self, *args, **kwds):
        """The element with the given rows.

        EXAMPLES::

            sage: K = crystals.KirillovReshetikhin(["A",3,1], 2, 1); K(rows=[[1],[3]])
            [[1], [3]]
        """
        return _KRElement(self, self._classical(*args, **kwds))

    def retract(self, b):
        """The element of K with the given classical element.

        EXAMPLES::

            sage: K = crystals.KirillovReshetikhin(["A",3,1], 2, 1); b = crystals.Tableaux(['A',3], shape=[1,1])(rows=[[1],[3]]); K.retract(b)
            [[1], [3]]
        """
        return _KRElement(self, b)

    def _pr(self, b):
        return _promotion(self._classical, b, True)

    def _pr_inv(self, b):
        return _promotion(self._classical, b, False)

    def promotion(self):
        """Promotion (on the classical crystal).

        EXAMPLES::

            sage: K = crystals.KirillovReshetikhin(['A',3,1], 2, 1); b = K.module_generator()
            sage: K.promotion()(b.lift())
            [[2], [3]]
        """
        return lambda b: _promotion(self._classical, b, True)

    def promotion_inverse(self):
        """Inverse promotion (on the classical crystal).

        EXAMPLES::

            sage: K = crystals.KirillovReshetikhin(["A",3,1], 2, 1); b = K.module_generator().lift(); K.promotion_inverse()(K.promotion()(b)) == b
            True
        """
        return lambda b: _promotion(self._classical, b, False)

    def cardinality(self):
        """The number of elements.

        EXAMPLES::

            sage: K = crystals.KirillovReshetikhin(["A",3,1], 2, 1); K.cardinality()
            6
        """
        return self._classical.cardinality()


def _promotion(C, b, forward):
    """Schuetzenberger promotion on rectangular tableaux with entries 1..n+1:
    remove the largest letters, slide, add one, fill with 1 (forward); or
    the inverse."""
    n1 = C._ct._n + 1
    rows = [list(r) for r in b._rows()]
    R, S = len(rows), len(rows[0])
    if forward:
        cells = [[x for x in r] for r in rows]
        # remove n+1 (they sit at the ends of rows); slide the rest to the bottom right
        T = [[(x if x != n1 else None) for x in r] for r in cells]
        T = _slide_to_corner(T, True)
        rows = [[(1 if x is None else x + 1) for x in r] for r in T]
    else:
        T = [[(x if x != 1 else None) for x in r] for r in rows]
        T = _slide_to_corner(T, False)
        rows = [[(n1 if x is None else x - 1) for x in r] for r in T]
    return C(rows=rows)


def _slide_to_corner(T, down):
    """Jeu de taquin: move the holes (None) of a rectangle to the top left
    (down=True: entries slide down/right) or to the bottom right."""
    R, S = len(T), len(T[0])
    T = [r[:] for r in T]
    if down:
        while True:
            # the hole furthest down-right that has a non-hole after it
            holes = [(i, j) for i in range(R) for j in range(S) if T[i][j] is None]
            moved = False
            for (i, j) in sorted(holes, reverse=True):
                cand = []
                if i > 0 and T[i - 1][j] is not None:
                    cand.append((T[i - 1][j], i - 1, j))
                if j > 0 and T[i][j - 1] is not None:
                    cand.append((T[i][j - 1], i, j - 1))
                if cand:
                    # slide the larger neighbour into the hole (ties: from above)
                    m = max(c[0] for c in cand)
                    c = [c for c in cand if c[0] == m][0]
                    T[i][j], T[c[1]][c[2]] = c[0], None
                    moved = True
                    break
            if not moved:
                return T
    else:
        while True:
            holes = [(i, j) for i in range(R) for j in range(S) if T[i][j] is None]
            moved = False
            for (i, j) in sorted(holes):
                cand = []
                if i + 1 < R and T[i + 1][j] is not None:
                    cand.append((T[i + 1][j], i + 1, j))
                if j + 1 < S and T[i][j + 1] is not None:
                    cand.append((T[i][j + 1], i, j + 1))
                if cand:
                    m = min(c[0] for c in cand)
                    c = [c for c in cand if c[0] == m][0]
                    T[i][j], T[c[1]][c[2]] = c[0], None
                    moved = True
                    break
            if not moved:
                return T


def _kr_shapes(ct, r, s):
    """(classical type, shapes) of the classical decomposition of B^{r,s}."""
    l, n = ct._letter, ct._n
    import itertools
    def boxes(r, s, step, horizontal):
        # Sage's order: by the reversed vector of row (or column) lengths
        out = []
        if horizontal:
            for rows in itertools.product(range(s, -1, -step), repeat=r):
                if list(rows) == sorted(rows, reverse=True):
                    out.append((tuple(reversed(rows)), [x for x in rows if x]))
        else:
            for cols in itertools.product(range(r, -1, -step), repeat=s):
                if list(cols) == sorted(cols, reverse=True):
                    lam = [sum(1 for c in cols if c > i) for i in range(r)]
                    out.append((tuple(reversed(cols)), [x for x in lam if x]))
        return [lam for _, lam in sorted(out)]
    spin = lambda k, sign: [[_F(k, 2)] * (n - 1) + [_F(sign * k, 2)]]
    if ct._letter == "BC" and not ct._dual:
        return CartanType("C%d" % n), boxes(r, s, 1, True)
    if ct._letter == "BC" and ct._dual:
        return CartanType("B%d" % n), boxes(r, s, 2, True)
    if ct._dual:
        # twisted types: A_{2n-1}^(2) (B~*), D_{n+1}^(2) (C~*), E_6^(2) (F~*)
        if l == "B":
            return CartanType("C%d" % n), boxes(r, s, 2, False)
        if l == "C":
            cl = CartanType("B%d" % n)
            if r == n:
                return cl, spin(s, 1)
            return cl, boxes(r, s, 1, True)
        raise NotImplementedError("Kirillov-Reshetikhin crystals of type %r" % (ct,))
    cl = CartanType("%s%d" % (l, n))
    if l == "D":
        if r == n:
            return cl, spin(s, 1)
        if r == n - 1:
            return cl, spin(s, -1)
        return cl, boxes(r, s, 2, False)
    if l == "B":
        if r == n:
            return cl, [[_F(s, 2)] * n]
        return cl, boxes(r, s, 2, False)
    if l == "C":
        if r == n:
            return cl, [[s] * n]
        return cl, boxes(r, s, 2, True)
    raise NotImplementedError("Kirillov-Reshetikhin crystals of type %r" % (ct,))


class KirillovReshetikhinGeneric(Crystal):
    """A Kirillov-Reshetikhin crystal B^{r,s} (its classical crystal; the
    0-arrows are not available).

    EXAMPLES::

        sage: K = crystals.KirillovReshetikhin(["D",4,1], 2, 1); K
        Kirillov-Reshetikhin crystal of type ['D', 4, 1] with (r,s)=(2,1)
        sage: K.cardinality()
        29
    """

    def __init__(self, ct, r, s):
        self._ct, self._r, self._s = ct, r, s
        self._repr = "Kirillov-Reshetikhin crystal of type %r with (r,s)=(%d,%d)" % (ct, r, s)
        self._WL = _lie.WeightLattice(RootSystem_(ct), True)
        if ct._letter == "E":
            la = _lie.WeightLattice(RootSystem_(CartanType("E%d" % ct._n)), False).fundamental_weights()
            if (ct._n, r) in ((6, 1), (6, 6), (7, 7)):
                self._classical = HighestWeight(la[r])
                self._dec = "Direct sum of the crystals Family (%r,)" % (self._classical,)
            elif (ct._n, r) == (6, 2):
                z = _lie.WeightLattice(RootSystem_(CartanType("E6")), False).zero()
                self._classical = None
                self._dec = "Direct sum of the crystals Family (Finite dimensional highest weight crystal of type ['E', 6] and highest weight 0,\nFinite dimensional highest weight crystal of type ['E', 6] and highest weight Lambda[2])"
            else:
                raise NotImplementedError("Kirillov-Reshetikhin crystals of type %r" % (ct,))
        else:
            cl, shapes = _kr_shapes(ct, r, s)
            self._classical = Tableaux(cl, shapes=shapes)
            self._dec = None
        self._space = self._classical._space if self._classical is not None else None
        if self._classical is not None:
            gens = self._classical.module_generators
            self.module_generators = (_KRElement(self, gens[-1]),)

    def index_set(self):
        """The (affine) index set.

        EXAMPLES::

            sage: K = crystals.KirillovReshetikhin(["D",4,1], 2, 1); K.index_set()
            (0, 1, 2, 3, 4)
        """
        return tuple(self._ct.index_set())

    def classical_decomposition(self):
        """The classical decomposition.

        EXAMPLES::

            sage: crystals.KirillovReshetikhin(['C',3,1], 2, 4).classical_decomposition()
            The crystal of tableaux of type ['C', 3] and shape(s) [[], [2], [4], [2, 2], [4, 2], [4, 4]]
            sage: crystals.KirillovReshetikhin(['D',4,1], 3, 1).classical_decomposition()
            The crystal of tableaux of type ['D', 4] and shape(s) [[1/2, 1/2, 1/2, -1/2]]
        """
        if self._dec is not None:
            return _Named(self._dec)
        return self._classical

    def _elements(self):
        if getattr(self, "_cache", None) is None:
            self._cache = [_KRElement(self, b) for b in self._classical]
            self._pos = {b: k for k, b in enumerate(self._cache)}
        return self._cache

    def module_generator(self):
        """The highest weight element of the largest component.

        EXAMPLES::

            sage: K = crystals.KirillovReshetikhin(["D",4,1], 2, 1); K.module_generator()
            [[1], [2]]
        """
        return self.module_generators[0]

    def weight_lattice_realization(self):
        """The extended weight lattice.

        EXAMPLES::

            sage: K = crystals.KirillovReshetikhin(["D",4,1], 2, 1); K.weight_lattice_realization()
            Extended weight lattice of the Root system of type ['D', 4, 1]
        """
        return self._WL

    def _Lambda(self):
        return self._WL.fundamental_weights()

    def __call__(self, *args, **kwds):
        """An element of the classical crystal.

        EXAMPLES::

            sage: K = crystals.KirillovReshetikhin(["D",4,1], 2, 1); K(rows=[[2],[-2]])
            [[2], [-2]]
        """
        return _KRElement(self, self._classical(*args, **kwds))

    def retract(self, b):
        """The element of K with the given classical element.

        EXAMPLES::

            sage: K = crystals.KirillovReshetikhin(["D",4,1], 2, 1); b = K.classical_decomposition()[0]; K.retract(b)
            []
        """
        return _KRElement(self, b)

    def _pr(self, b):
        raise NotImplementedError("the 0-arrows of Kirillov-Reshetikhin crystals of type %r are not available in sagebrush yet" % (self._ct,))

    _pr_inv = _pr

    def ambient_crystal(self):
        """The ambient crystal (for C_n^(1), A_2n^(2) and D_n+1^(2)).

        EXAMPLES::

            sage: crystals.KirillovReshetikhin(['C',3,1], 1, 2).ambient_crystal()
            Kirillov-Reshetikhin crystal of type ['B', 4, 1]^* with (r,s)=(1,2)
        """
        ct, n = self._ct, self._ct._n
        if ct._letter == "C" and not ct._dual:
            return KirillovReshetikhinGeneric(CartanType(["A", 2 * n + 1, 2]), self._r, self._s)
        return KirillovReshetikhinGeneric(CartanType("C%d~" % n), self._r, 2 * self._s)


def KirillovReshetikhin(ct, r, s, model=None):
    """The Kirillov-Reshetikhin crystal B^{r,s} (type A_n^(1)).

    EXAMPLES::

        sage: K = crystals.KirillovReshetikhin(['A',3,1], 1, 1); K.list()
        [[[1]], [[2]], [[3]], [[4]]]
        sage: K = crystals.KirillovReshetikhin(['A',3,1], 2, 1); b = K.module_generator(); b
        [[1], [2]]
        sage: b.e(0), b.f(0), b.weight()
        ([[2], [4]], None, -Lambda[0] + Lambda[2])
    """
    ct = CartanType(ct)
    if ct._letter == "A" and ct._affine and not ct._dual:
        return KirillovReshetikhinTypeA(ct, int(r), int(s))
    return KirillovReshetikhinGeneric(ct, int(r), int(s))




# ------------------------------------------------------ elementary crystals

_INF = float("inf")


def _weight_parts(la):
    """(realization, coordinate tuple, pairing function i -> <la, h_i>)."""
    if isinstance(la, _lie.AmbientVector):
        D = la._P._data
        return la._P, la._v, (lambda i: _dot(la._v, D.coroots[list(D.I).index(i)]))
    P = la._P
    I = list(P._I)
    return P, la._v, (lambda i: la._v[I.index(i)])


class _ElementaryElement(CrystalElement):
    __slots__ = ("_P", "_v")

    def __init__(self, P, v):
        self._P, self._v = P, v

    def _key(self):
        return ("elementary", self._P._kind, self._v)

    def __repr__(self):
        k = self._P._kind
        if k == "C":
            return "c"
        if k == "B":
            return str(self._v)
        return repr(self._P._la)

    def __lt__(self, other):
        return self._v < other._v

    def _e(self, i):
        P = self._P
        if P._kind == "B" and i == P._i:
            return _ElementaryElement(P, self._v + 1)
        return None

    def _f(self, i):
        P = self._P
        if P._kind == "B" and i == P._i:
            return _ElementaryElement(P, self._v - 1)
        return None

    def epsilon(self, i):
        """epsilon_i.

        EXAMPLES::

            sage: B = crystals.elementary.Elementary("A2", 1); B(2).epsilon(1), B(2).epsilon(2)
            (-2, -inf)
        """
        P = self._P
        if P._kind == "T":
            return -_INF
        if P._kind == "R":
            return _sa().Integer(-int(P._pair(i)))
        if P._kind == "C":
            return _sa().Integer(0)
        return _sa().Integer(-self._v) if i == P._i else -_INF

    def phi(self, i):
        """phi_i.

        EXAMPLES::

            sage: B = crystals.elementary.Elementary("A2", 1); B(2).phi(1), B(2).phi(2)
            (2, -inf)
        """
        P = self._P
        if P._kind == "T":
            return -_INF
        if P._kind == "R":
            return _sa().Integer(0)
        if P._kind == "C":
            return _sa().Integer(0)
        return _sa().Integer(self._v) if i == P._i else -_INF

    def _hi(self, i):
        P = self._P
        if P._kind in "TR":
            return P._pair(i)
        if P._kind == "C":
            return 0
        A = _lie._cartan(P._ct)
        return self._v * A[i][P._i]

    def _wt(self):
        P = self._P
        if P._kind in "TR":
            return P._lav
        if P._kind == "C":
            return tuple(_F(0) for x in P._zero)
        A = _lie._cartan(P._ct)
        I = list(P._ct.index_set())
        return tuple(self._v * A[j][P._i] for j in I) + (_F(0),)

    def weight(self):
        """The weight.

        EXAMPLES::

            sage: B = crystals.elementary.Elementary("A2", 1); B(2).weight()
            2*alpha[1]
        """
        P = self._P
        if P._kind in "TR":
            return P._la
        if P._kind == "C":
            return P._space.zero()
        return _Named(_lie._lincomb([(_F(self._v), "alpha[%s]" % P._i)]) or "0")


class _Named:
    def __init__(self, s):
        self._s = s

    def __repr__(self):
        return self._s


class ElementaryCrystal(Crystal):
    """The elementary crystals T_lambda, R_lambda, B_i and the component
    crystal C.

    EXAMPLES::

        sage: crystals.elementary.Component(RootSystem("A2").weight_lattice())
        The component crystal of type ['A', 2]
    """

    def __init__(self, kind, ct, la=None, i=None):
        self._kind, self._ct, self._la, self._i = kind, ct, la, i
        if la is not None:
            self._space, self._lav, self._pair = _weight_parts(la)
            self._zero = self._lav
        else:
            self._space = _lie.WeightLattice(RootSystem_(ct), False)
            self._zero = (0,)
        if kind == "T":
            self._repr = "The T crystal of type %r and weight %r" % (ct, la)
        elif kind == "R":
            self._repr = "The R crystal of weight %r and type %r" % (la, ct)
        elif kind == "C":
            self._repr = "The component crystal of type %r" % (ct,)
        else:
            self._repr = "The %s-elementary crystal of type %r" % (i, ct)
        self.module_generators = (_ElementaryElement(self, 0 if kind == "B" else None),)

    def _elements(self):
        if self._kind == "B":
            raise NotImplementedError("the elementary crystal B_i is infinite")
        return list(self.module_generators)

    def __call__(self, m=None):
        """The element (b_i(m) for B_i).

        EXAMPLES::

            sage: B = crystals.elementary.Elementary("A2", 2); B(3), B(3).f(2)
            (3, 2)
        """
        if self._kind == "B":
            return _ElementaryElement(self, int(m))
        return self.module_generators[0]

    def cardinality(self):
        """The number of elements.

        EXAMPLES::

            sage: crystals.elementary.Elementary("A2", 2).cardinality(), crystals.elementary.Component(RootSystem("A2").weight_lattice()).cardinality()
            (+Infinity, 1)
        """
        if self._kind == "B":
            return _sa().oo
        return _sa().Integer(1)


def _ct_of(ct_or_P):
    if isinstance(ct_or_P, (_lie.WeightLattice,)):
        return ct_or_P._ct
    if isinstance(ct_or_P, _lie.AmbientSpace):
        return ct_or_P._ct
    return CartanType(ct_or_P)


class _Elementary:
    """crystals.elementary: T, R, Elementary (B_i), Component."""

    def T(self, ct, la):
        """The crystal T_lambda (a single element of weight lambda).

        EXAMPLES::

            sage: P = RootSystem("C2").weight_lattice(); La = P.fundamental_weights()
            sage: T = crystals.elementary.T("C2", 2*La[1]); T, T[0].epsilon(1)
            (The T crystal of type ['C', 2] and weight 2*Lambda[1], -inf)
        """
        return ElementaryCrystal("T", _ct_of(ct), la)

    def R(self, ct, la):
        """The crystal R_lambda.

        EXAMPLES::

            sage: La = RootSystem(['B',4]).weight_lattice().fundamental_weights()
            sage: R = crystals.elementary.R(['B',4], -La[2]); R, R[0].epsilon(2)
            (The R crystal of weight -Lambda[2] and type ['B', 4], 1)
        """
        return ElementaryCrystal("R", _ct_of(ct), la)

    def Component(self, P):
        """The component crystal C (one element, epsilon = phi = 0).

        EXAMPLES::

            sage: C = crystals.elementary.Component(RootSystem("C2").weight_lattice()); C, C.list()
            (The component crystal of type ['C', 2], [c])
        """
        ct = _ct_of(P)
        if not isinstance(P, _lie.WeightLattice):
            P = _lie.WeightLattice(RootSystem_(ct), False)
        C = ElementaryCrystal("C", ct, None)
        C._space = P
        C._zero = P.zero()._v
        return C

    def Elementary(self, ct, i):
        """The i-elementary crystal B_i (elements b_i(m), m an integer).

        EXAMPLES::

            sage: B = crystals.elementary.Elementary("A2", 1); B
            The 1-elementary crystal of type ['A', 2]
            sage: S = B.subcrystal(max_depth=4, generators=[B(0)]); sorted(s for s in S)
            [-4, -3, -2, -1, 0, 1, 2, 3, 4]
            sage: B(3).weight(), B(0).phi(2)
            (3*alpha[1], -inf)
        """
        return ElementaryCrystal("B", _ct_of(ct), None, i)

    def __repr__(self):
        return "The catalog of elementary crystals"


# ------------------------------------------------------ Nakajima monomials

class _MonomialElement(CrystalElement):
    """A (modified) Nakajima monomial: the highest weight monomial times a
    product of A_{i,k}^{-1} (their multiplicities are kept)."""

    __slots__ = ("_P", "_c", "_y")

    def __init__(self, P, c):
        self._P, self._c = P, {k: v for k, v in c.items() if v}
        y = dict(P._y0)
        for (i, k), m in self._c.items():
            for key, e in P._Avec(i, k):
                y[key] = y.get(key, 0) - m * e
        self._y = {k: v for k, v in y.items() if v}

    def _key(self):
        return tuple(sorted(self._y.items()))

    def __repr__(self):
        P = self._P
        if P._vars == "A":
            if not self._c:
                return "1"
            return " ".join("A(%s,%s)^-%s" % (i, k, m) if m != 1 else "A(%s,%s)^-1" % (i, k) for (i, k), m in sorted(self._c.items()))
        if not self._y:
            return "1"
        out = []
        for (i, k), e in sorted(self._y.items()):
            out.append("Y(%s,%s)" % (i, k) + ("" if e == 1 else "^%s" % e))
        return " ".join(out)

    def _intervals(self, i):
        """[(k_start, k_end or None, prefix sum)] over the allowed range of k."""
        ks = sorted(k for (j, k) in self._y if j == i)
        out = []
        lo = 0 if self._P._inf else None
        s = 0
        start = lo
        for k in ks:
            if start is None or k > start:
                out.append((start, k - 1, s))
            s += self._y[(i, k)]
            start = k
        out.append((start, None, s))
        if self._P._inf and (not ks or ks[0] > 0):
            pass
        return out

    def phi(self, i):
        """phi_i.

        EXAMPLES::

            sage: La = RootSystem(["B",4]).weight_lattice().fundamental_weights(); M = crystals.NakajimaMonomials(["B",4], La[1]); M.list()[0].phi(1)
            1
        """
        return _sa().Integer(max(v for _, _, v in self._intervals(i)))

    def _total(self, i):
        return sum(e for (j, k), e in self._y.items() if j == i)

    def epsilon(self, i):
        """epsilon_i.

        EXAMPLES::

            sage: La = RootSystem(["B",4]).weight_lattice().fundamental_weights(); M = crystals.NakajimaMonomials(["B",4], La[1]); M.list()[1].epsilon(1)
            1
        """
        return _sa().Integer(int(self.phi(i)) - self._total(i))

    def _shift(self, i, k, d):
        c = dict(self._c)
        c[(i, k)] = c.get((i, k), 0) + d
        if c[(i, k)] < 0:
            return None
        return _MonomialElement(self._P, c)

    def _f(self, i):
        iv = self._intervals(i)
        ph = max(v for _, _, v in iv)
        if ph == 0 and not self._P._inf:
            return None
        for a, b, v in iv:
            if v == ph:
                return self._shift(i, a if a is not None else b, 1)
        return None

    def _e(self, i):
        if int(self.epsilon(i)) == 0:
            return None
        iv = self._intervals(i)
        ph = max(v for _, _, v in iv)
        k = None
        for a, b, v in iv:
            if v == ph:
                k = b
        return self._shift(i, k, -1)

    def _counts(self):
        n = {}
        for (i, k), m in self._c.items():
            n[i] = n.get(i, 0) + m
        return n

    def _wt(self):
        return self.weight()._v

    def weight(self):
        """The weight.

        EXAMPLES::

            sage: La = RootSystem(["B",4]).weight_lattice().fundamental_weights(); M = crystals.NakajimaMonomials(["B",4], La[1]); M.list()[1].weight()
            -Lambda[1] + Lambda[2]
        """
        P = self._P
        w = P._la
        al = P._space.simple_roots()
        for i, m in self._counts().items():
            w = w - m * al[i]
        return w

    def weight_in_root_lattice(self):
        """The weight minus the highest weight, in the root lattice.

        EXAMPLES::

            sage: Minf = crystals.infinity.NakajimaMonomials(['C',3,1])
            sage: Minf.highest_weight_vector().f_string([0,1,2,3,2,1,0]).weight_in_root_lattice()
            -2*alpha[0] - 2*alpha[1] - 2*alpha[2] - alpha[3]
        """
        n = self._counts()
        return _Named(_lie._lincomb([(_F(-n[i]), "alpha[%s]" % i) for i in self._P._I if n.get(i)]) or "0")


class NakajimaMonomials(Crystal):
    """The crystal of modified Nakajima monomials: B(lambda), or B(infinity)
    (lambda = None).

    EXAMPLES::

        sage: La = RootSystem(['A',2]).weight_lattice().fundamental_weights(); M = crystals.NakajimaMonomials(['A',2], La[1]); M
        Highest weight crystal of modified Nakajima monomials of Cartan type ['A', 2] and highest weight Lambda[1]
        sage: M.list()
        [Y(1,0), Y(1,1)^-1 Y(2,0), Y(2,1)^-1]
    """

    def __init__(self, ct, la, c=None, inf=False):
        self._ct = ct
        self._I = list(ct.index_set())
        self._A = _lie._cartan(ct)
        self._inf = inf
        self._vars = "Y"
        n = len(self._I)
        if c is None:
            self._cm = [[1 if a < b else 0 for b in range(n)] for a in range(n)]
        else:
            self._cm = [[int(c[a, b]) for b in range(n)] for a in range(n)]
        if inf:
            self._space = _lie.WeightLattice(RootSystem_(ct), not ct.is_finite() and getattr(ct, "_mat", None) is None)
            self._la = self._space.zero()
            self._repr = "Infinity Crystal of modified Nakajima monomials of type %r" % (ct,)
        else:
            self._space = la._P
            self._la = la
            self._repr = "Highest weight crystal of modified Nakajima monomials of Cartan type %r and highest weight %r" % (ct, la)
        y = {}
        if not inf:
            for k, i in enumerate(self._I):
                if la._v[k]:
                    y[(i, 0)] = int(la._v[k])
        self._y0 = y
        self.module_generators = (_MonomialElement(self, {}),)

    def _Avec(self, i, k):
        """The exponents of A_{i,k}."""
        a = self._I.index(i)
        out = [((i, k), 1), ((i, k + 1), 1)]
        for b, j in enumerate(self._I):
            if j != i and self._A[j][i]:
                out.append(((j, k + self._cm[b][a]), int(self._A[j][i])))
        return out

    def _realize(self, v):
        return _lie.AffineWeight(self._space, v)

    def _Lambda(self):
        return self._space.fundamental_weights()

    def c(self):
        """The matrix (c_ij) used in A_{i,k}.

        EXAMPLES::

            sage: La = RootSystem(['C',3]).weight_lattice().fundamental_weights()
            sage: crystals.NakajimaMonomials(['C',3], 2*La[1]).c()
            [0 1 1]
            [0 0 1]
            [0 0 0]
        """
        return _sa().matrix(_sa().ZZ, self._cm)

    def set_variables(self, v):
        """Print monomials in the Y (default) or A variables.

        EXAMPLES::

            sage: Minf = crystals.infinity.NakajimaMonomials(['A',2]); m = Minf.highest_weight_vector().f(1)
            sage: Minf.set_variables('A'); m
            A(1,0)^-1
            sage: Minf.set_variables('Y'); m
            Y(1,0)^-1 Y(1,1)^-1 Y(2,0)
        """
        self._vars = v

    def _elements(self):
        if self._inf or not self._ct.is_finite():
            raise NotImplementedError("the crystal is infinite")
        return Crystal._elements(self)


def _nakajima(ct, la=None, c=None):
    """crystals.NakajimaMonomials(cartan_type, la): B(la) by monomials.

    EXAMPLES::

        sage: La = RootSystem(['B',4]).weight_lattice().fundamental_weights()
        sage: M = crystals.NakajimaMonomials(['B',4], La[1]+La[2]); M.list()[:3], M.cardinality()
        ([Y(1,0) Y(2,0), Y(1,1)^-1 Y(2,0)^2, Y(2,0) Y(2,1)^-1 Y(3,0)], 231)
        sage: c = Matrix([[0,0,1],[1,0,0],[0,1,0]]); La = RootSystem(['C',3]).weight_lattice().fundamental_weights()
        sage: M = crystals.NakajimaMonomials(2*La[1], c=c); M.list()[:3]
        [Y(1,0)^2, Y(1,0) Y(1,1)^-1 Y(2,1), Y(1,1)^-2 Y(2,1)^2]
    """
    if la is None and isinstance(ct, _lie.AffineWeight):
        ct, la = ct._P._ct, ct
    return NakajimaMonomials(CartanType(ct), la, c)


# ------------------------------------------------ B(infinity): tableaux (type A)

class _InfTableauElement(CrystalElement):
    """A marginally large tableau (an element of B(infinity) of type A_n)."""

    __slots__ = ("_P", "_rows")

    def __init__(self, P, rows):
        self._P, self._rows = P, tuple(tuple(r) for r in rows)

    def _key(self):
        return self._rows

    def __repr__(self):
        return repr([list(r) for r in self._rows])

    def pp(self):
        """Print the tableau.

        EXAMPLES::

            sage: B = crystals.infinity.Tableaux(['A',2]); B.highest_weight_vector().f(2).pp()
              1  1  1
              2  3
        """
        print("\n".join("".join("%3s" % x for x in r) for r in self._rows if r))

    def to_tableau(self):
        """The tableau.

        EXAMPLES::

            sage: B = crystals.infinity.Tableaux(['A',2]); B.highest_weight_vector().f(2).to_tableau()
            [[1, 1, 1], [2, 3]]
        """
        return Tableau([list(r) for r in self._rows if r])

    def _word(self):
        L = self._P._letters
        rows = [r for r in self._rows]
        w = []
        for j in range(len(rows[0]) if rows else 0):
            col = [rows[r][j] for r in range(len(rows)) if j < len(rows[r])]
            w += [L(x) for x in reversed(col)]
        return w

    def _from_word(self, w):
        shape = [len(r) for r in self._rows]
        cols = _col_lengths(shape)
        rows = [[] for _ in shape]
        k = 0
        for c in cols:
            col = [w[k + t]._v for t in range(c)]
            k += c
            for r, x in enumerate(reversed(col)):
                rows[r].append(x)
        return self._P._normalize(rows)

    def _op(self, i, lower):
        w = self._word()
        f, e, _, _ = _signature(w, i)
        j = f if lower else e
        if j is None:
            if lower:
                # act on a new trivial column (1, ..., i) added first
                rows = [[r + 1] + list(row) if r < i else list(row) for r, row in enumerate(self._rows)]
                el = _InfTableauElement(self._P, rows)
                return el._op(i, True)
            return None
        w[j] = w[j].f(i) if lower else w[j].e(i)
        return self._from_word(w)

    def _f(self, i):
        return self._op(i, True)

    def _e(self, i):
        if int(self.epsilon(i)) == 0:
            return None
        return self._op(i, False)

    def epsilon(self, i):
        """epsilon_i.

        EXAMPLES::

            sage: B = crystals.infinity.Tableaux(['A',2]); b = B.highest_weight_vector().f(1); b.epsilon(1), b.phi(1)
            (1, -1)
        """
        return _sa().Integer(_signature(self._word(), i)[2])

    def phi(self, i):
        """phi_i = epsilon_i + <wt, h_i>.

        EXAMPLES::

            sage: B = crystals.infinity.Tableaux(['A',2]); b = B.highest_weight_vector(); b.phi(1), b.f(1).phi(1)
            (0, -1)
        """
        w = self._wt()
        return self.epsilon(i) + _sa().Integer(int(w[i - 1] - w[i]))

    def _wt(self):
        d = self._P._ct._n + 1
        v = [_F(0)] * d
        for r, row in enumerate(self._rows):
            v[r] -= len(row)
            for x in row:
                v[x - 1] += 1
        return tuple(v)


class InfinityCrystalOfTableaux(Crystal):
    """B(infinity) of type A_n by marginally large tableaux.

    EXAMPLES::

        sage: B = crystals.infinity.Tableaux(['A',2]); B
        The infinity crystal of tableaux of type ['A', 2]
        sage: B.highest_weight_vector().f_string([1, 2])
        [[1, 1, 3], [2]]
    """

    def __init__(self, ct):
        if ct._letter != "A" or not ct.is_finite():
            raise NotImplementedError("infinity crystals of tableaux of type %r are not available in sagebrush yet" % (ct,))
        self._ct = ct
        self._space = RootSystem_(ct).ambient_space()
        self._letters = CrystalOfLetters(ct)
        self._repr = "The infinity crystal of tableaux of type %r" % (ct,)
        n = ct._n
        self.module_generators = (self._normalize([[] for _ in range(n)]),)

    def _normalize(self, rows):
        """Add or remove trivial columns (1, ..., r) so that row r has exactly
        one more r than row r+1 has boxes."""
        n = self._ct._n
        rows = [list(r) for r in rows] + [[] for _ in range(n - len(rows))]
        for r in range(n - 1, -1, -1):
            need = (len(rows[r + 1]) if r + 1 < n else 0) + 1
            have = sum(1 for x in rows[r] if x == r + 1)
            while have < need:
                for s in range(r + 1):
                    rows[s].insert(0, s + 1)
                have += 1
            while have > need:
                for s in range(r + 1):
                    rows[s].pop(0)
                have -= 1
        return _InfTableauElement(self, rows)

    def _elements(self):
        raise NotImplementedError("the crystal is infinite")

    def cardinality(self):
        """Infinity.

        EXAMPLES::

            sage: B = crystals.infinity.Tableaux(['A',2]); B.cardinality()
            +Infinity
        """
        return _sa().oo

    def highest_weight_vector(self):
        """The highest weight element.

        EXAMPLES::

            sage: B = crystals.infinity.Tableaux(['A',2]); B.highest_weight_vector()
            [[1, 1], [2]]
        """
        return self.module_generators[0]


def crystal_morphism(source, on_gens):
    """The crystal morphism sending the highest weight elements of source as
    given (a dict), commuting with the f_i.

    EXAMPLES::

        sage: Brho = crystals.Tableaux(['A',2], shape=[2,1]); brho = Brho.highest_weight_vector()
        sage: B = crystals.infinity.Tableaux(['A',2]); T = crystals.elementary.T(['A',2], brho.weight())
        sage: TB = crystals.TensorProduct(T, B); Psi = Brho.crystal_morphism({brho: TB(T[0], B.highest_weight_vector())})
        sage: [Psi(x) for x in Brho][:3]
        [[(2, 1, 0), [[1, 1], [2]]], [(2, 1, 0), [[1, 1, 2], [2]]], [(2, 1, 0), [[1, 1, 3], [2]]]]
    """
    def Psi(x):
        hw, path = x.to_highest_weight()
        y = on_gens[hw]
        for i in reversed(path):
            if y is None:
                return None
            y = y.f(i)
        return y
    return Psi


class _Infinity:
    """crystals.infinity: Tableaux (type A), NakajimaMonomials."""

    def Tableaux(self, ct):
        """B(infinity) by marginally large tableaux (type A).

        EXAMPLES::

            sage: B = crystals.infinity.Tableaux(['A',2]); b = B.highest_weight_vector(); b
            [[1, 1], [2]]
            sage: b.f_string([1,2,2,1,2,1,2,2,2,2,2]).pp()
              1  1  1  1  1  1  1  1  1  2  2  3
              2  3  3  3  3  3  3  3
        """
        return InfinityCrystalOfTableaux(CartanType(ct))

    def NakajimaMonomials(self, ct, c=None):
        """B(infinity) by modified Nakajima monomials.

        EXAMPLES::

            sage: Minf = crystals.infinity.NakajimaMonomials(['C',3,1]); minf = Minf.highest_weight_vector()
            sage: m = minf.f_string([0,1,2,3,2,1,0]); m, m.weight()
            (Y(0,0)^-1 Y(0,4)^-1 Y(1,0) Y(1,3), -2*Lambda[0] + 2*Lambda[1] - 2*delta)
        """
        M = NakajimaMonomials(CartanType(ct), None, c, inf=True)
        M.highest_weight_vector = lambda: M.module_generators[0]
        return M

    def __repr__(self):
        return "The catalog of infinity crystals"


# ------------------------------------------------------------- LS paths

class _LSPath(CrystalElement):
    """A Lakshmibai-Seshadri (Littelmann) path: a tuple of straight segments
    (their displacement vectors, in the weight space)."""

    __slots__ = ("_P", "_s")

    def __init__(self, P, segs):
        self._P, self._s = P, _merge(segs)

    def _key(self):
        return self._s

    def __repr__(self):
        W = self._P._space
        return "(" + ", ".join(repr(_lie.AffineWeight(W, v)) for v in self._s) + ("," if len(self._s) == 1 else "") + ")"

    def value(self):
        """The segments (as weights).

        EXAMPLES::

            sage: C = crystals.LSPaths(['A',2], [1,0]); C.list()[1].value()
            (-Lambda[1] + Lambda[2],)
        """
        W = self._P._space
        return tuple(_lie.AffineWeight(W, v) for v in self._s)

    def _h(self, i):
        k = self._P._ipos[i]
        hs = [_F(0)]
        for v in self._s:
            hs.append(hs[-1] + v[k])
        return hs

    def epsilon(self, i):
        """epsilon_i: minus the minimum of <pi(t), alpha_i^vee>.

        EXAMPLES::

            sage: C = crystals.LSPaths(['A',2], [2,0]); C.list()[1].epsilon(1), C.list()[1].phi(1)
            (1, 1)
        """
        return _sa().Integer(int(-min(self._h(i))))

    def phi(self, i):
        """phi_i: the endpoint minus the minimum of <pi(t), alpha_i^vee>.

        EXAMPLES::

            sage: C = crystals.LSPaths(['A',2], [1,0]); C.list()[0].phi(1), C.list()[1].phi(2)
            (1, 1)
        """
        hs = self._h(i)
        return _sa().Integer(int(hs[-1] - min(hs)))

    def _reflect(self, i, v):
        k = self._P._ipos[i]
        a = self._P._alpha[i]
        c = v[k]
        return tuple(x - c * y for x, y in zip(v, a))

    def _f(self, i):
        hs = self._h(i)
        m = min(hs)
        if hs[-1] - m < 1:
            return None
        t0 = max(k for k, h in enumerate(hs) if h == m)
        segs = list(self._s)
        # the first crossing of m + 1 after t0
        for k in range(t0 + 1, len(hs)):
            if hs[k] >= m + 1:
                break
        p = (m + 1 - hs[k - 1]) / (hs[k] - hs[k - 1])
        v = segs[k - 1]
        first, rest = _smul(p, v), _smul(1 - p, v)
        new = segs[:t0] + [self._reflect(i, w) for w in segs[t0:k - 1]] + [self._reflect(i, first)]
        if p != 1:
            new.append(rest)
        new += segs[k:]
        return _LSPath(self._P, new)

    def _e(self, i):
        hs = self._h(i)
        m = min(hs)
        if m > -1:
            return None
        t1 = min(k for k, h in enumerate(hs) if h == m)
        segs = list(self._s)
        j = max(k for k in range(t1) if hs[k] >= m + 1)
        # crossing of m + 1 in segment j (between breakpoints j and j + 1)
        p = (hs[j] - (m + 1)) / (hs[j] - hs[j + 1])
        v = segs[j]
        first, rest = _smul(p, v), _smul(1 - p, v)
        new = segs[:j]
        if p != 0:
            new.append(first)
        new += [self._reflect(i, rest)] + [self._reflect(i, w) for w in segs[j + 1:t1]] + segs[t1:]
        return _LSPath(self._P, new)

    def _wt(self):
        d = len(self._s[0])
        w = tuple([_F(0)] * d)
        for v in self._s:
            w = _addv(w, v)
        return w

    def weight(self):
        """The endpoint.

        EXAMPLES::

            sage: C = crystals.LSPaths(['A',2], [2,0]); C.list()[1].weight()
            Lambda[2]
        """
        return _lie.AffineWeight(self._P._space, self._wt())


def _merge(segs):
    out = []
    for v in segs:
        v = tuple(_F(x) for x in v)
        if all(x == 0 for x in v):
            continue
        if out:
            u = out[-1]
            k = next(t for t, x in enumerate(u) if x != 0)
            c = v[k] / u[k]
            if c > 0 and all(b == c * a for a, b in zip(u, v)):
                out[-1] = _addv(u, v)
                continue
        out.append(v)
    return tuple(out)


class LSPaths(Crystal):
    """The crystal of Lakshmibai-Seshadri paths of a weight.

    EXAMPLES::

        sage: C = crystals.LSPaths(['A',2], [1,0]); C, C.list()
        (The crystal of LS paths of type ['A', 2] and weight Lambda[1], [(Lambda[1],), (-Lambda[1] + Lambda[2],), (-Lambda[2],)])
    """

    def __init__(self, la):
        W = la._P
        self._space = W
        self._ct = W._ct
        self._la = la
        I = list(W._I)
        self._ipos = {i: k for k, i in enumerate(I)}
        al = W.simple_roots()
        self._alpha = {i: al[i]._v for i in I}
        self._repr = "The crystal of LS paths of type %r and weight %r" % (self._ct, la)
        self.module_generators = (_LSPath(self, [la._v]),)

    def _realize(self, v):
        return _lie.AffineWeight(self._space, v)

    def _Lambda(self):
        return self._space.fundamental_weights()

    def _elements(self):
        if not self._ct.is_finite():
            raise NotImplementedError("the crystal is infinite")
        return Crystal._elements(self)


def _lspaths(starting_weight, weight=None):
    """crystals.LSPaths(weight) or crystals.LSPaths(cartan_type, [coefficients]).

    EXAMPLES::

        sage: C = crystals.LSPaths(['A',2], [1,1]); C
        The crystal of LS paths of type ['A', 2] and weight Lambda[1] + Lambda[2]
        sage: C.list()[:3]
        [(Lambda[1] + Lambda[2],), (-Lambda[1] + 2*Lambda[2],), (1/2*Lambda[1] - Lambda[2], -1/2*Lambda[1] + Lambda[2])]
        sage: R = RootSystem(['A',2,1]); La = R.weight_space(extended=True).basis()
        sage: LS = crystals.LSPaths(La[1] - La[0]); sorted(LS.subcrystal(max_depth=2, direction='both'), key=str)
        [(-Lambda[0] + Lambda[1],), (-Lambda[1] + Lambda[2] + delta,), (-Lambda[1] + Lambda[2],), (Lambda[0] - Lambda[2] + delta,), (Lambda[0] - Lambda[2],)]
    """
    if weight is not None:
        ct = CartanType(starting_weight)
        W = _lie.WeightLattice(RootSystem_(ct), False)
        W._space_name = True
        La = W.fundamental_weights()
        la = W.zero()
        for i, c in zip(ct.index_set(), weight):
            la = la + int(c) * La[i]
        return LSPaths(la)
    return LSPaths(starting_weight)


class _Crystals:
    """The catalog of crystals (crystals.Letters, crystals.Tableaux, ...)."""

    def __init__(self):
        self.Letters = Letters
        self.Tableaux = Tableaux
        self.Spins = Spins
        self.SpinsPlus = SpinsPlus
        self.SpinsMinus = SpinsMinus
        self.TensorProduct = TensorProduct
        self.HighestWeight = HighestWeight
        self.FastRankTwo = FastRankTwo
        self.KirillovReshetikhin = KirillovReshetikhin
        self.elementary = _Elementary()
        self.NakajimaMonomials = _nakajima
        self.infinity = _Infinity()
        self.LSPaths = _lspaths

    def __repr__(self):
        return "The catalog of crystals"


crystals = _Crystals()


_KRElement.__module__ = "sage.combinat.crystals.kirillov_reshetikhin"
_KRElement.__qualname__ = "KR_type_A_with_category.element_class"
_TableauElement.__module__ = "sage.combinat.crystals.tensor_product"
_TableauElement.__qualname__ = "CrystalOfTableaux_with_category.element_class"
