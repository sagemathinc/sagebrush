"""Coding theory, as in Sage: linear codes (LinearCode, Hamming, Golay,
generalized Reed-Solomon and random codes), the encoder/decoder/channel
framework (AbstractCode, AbstractLinearCode, Encoder, Decoder, Channel),
syndrome, nearest neighbor, information set, Gao, Berlekamp-Welch and
error-erasure decoding, channels, linear rank metric codes; linear feedback
shift registers and Berlekamp-Massey; classical cryptosystems."""

import itertools
import random as _random


def _sa():
    import sage_all
    return sage_all


def _vector(F, xs):
    return _sa().vector(F, list(xs))


def _matrix(F, rows):
    return _sa().matrix(F, [list(r) for r in rows])


def _field_name(F):
    return "GF(%d)" % int(F.order())


def _elements(F):
    """The elements of F in the order of their integer representation
    (0, 1, ..., and over GF(p^k) the polynomials in the generator)."""
    q = int(F.order())
    p = int(F.characteristic())
    if q == p:
        return [F(i) for i in range(p)]
    z = F.gen()
    k = 0
    while p ** k < q:
        k += 1
    out = []
    for i in range(q):
        e = F(0)
        t, pw = i, F(1)
        for _ in range(k):
            e = e + F(t % p) * pw
            t //= p
            pw = pw * z
        out.append(e)
    return out


def _messages(F, k):
    """All vectors of F^k, the first coordinate varying fastest."""
    els = _elements(F)
    for t in itertools.product(els, repeat=k):
        yield list(reversed(t))


def format_interval(t):
    """'a' or 'between a and b' for an integer or a pair.

    EXAMPLES::

        sage: from sage.coding.channel import format_interval
        sage: format_interval((2, 2)), format_interval((1, 3))
        ('2', 'between 1 and 3')
    """
    if isinstance(t, (tuple, list)):
        if t[0] == t[1]:
            return str(t[0])
        return "between %s and %s" % (t[0], t[1])
    return str(t)


# --------------------------------------------------------- the framework

class AbstractCode:
    """A code: a set of words of a given length, with registered encoders
    and decoders (subclasses define __iter__ and __contains__).

    EXAMPLES::

        sage: from sage.coding.abstract_code import AbstractCode; C = codes.HammingCode(GF(2), 3); isinstance(C, AbstractCode)
        True
    """

    _registered_encoders = {}
    _registered_decoders = {}

    def __init__(self, length, default_encoder_name=None, default_decoder_name=None, metric="Hamming"):
        self._length = int(length)
        self._default_encoder_name = default_encoder_name
        self._default_decoder_name = default_decoder_name
        self._metric = metric
        self._encoder_cache = {}
        self._decoder_cache = {}

    def __repr__(self):
        if hasattr(self, "_repr_"):
            return self._repr_()
        return "Code of length %d" % self._length

    def length(self):
        """The length.

        EXAMPLES::

            sage: codes.HammingCode(GF(2), 3).length()
            7
        """
        return _sa().Integer(self._length)

    def metric(self):
        """The metric.

        EXAMPLES::

            sage: C = codes.HammingCode(GF(2), 3); C.metric()
            'Hamming'
        """
        return self._metric

    def list(self):
        """The words (for small codes).

        EXAMPLES::

            sage: codes.HammingCode(GF(2), 3).list()[:3]
            [(0, 0, 0, 0, 0, 0, 0), (1, 0, 0, 0, 0, 1, 1), (0, 1, 0, 0, 1, 0, 1)]
        """
        return list(iter(self))

    def __len__(self):
        return len(self.list())

    @classmethod
    def add_encoder(cls, name, encoder):
        """Register an encoder class under a name.

        EXAMPLES::

            sage: C = codes.HammingCode(GF(2), 3); MyCode = type('MyCode', (type(C),), {}); MyCode.add_encoder('Sys2', type(C.encoder())); 'Sys2' in MyCode(GF(2), 3).encoders_available(), 'Sys2' in C.encoders_available()  # sagebrush only
            (True, False)
        """
        cls._registered_encoders = dict(cls._registered_encoders)
        cls._registered_encoders[name] = encoder

    @classmethod
    def add_decoder(cls, name, decoder):
        """Register a decoder class under a name.

        EXAMPLES::

            sage: C = codes.HammingCode(GF(2), 3); MyCode = type('MyCode', (type(C),), {}); MyCode.add_decoder('NN2', type(C.decoder('NearestNeighbor'))); 'NN2' in MyCode(GF(2), 3).decoders_available(), 'NN2' in C.decoders_available()  # sagebrush only
            (True, False)
        """
        cls._registered_decoders = dict(cls._registered_decoders)
        cls._registered_decoders[name] = decoder

    def encoders_available(self, classes=False):
        """The names of the registered encoders.

        EXAMPLES::

            sage: codes.GeneralizedReedSolomonCode(GF(13).list()[:8], 3).encoders_available()
            ['EvaluationPolynomial', 'EvaluationVector', 'Systematic']
        """
        if classes:
            return dict(self._registered_encoders)
        return sorted(self._registered_encoders)

    def decoders_available(self, classes=False):
        """The names of the registered decoders.

        EXAMPLES::

            sage: codes.HammingCode(GF(2), 3).decoders_available()
            ['InformationSet', 'NearestNeighbor', 'Syndrome']
        """
        if classes:
            return dict(self._registered_decoders)
        return sorted(self._registered_decoders)

    def encoder(self, encoder_name=None, *args, **kwargs):
        """The encoder of the given name (the default one if None).

        EXAMPLES::

            sage: codes.HammingCode(GF(2), 3).encoder()
            Systematic encoder for [7, 4] Hamming Code over GF(2)
        """
        name = encoder_name or self._default_encoder_name
        if name not in self._registered_encoders:
            raise ValueError("there is no Encoder named '%s'. The known Encoders are: %s" % (name, self.encoders_available()))
        key = (name, args, tuple(sorted(kwargs.items())))
        if key not in self._encoder_cache:
            self._encoder_cache[key] = self._registered_encoders[name](self, *args, **kwargs)
        return self._encoder_cache[key]

    def decoder(self, decoder_name=None, *args, **kwargs):
        """The decoder of the given name (the default one if None).

        EXAMPLES::

            sage: codes.HammingCode(GF(2), 3).decoder()
            Syndrome decoder for [7, 4] Hamming Code over GF(2) handling errors of weight up to 1
        """
        name = decoder_name or self._default_decoder_name
        if name not in self._registered_decoders:
            raise ValueError("there is no Decoder named '%s'. The known Decoders are: %s" % (name, self.decoders_available()))
        key = (name, args, tuple(sorted(kwargs.items())))
        if key not in self._decoder_cache:
            self._decoder_cache[key] = self._registered_decoders[name](self, *args, **kwargs)
        return self._decoder_cache[key]

    def encode(self, word, encoder_name=None, *args, **kwargs):
        """Encode a message.

        EXAMPLES::

            sage: C = codes.HammingCode(GF(2), 3); C.encode(vector(GF(2), [1, 0, 1, 1]))
            (1, 0, 1, 1, 0, 1, 0)
        """
        return self.encoder(encoder_name, *args, **kwargs).encode(word)

    def unencode(self, c, encoder_name=None, nocheck=False, **kwargs):
        """The message of a codeword.

        EXAMPLES::

            sage: C = codes.HammingCode(GF(2), 3); C.unencode(vector(GF(2), [1, 0, 1, 1, 0, 1, 0]))
            (1, 0, 1, 1)
        """
        E = self.encoder(encoder_name, **kwargs)
        return E.unencode(c, nocheck)

    def decode_to_code(self, word, decoder_name=None, *args, **kwargs):
        """Decode a received word to a codeword.

        EXAMPLES::

            sage: C = codes.HammingCode(GF(2), 3); C.decode_to_code(vector(GF(2), [1, 1, 0, 1, 1, 0, 1]), "Syndrome")
            (1, 1, 0, 1, 0, 0, 1)
        """
        return self.decoder(decoder_name, *args, **kwargs).decode_to_code(word)

    def decode_to_message(self, word, decoder_name=None, *args, **kwargs):
        """Decode a received word to a message.

        EXAMPLES::

            sage: C = codes.HammingCode(GF(2), 3); C.decode_to_message(vector(GF(2), [1, 1, 0, 1, 1, 0, 1]))
            (1, 1, 0, 1)
        """
        return self.unencode(self.decode_to_code(word, decoder_name, *args, **kwargs))

    def random_element(self, *args, **kwds):
        """A random codeword.

        EXAMPLES::

            sage: C = codes.HammingCode(GF(2), 3); C.random_element() in C
            True
        """
        E = self.encoder()
        return E.encode(E.message_space().random_element())


class Encoder:
    """An encoder: a bijection between a message space and a code.

    EXAMPLES::

        sage: C = codes.HammingCode(GF(2), 3); E = C.encoder(); E
        Systematic encoder for [7, 4] Hamming Code over GF(2)
        sage: E.message_space()
        Vector space of dimension 4 over Finite Field of size 2
    """

    def __init__(self, code):
        self._code = code

    def __repr__(self):
        if hasattr(self, "_repr_"):
            return self._repr_()
        return "Encoder for %s" % (self._code,)

    def code(self):
        """The code.

        EXAMPLES::

            sage: codes.HammingCode(GF(2), 3).encoder().code()
            [7, 4] Hamming Code over GF(2)
        """
        return self._code

    def message_space(self):
        """The message space (F^k by default).

        EXAMPLES::

            sage: codes.HammingCode(GF(2), 3).encoder().message_space()
            Vector space of dimension 4 over Finite Field of size 2
        """
        C = self._code
        return _sa().VectorSpace(C.base_field(), int(C.dimension()))

    def encode(self, word):
        """The codeword of a message (message times the generator matrix).

        EXAMPLES::

            sage: codes.HammingCode(GF(2), 3).encoder().encode(vector(GF(2), [0, 1, 1, 0]))
            (0, 1, 1, 0, 0, 1, 1)
        """
        return _vector(self._code.base_field(), _vector(self._code.base_field(), list(word)) * self.generator_matrix())

    def unencode_nocheck(self, c):
        """The message of a codeword (no membership check).

        EXAMPLES::

            sage: C = codes.HammingCode(GF(2), 3); C.encoder().unencode_nocheck(vector(GF(2), [1, 0, 1, 1, 0, 1, 0]))
            (1, 0, 1, 1)
        """
        G = self.generator_matrix()
        F = self._code.base_field()
        piv = G.transpose().pivots() if False else None
        # solve m G = c on the pivot columns of the echelon form
        k = G.nrows()
        cols = _info_set(G)
        A = _matrix(F, [[G[i, j] for j in cols] for i in range(k)])
        rhs = _vector(F, [c[j] for j in cols])
        return _vector(F, rhs * A.inverse())

    def unencode(self, c, nocheck=False):
        """The message of a codeword.

        EXAMPLES::

            sage: E = codes.HammingCode(GF(2), 3).encoder(); E.unencode(vector(GF(2), [0, 1, 1, 0, 0, 1, 1]))
            (0, 1, 1, 0)
        """
        if not nocheck and c not in self._code:
            raise ValueError("Given word is not in the code")
        return self.unencode_nocheck(c)


def _info_set(G):
    """The pivot columns of the echelon form of G (an information set)."""
    return list(G.echelon_form().pivots())


class Decoder:
    """A decoder for a code.

    EXAMPLES::

        sage: C = codes.HammingCode(GF(2), 3); D = C.decoder(); D
        Syndrome decoder for [7, 4] Hamming Code over GF(2) handling errors of weight up to 1
        sage: D.code()
        [7, 4] Hamming Code over GF(2)
    """

    def __init__(self, code, input_space=None, connected_encoder_name=None):
        self._code = code
        self._input_space = input_space
        self._connected_encoder_name = connected_encoder_name

    def __repr__(self):
        if hasattr(self, "_repr_"):
            return self._repr_()
        return "Decoder for %s" % (self._code,)

    def code(self):
        """The code.

        EXAMPLES::

            sage: codes.HammingCode(GF(2), 3).decoder().code()
            [7, 4] Hamming Code over GF(2)
        """
        return self._code

    def input_space(self):
        """The input space.

        EXAMPLES::

            sage: C = codes.HammingCode(GF(2), 3); C.decoder().input_space()
            Vector space of dimension 7 over Finite Field of size 2
        """
        return self._input_space if self._input_space is not None else self._code.ambient_space()

    def connected_encoder(self):
        """The encoder used by decode_to_message.

        EXAMPLES::

            sage: codes.HammingCode(GF(2), 3).decoder().connected_encoder()
            Systematic encoder for [7, 4] Hamming Code over GF(2)
        """
        return self._code.encoder(self._connected_encoder_name)

    def message_space(self):
        """The message space of the connected encoder.

        EXAMPLES::

            sage: C = codes.GeneralizedReedSolomonCode(GF(13).list()[1:9], 3); C.decoder("Gao").message_space()
            Univariate Polynomial Ring in x over Finite Field of size 13
        """
        return self.connected_encoder().message_space()

    def decode_to_message(self, r):
        """Decode to a message (via the connected encoder).

        EXAMPLES::

            sage: C = codes.HammingCode(GF(2), 3); C.decoder().decode_to_message(vector(GF(2), [1, 1, 0, 1, 1, 0, 1]))
            (1, 1, 0, 1)
        """
        return self.connected_encoder().unencode_nocheck(self.decode_to_code(r))


class Channel:
    """A communication channel from an input space to an output space.

    EXAMPLES::

        sage: from sage.coding.channel import Channel; isinstance(channels.StaticErrorRateChannel(GF(2)^4, 1), Channel)
        True
    """

    def __init__(self, input_space, output_space):
        self._input_space, self._output_space = input_space, output_space

    def __repr__(self):
        if hasattr(self, "_repr_"):
            return self._repr_()
        return "Channel"

    def input_space(self):
        """The input space.

        EXAMPLES::

            sage: channels.StaticErrorRateChannel(GF(7)^5, 2).input_space()
            Vector space of dimension 5 over Finite Field of size 7
        """
        return self._input_space

    def output_space(self):
        """The output space.

        EXAMPLES::

            sage: channels.ErrorErasureChannel(GF(7)^5, 1, 2).output_space()
            The Cartesian product of (Vector space of dimension 5 over Finite Field of size 7, Vector space of dimension 5 over Finite Field of size 2)
        """
        return self._output_space

    def transmit(self, message):
        """Transmit a message (checking that it is in the input space).

        EXAMPLES::

            sage: Chan = channels.StaticErrorRateChannel(GF(7)^5, 2); v = vector(GF(7), [1, 2, 3, 4, 5])
            sage: len((Chan.transmit(v) - v).nonzero_positions())
            2
        """
        if message not in self._input_space:
            raise TypeError("Message must be an element of the input space for the given channel")
        return self.transmit_unsafe(message)

    __call__ = transmit


class _Cartesian:
    def __init__(self, spaces):
        self._spaces = spaces

    def __repr__(self):
        return "The Cartesian product of (%s)" % ", ".join(repr(s) for s in self._spaces)

    def __contains__(self, x):
        return isinstance(x, tuple) and len(x) == len(self._spaces) and all(a in s for a, s in zip(x, self._spaces))


class StaticErrorRateChannel(Channel):
    """A channel adding a fixed number of errors (or a number in a range).

    EXAMPLES::

        sage: channels.StaticErrorRateChannel(GF(59)^40, (1, 14))
        Static error rate channel creating between 1 and 14 errors, of input and output space Vector space of dimension 40 over Finite Field of size 59
    """

    def __init__(self, space, number_errors):
        if isinstance(number_errors, (list, tuple)):
            number_errors = (int(number_errors[0]), int(number_errors[1]))
        else:
            number_errors = (int(number_errors), int(number_errors))
        Channel.__init__(self, space, space)
        self._number_errors = number_errors

    def _repr_(self):
        return "Static error rate channel creating %s errors, of input and output space %s" % (format_interval(self._number_errors), self._input_space)

    def number_errors(self):
        """The number of errors (or the range).

        EXAMPLES::

            sage: channels.StaticErrorRateChannel(GF(7)^5, (1, 3)).number_errors()
            (1, 3)
        """
        return self._number_errors

    def transmit_unsafe(self, message):
        """Transmit a message (adding errors at random positions).

        EXAMPLES::

            sage: Chan = channels.StaticErrorRateChannel(GF(7)^5, 2); v = vector(GF(7), [1, 2, 3, 4, 5])
            sage: len((Chan.transmit_unsafe(v) - v).nonzero_positions())
            2
        """
        V = self._input_space
        F = V.base_ring()
        n = int(V.dimension())
        w = list(message)
        k = _random.randint(*self._number_errors)
        nonzero = [x for x in _elements(F) if x != 0]
        for i in _random.sample(range(n), k):
            w[i] = w[i] + _random.choice(nonzero)
        return _vector(F, w)


class ErrorErasureChannel(Channel):
    """A channel adding errors and erasures (the output is a pair: the word,
    erasures set to zero, and the erasure vector over GF(2)).

    EXAMPLES::

        sage: channels.ErrorErasureChannel(GF(7)^5, 1, 2)
        Error-and-erasure channel creating 1 errors and 2 erasures of input space Vector space of dimension 5 over Finite Field of size 7 and output space The Cartesian product of (Vector space of dimension 5 over Finite Field of size 7, Vector space of dimension 5 over Finite Field of size 2)
    """

    def __init__(self, space, number_errors, number_erasures):
        self._ne = int(number_errors)
        self._nr = int(number_erasures)
        n = int(space.dimension())
        Channel.__init__(self, space, _Cartesian([space, _sa().VectorSpace(_sa().GF(2), n)]))

    def _repr_(self):
        return "Error-and-erasure channel creating %d errors and %d erasures of input space %s and output space %s" % (self._ne, self._nr, self._input_space, self._output_space)

    def number_errors(self):
        """The number of errors.

        EXAMPLES::

            sage: channels.ErrorErasureChannel(GF(7)^5, 1, 2).number_errors()
            (1, 1)
        """
        return (self._ne, self._ne)

    def number_erasures(self):
        """The number of erasures.

        EXAMPLES::

            sage: channels.ErrorErasureChannel(GF(7)^5, 1, 2).number_erasures()
            (2, 2)
        """
        return (self._nr, self._nr)

    def transmit_unsafe(self, message):
        """Transmit (the received word, the erasure vector).

        EXAMPLES::

            sage: Chan = channels.ErrorErasureChannel(GF(7)^5, 1, 2); r, e = Chan.transmit_unsafe(vector(GF(7), [1, 2, 3, 4, 5])); e.hamming_weight()
            2
        """
        V = self._input_space
        F = V.base_ring()
        n = int(V.dimension())
        w = list(message)
        pos = _random.sample(range(n), self._ne + self._nr)
        nonzero = [x for x in _elements(F) if x != 0]
        for i in pos[:self._ne]:
            w[i] = w[i] + _random.choice(nonzero)
        er = [0] * n
        for i in pos[self._ne:]:
            w[i] = F(0)
            er[i] = 1
        return (_vector(F, w), _vector(_sa().GF(2), er))


class _Channels:
    """The catalog of channels."""

    def __init__(self):
        self.StaticErrorRateChannel = StaticErrorRateChannel
        self.ErrorErasureChannel = ErrorErasureChannel

    def __repr__(self):
        return "The catalog of channels"


channels = _Channels()


# ----------------------------------------------------------- linear codes

class AbstractLinearCode(AbstractCode):
    """A linear code over a finite field.

    EXAMPLES::

        sage: from sage.coding.linear_code import AbstractLinearCode; isinstance(codes.HammingCode(GF(2), 3), AbstractLinearCode)
        True
    """

    _registered_encoders = {}
    _registered_decoders = {}

    def __init__(self, base_field, length, default_encoder_name, default_decoder_name, metric="Hamming"):
        AbstractCode.__init__(self, length, default_encoder_name, default_decoder_name, metric)
        self._base_field = base_field

    def _repr_(self):
        return "[%d, %d] linear code over %s" % (self._length, int(self.dimension()), _field_name(self._base_field))

    def base_field(self):
        """The base field.

        EXAMPLES::

            sage: codes.HammingCode(GF(3), 2).base_field()
            Finite Field of size 3
        """
        return self._base_field

    base_ring = base_field

    def ambient_space(self):
        """The ambient space F^n.

        EXAMPLES::

            sage: codes.HammingCode(GF(2), 3).ambient_space()
            Vector space of dimension 7 over Finite Field of size 2
        """
        return _sa().VectorSpace(self._base_field, self._length)

    def dimension(self):
        """The dimension.

        EXAMPLES::

            sage: codes.HammingCode(GF(3), 3).dimension()
            10
        """
        d = getattr(self, "_dimension", None)
        if d is None:
            d = self.generator_matrix().rank()
            self._dimension = d
        return _sa().Integer(d)

    def generator_matrix(self, encoder_name=None, **kwds):
        """The generator matrix.

        EXAMPLES::

            sage: codes.HammingCode(GF(2), 3).generator_matrix()
            [1 0 0 0 0 1 1]
            [0 1 0 0 1 0 1]
            [0 0 1 0 1 1 0]
            [0 0 0 1 1 1 1]
        """
        return self.encoder(encoder_name, **kwds).generator_matrix()

    def systematic_generator_matrix(self, systematic_positions=None):
        """The generator matrix in reduced echelon (systematic) form.

        EXAMPLES::

            sage: G = matrix(GF(3), [[1, 2, 0, 0, 1, 2, 1], [0, 1, 0, 0, 2, 1, 0], [0, 0, 1, 2, 2, 2, 2]])
            sage: LinearCode(G).systematic_generator_matrix()
            [1 0 0 0 0 0 1]
            [0 1 0 0 2 1 0]
            [0 0 1 2 2 2 2]
        """
        return self.generator_matrix().echelon_form()

    def information_set(self):
        """An information set (the pivots of the echelon form).

        EXAMPLES::

            sage: codes.HammingCode(GF(2), 3).information_set()
            (0, 1, 2, 3)
        """
        return tuple(_sa().Integer(i) for i in _info_set(self.generator_matrix()))

    def parity_check_matrix(self):
        """A parity check matrix (the right kernel of the generator matrix).

        EXAMPLES::

            sage: G = matrix(GF(3), [[1, 0, 0, 0, 1, 2, 1], [0, 1, 0, 0, 2, 1, 0], [0, 0, 1, 2, 2, 2, 2]])
            sage: LinearCode(G).parity_check_matrix()
            [1 0 0 0 2 2 2]
            [0 1 0 0 1 0 2]
            [0 0 1 0 2 2 0]
            [0 0 0 1 1 1 0]
        """
        return self.generator_matrix().right_kernel_matrix()

    def dual_code(self):
        """The dual code.

        EXAMPLES::

            sage: codes.HammingCode(GF(2), 3).dual_code()
            [7, 3] linear code over GF(2)
        """
        return LinearCode(self.parity_check_matrix())

    def syndrome(self, r):
        """The syndrome H r.

        EXAMPLES::

            sage: C = codes.HammingCode(GF(2), 3); C.syndrome(vector(GF(2), [1, 1, 0, 1, 1, 0, 1]))
            (1, 0, 1)
        """
        H = self.parity_check_matrix()
        return _vector(self._base_field, H * _vector(self._base_field, list(r)))

    def __contains__(self, v):
        try:
            v = list(v)
        except TypeError:
            return False
        if len(v) != self._length:
            return False
        F = self._base_field
        try:
            w = _vector(F, v)
        except Exception:
            return False
        H = self.parity_check_matrix()
        if H.nrows() == 0:
            return True
        return (H * w).is_zero()

    def __iter__(self):
        G = self.generator_matrix()
        F = self._base_field
        for m in _messages(F, G.nrows()):
            yield _vector(F, _vector(F, m) * G)

    def __getitem__(self, i):
        G = self.generator_matrix()
        F = self._base_field
        for k, m in enumerate(_messages(F, G.nrows())):
            if k == i:
                return _vector(F, _vector(F, m) * G)
        raise IndexError("codeword index out of range")

    def cardinality(self):
        """The number of codewords.

        EXAMPLES::

            sage: C = codes.HammingCode(GF(2), 3); C.cardinality()
            16
        """
        return _sa().Integer(int(self._base_field.order()) ** int(self.dimension()))

    def __eq__(self, other):
        return isinstance(other, AbstractLinearCode) and self._length == other._length and \
            self._base_field == other._base_field and self.systematic_generator_matrix() == other.systematic_generator_matrix()

    def __ne__(self, other):
        return not self == other

    def __hash__(self):
        return hash((self._length, int(self.dimension())))

    def zero(self):
        """The zero codeword.

        EXAMPLES::

            sage: C = codes.HammingCode(GF(2), 3); C.zero()
            (0, 0, 0, 0, 0, 0, 0)
        """
        return self.ambient_space().zero()

    def minimum_distance(self, algorithm=None):
        """The minimum distance (by enumeration of the codewords).

        EXAMPLES::

            sage: G = matrix(GF(3), [[1, 0, 0, 0, 1, 2, 1], [0, 1, 0, 0, 2, 1, 0], [0, 0, 1, 2, 2, 2, 2]])
            sage: LinearCode(G).minimum_distance()  # sagebrush only
            3
        """
        d = getattr(self, "_minimum_distance", None)
        if d is None:
            d = min((c.hamming_weight() for c in self if not c.is_zero()), default=0)
            self._minimum_distance = d
        return _sa().Integer(d)

    def weight_distribution(self, algorithm=None):
        """The numbers of codewords of each weight 0..n.

        EXAMPLES::

            sage: codes.HammingCode(GF(2), 3).weight_distribution()
            [1, 0, 0, 7, 7, 0, 0, 1]
        """
        w = [0] * (self._length + 1)
        for c in self:
            w[c.hamming_weight()] += 1
        return [_sa().Integer(x) for x in w]

    spectrum = weight_distribution

    def covering_radius(self):
        """The covering radius (the largest weight of a coset leader).

        EXAMPLES::

            sage: C = LinearCode(matrix(GF(3), [[1, 0, 0, 0, 1, 2, 1], [0, 1, 0, 0, 2, 1, 0], [0, 0, 1, 2, 2, 2, 2]])); C.covering_radius()  # sagebrush only
            3
        """
        return self.decoder("Syndrome")._t()


class LinearCode(AbstractLinearCode):
    """The linear code spanned by the rows of a matrix.

    EXAMPLES::

        sage: G = matrix(GF(3), [[1, 0, 0, 0, 1, 2, 1], [0, 1, 0, 0, 2, 1, 0], [0, 0, 1, 2, 2, 2, 2]])
        sage: C = LinearCode(G); C, C.length(), C.dimension()
        ([7, 3] linear code over GF(3), 7, 3)
    """

    _registered_encoders = {}
    _registered_decoders = {}

    def __init__(self, generator, d=None):
        G = generator
        if not hasattr(G, "nrows"):
            G = generator.generator_matrix()
        F = G.base_ring()
        E = G.echelon_form()
        r = E.rank()
        AbstractLinearCode.__init__(self, F, G.ncols(), "GeneratorMatrix", "Syndrome")
        self._generator_matrix = _matrix(F, [list(E.row(i)) for i in range(r)]) if r else _sa().matrix(F, 0, G.ncols())
        self._dimension = r
        if d is not None:
            self._minimum_distance = int(d)


class LinearCodeGeneratorMatrixEncoder(Encoder):
    """The encoder by multiplication with the generator matrix.

    EXAMPLES::

        sage: C = LinearCode(matrix(GF(3), [[1, 0, 0, 0, 1, 2, 1], [0, 1, 0, 0, 2, 1, 0], [0, 0, 1, 2, 2, 2, 2]])); C.encoder()
        Generator matrix-based encoder for [7, 3] linear code over GF(3)
    """

    def _repr_(self):
        return "Generator matrix-based encoder for %s" % (self._code,)

    def generator_matrix(self):
        """The generator matrix.

        EXAMPLES::

            sage: G = matrix(GF(3), [[1, 0, 0, 0, 1, 2, 1], [0, 1, 0, 0, 2, 1, 0], [0, 0, 1, 2, 2, 2, 2]])
            sage: LinearCode(G).encoder().generator_matrix() == G
            True
        """
        return self._code._generator_matrix


class LinearCodeSystematicEncoder(Encoder):
    """The encoder by the systematic generator matrix.

    EXAMPLES::

        sage: C = LinearCode(matrix(GF(3), [[1, 0, 0, 0, 1, 2, 1], [0, 1, 0, 0, 2, 1, 0], [0, 0, 1, 2, 2, 2, 2]])); C.encoder('Systematic')
        Systematic encoder for [7, 3] linear code over GF(3)
    """

    def _repr_(self):
        return "Systematic encoder for %s" % (self._code,)

    def generator_matrix(self):
        """The systematic generator matrix.

        EXAMPLES::

            sage: codes.HammingCode(GF(2), 3).encoder("Systematic").generator_matrix()[0]
            (1, 0, 0, 0, 0, 1, 1)
        """
        C = self._code
        G = C._generator_matrix if hasattr(C, "_generator_matrix") else C.encoder(C._default_encoder_name if C._default_encoder_name != "Systematic" else None).generator_matrix()
        return G.echelon_form()


class LinearCodeSyndromeDecoder(Decoder):
    """Decoding by a table of coset leaders (syndrome to error of least
    weight).

    EXAMPLES::

        sage: C = LinearCode(matrix(GF(3), [[1, 0, 0, 0, 1, 2, 1], [0, 1, 0, 0, 2, 1, 0], [0, 0, 1, 2, 2, 2, 2]])); C.decoder()
        Syndrome decoder for [7, 3] linear code over GF(3) handling errors of weight up to 3
    """

    def __init__(self, code, maximum_error_weight=None):
        Decoder.__init__(self, code, code.ambient_space(), code._default_encoder_name)
        n, k = code._length, int(code.dimension())
        self._max = int(maximum_error_weight) if maximum_error_weight is not None else n - k
        self._table = None

    def _build(self):
        if self._table is None:
            C = self._code
            F = C.base_field()
            H = C.parity_check_matrix()
            n = C._length
            nonzero = [x for x in _elements(F) if x != 0]
            q = int(F.order())
            need = q ** H.nrows()
            table = {}
            tmax = 0
            for w in range(0, self._max + 1):
                for pos in itertools.combinations(range(n), w):
                    for vals in itertools.product(nonzero, repeat=w):
                        e = [F(0)] * n
                        for p, v in zip(pos, vals):
                            e[p] = v
                        ev = _vector(F, e)
                        s = tuple(H * ev)
                        if s not in table:
                            table[s] = ev
                            tmax = w
                    if len(table) == need:
                        break
                if len(table) == need:
                    break
            self._table, self._tmax = table, tmax
        return self._table

    def _t(self):
        self._build()
        return _sa().Integer(self._tmax)

    def _repr_(self):
        return "Syndrome decoder for %s handling errors of weight up to %d" % (self._code, self._t())

    def decode_to_code(self, r):
        """The codeword: r minus the coset leader of its syndrome.

        EXAMPLES::

            sage: C = codes.HammingCode(GF(2), 3); D = C.decoder("Syndrome")
            sage: D.decode_to_code(vector(GF(2), [1, 1, 0, 1, 1, 0, 1]))
            (1, 1, 0, 1, 0, 0, 1)
        """
        C = self._code
        F = C.base_field()
        r = _vector(F, list(r))
        s = tuple(C.parity_check_matrix() * r)
        e = self._build().get(s)
        if e is None:
            raise ValueError("decoding failed")
        return r - e

    def decoding_radius(self):
        """The largest weight of a coset leader.

        EXAMPLES::

            sage: C = LinearCode(matrix(GF(3), [[1, 0, 0, 0, 1, 2, 1], [0, 1, 0, 0, 2, 1, 0], [0, 0, 1, 2, 2, 2, 2]])); C.decoder().decoding_radius()
            3
        """
        return self._t()

    def syndrome_table(self):
        """The table syndrome -> coset leader.

        EXAMPLES::

            sage: C = codes.HammingCode(GF(2), 3); len(C.decoder().syndrome_table())
            8
        """
        return dict(self._build())


class LinearCodeNearestNeighborDecoder(Decoder):
    """Decoding to a closest codeword (by enumeration).

    EXAMPLES::

        sage: C = codes.HammingCode(GF(2), 3); C.decoder('NearestNeighbor')
        Nearest neighbor decoder for [7, 4] Hamming Code over GF(2)
    """

    def __init__(self, code):
        Decoder.__init__(self, code, code.ambient_space(), code._default_encoder_name)

    def _repr_(self):
        return "Nearest neighbor decoder for %s" % (self._code,)

    def decode_to_code(self, r):
        """A closest codeword.

        EXAMPLES::

            sage: C = codes.HammingCode(GF(2), 3); C.decoder("NearestNeighbor").decode_to_code(vector(GF(2), [1, 1, 0, 1, 1, 0, 1]))
            (1, 1, 0, 1, 0, 0, 1)
        """
        F = self._code.base_field()
        r = _vector(F, list(r))
        best = None
        rank = self._code.metric() == "rank"
        for c in self._code:
            # the code's own metric (rank metric codes: rank distance)
            d = self._code.rank_distance_between_vectors(c, r) if rank else (c - r).hamming_weight()
            if best is None or d < best[0]:
                best = (d, c)
        return best[1]

    def decoding_radius(self):
        """(d - 1) // 2.

        EXAMPLES::

            sage: C = codes.HammingCode(GF(2), 3); C.decoder('NearestNeighbor').decoding_radius()
            1
        """
        return (self._code.minimum_distance() - 1) // 2


class LinearCodeInformationSetDecoder(Decoder):
    """Information set decoding (Lee-Brickell), here by enumerating
    information sets and low weight error patterns on them.

    EXAMPLES::

        sage: C = codes.HammingCode(GF(2), 3); C.decoder('InformationSet', 1)
        Information-set decoder (Lee-Brickell) for [7, 4] Hamming Code over GF(2) decoding up to 1 errors 
    """

    def __init__(self, code, number_errors, algorithm=None, **kwargs):
        Decoder.__init__(self, code, code.ambient_space(), code._default_encoder_name)
        self._ne = int(number_errors) if not isinstance(number_errors, (tuple, list)) else int(number_errors[1])

    def _repr_(self):
        return "Information-set decoder (Lee-Brickell) for %s decoding up to %d errors " % (self._code, self._ne)

    def decode_to_code(self, r):
        """A codeword within the decoding radius.

        EXAMPLES::

            sage: C = codes.HammingCode(GF(2), 3); C.decoder("InformationSet", 1).decode_to_code(vector(GF(2), [1, 1, 0, 1, 1, 0, 1]))
            (1, 1, 0, 1, 0, 0, 1)
        """
        for c in self._code:
            if (c - _vector(self._code.base_field(), list(r))).hamming_weight() <= self._ne:
                return c
        raise ValueError("decoding failed")

    def decoding_radius(self):
        """The number of errors.

        EXAMPLES::

            sage: C = codes.HammingCode(GF(2), 3); C.decoder('InformationSet', 1).decoding_radius()
            1
        """
        return _sa().Integer(self._ne)


for _n, _c in [("GeneratorMatrix", LinearCodeGeneratorMatrixEncoder), ("Systematic", LinearCodeSystematicEncoder)]:
    LinearCode._registered_encoders[_n] = _c
for _n, _c in [("Syndrome", LinearCodeSyndromeDecoder), ("NearestNeighbor", LinearCodeNearestNeighborDecoder), ("InformationSet", LinearCodeInformationSetDecoder)]:
    LinearCode._registered_decoders[_n] = _c
AbstractLinearCode._registered_encoders = dict(LinearCode._registered_encoders)
AbstractLinearCode._registered_decoders = dict(LinearCode._registered_decoders)


class HammingCode(AbstractLinearCode):
    """The q-ary Hamming code of order r: the parity check matrix has the
    points of the projective space PG(r-1, q) as columns.

    EXAMPLES::

        sage: C = codes.HammingCode(GF(3), 3); C
        [13, 10] Hamming Code over GF(3)
        sage: C.parity_check_matrix()
        [1 0 1 1 0 1 0 1 1 1 0 1 1]
        [0 1 1 2 0 0 1 1 2 0 1 1 2]
        [0 0 0 0 1 1 1 1 1 2 2 2 2]
    """

    _registered_encoders = {"Systematic": LinearCodeSystematicEncoder}
    _registered_decoders = dict(LinearCode._registered_decoders)

    def __init__(self, base_field, order):
        F = base_field
        r = int(order)
        q = int(F.order())
        n = (q ** r - 1) // (q - 1)
        AbstractLinearCode.__init__(self, F, n, "Systematic", "Syndrome")
        els = _elements(F)
        cols = []
        for t in range(1, q ** r):
            v, x = [], t
            for _ in range(r):
                v.append(els[x % q])
                x //= q
            first = next(a for a in v if a != 0)
            if first == 1:
                cols.append(v)
        self._H = _matrix(F, [[c[i] for c in cols] for i in range(r)])
        self._generator_matrix = self._H.right_kernel_matrix()
        self._dimension = n - r
        self._order = r

    def _repr_(self):
        return "[%d, %d] Hamming Code over %s" % (self._length, self._dimension, _field_name(self._base_field))

    def parity_check_matrix(self):
        """The parity check matrix (the points of PG(r-1, q) as columns).

        EXAMPLES::

            sage: C = codes.HammingCode(GF(2), 3); C.parity_check_matrix()
            [1 0 1 0 1 0 1]
            [0 1 1 0 0 1 1]
            [0 0 0 1 1 1 1]
        """
        return self._H

    def minimum_distance(self, algorithm=None):
        """3.

        EXAMPLES::

            sage: C = codes.HammingCode(GF(2), 3); C.minimum_distance()
            3
        """
        return _sa().Integer(3)


def _golay(F, extended):
    q = int(F.order())
    rows = {
        (2, True): ["100000000000101011100011", "010000000000111110010010", "001000000000110100101011", "000100000000110001110110",
                    "000010000000110011011001", "000001000000011001101101", "000000100000001100110111", "000000010000101101111000",
                    "000000001000010110111100", "000000000100001011011110", "000000000010101110001101", "000000000001010111000111"],
        (2, False): ["10101110001100000000000", "01010111000110000000000", "00101011100011000000000", "00010101110001100000000",
                     "00001010111000110000000", "00000101011100011000000", "00000010101110001100000", "00000001010111000110000",
                     "00000000101011100011000", "00000000010101110001100", "00000000001010111000110", "00000000000101011100011"],
        (3, True): ["100000201212", "010000122210", "001000111011", "000100110222", "000010212201", "000001021221"],
        (3, False): ["20121100000", "02012110000", "00201211000", "00020121100", "00002012110", "00000201211"],
    }[(q, bool(extended))]
    return _matrix(F, [[F(int(c)) for c in r] for r in rows])


class GolayCode(AbstractLinearCode):
    """The (extended) binary or ternary Golay code.

    EXAMPLES::

        sage: C = codes.GolayCode(GF(3)); C
        [12, 6, 6] Extended Golay code over GF(3)
        sage: C.generator_matrix()
        [1 0 0 0 0 0 2 0 1 2 1 2]
        [0 1 0 0 0 0 1 2 2 2 1 0]
        [0 0 1 0 0 0 1 1 1 0 1 1]
        [0 0 0 1 0 0 1 1 0 2 2 2]
        [0 0 0 0 1 0 2 1 2 2 0 1]
        [0 0 0 0 0 1 0 2 1 2 2 1]
    """

    _registered_encoders = dict(LinearCode._registered_encoders)
    _registered_decoders = dict(LinearCode._registered_decoders)

    def __init__(self, base_field, extended=True):
        F = base_field
        q = int(F.order())
        if q not in (2, 3):
            raise ValueError("finite_field must be either GF(2) or GF(3)")
        G = _golay(F, extended)
        AbstractLinearCode.__init__(self, F, G.ncols(), "GeneratorMatrix", "Syndrome")
        self._generator_matrix = G
        self._dimension = G.nrows()
        self._extended = bool(extended)
        self._minimum_distance = {(2, True): 8, (2, False): 7, (3, True): 6, (3, False): 5}[(q, self._extended)]

    def _repr_(self):
        return "[%d, %d, %d] %s Golay code over %s" % (self._length, self._dimension, self._minimum_distance, "Extended" if self._extended else "", _field_name(self._base_field))


# --------------------------------------------- generalized Reed-Solomon codes

class GeneralizedReedSolomonCode(AbstractLinearCode):
    """The GRS code {(v_1 f(a_1), ..., v_n f(a_n)) : deg f < k}.

    EXAMPLES::

        sage: F = GF(13); C = codes.GeneralizedReedSolomonCode(F.list()[:12], 6, F.list()[1:13]); C
        [12, 6, 7] Generalized Reed-Solomon Code over GF(13)
        sage: C.minimum_distance(), C.base_ring()
        (7, Finite Field of size 13)
    """

    _registered_encoders = {}
    _registered_decoders = {}

    def __init__(self, evaluation_points, dimension, column_multipliers=None):
        pts = list(evaluation_points)
        F = pts[0].parent() if hasattr(pts[0], "parent") else None
        F = F if F is not None and hasattr(F, "order") else _sa().GF(2)
        n = len(pts)
        # distinct in F, after conversion (0 and 5 are one point of GF(5):
        # the systematic review's R2-EXT-F3)
        self._pts = [F(a) for a in pts]
        if len(set(self._pts)) != n:
            raise ValueError("there must be n distinct evaluation points")
        AbstractLinearCode.__init__(self, F, n, "EvaluationVector", "Gao")
        self._mult = [F(v) for v in column_multipliers] if column_multipliers is not None else [F(1)] * n
        # the GRS distance n - k + 1 needs nonzero multipliers and 0 < k <= n
        if len(self._mult) != n:
            raise ValueError("there must be exactly %d column multipliers" % n)
        if any(v == 0 for v in self._mult):
            raise ValueError("all column multipliers must be nonzero")
        if dimension != int(dimension) or not 0 < int(dimension) <= n:
            raise ValueError("the dimension must be an integer with 0 < k <= n")
        self._dimension = int(dimension)

    def _repr_(self):
        kind = "Reed-Solomon Code" if all(v == 1 for v in self._mult) else "Generalized Reed-Solomon Code"
        return "[%d, %d, %d] %s over %s" % (self._length, self._dimension, self._length - self._dimension + 1, kind, _field_name(self._base_field))

    def minimum_distance(self, algorithm=None):
        """n - k + 1.

        EXAMPLES::

            sage: C = codes.GeneralizedReedSolomonCode(GF(7).list()[1:7], 2); C.minimum_distance()
            5
        """
        return _sa().Integer(self._length - self._dimension + 1)

    def evaluation_points(self):
        """The evaluation points.

        EXAMPLES::

            sage: codes.GeneralizedReedSolomonCode(GF(13).list()[:5], 2).evaluation_points()
            (0, 1, 2, 3, 4)
        """
        return tuple(self._pts)

    def column_multipliers(self):
        """The column multipliers.

        EXAMPLES::

            sage: codes.GeneralizedReedSolomonCode(GF(13).list()[:5], 2).column_multipliers()
            (1, 1, 1, 1, 1)
        """
        return tuple(self._mult)

    def multipliers_product(self):
        """The products 1/prod_{j != i}(a_i - a_j).

        EXAMPLES::

            sage: C = codes.GeneralizedReedSolomonCode(GF(7).list()[1:7], 2); C.multipliers_product()
            [6, 5, 4, 3, 2, 1]
        """
        out = []
        for i, a in enumerate(self._pts):
            p = self._base_field(1)
            for j, b in enumerate(self._pts):
                if j != i:
                    p = p * (a - b)
            out.append(1 / p)
        return out

    def dual_code(self):
        """The dual (again a GRS code).

        EXAMPLES::

            sage: codes.GeneralizedReedSolomonCode(GF(13).list()[:12], 6, GF(13).list()[1:13]).dual_code()
            [12, 6, 7] Generalized Reed-Solomon Code over GF(13)
        """
        u = [m / v for m, v in zip(self.multipliers_product(), self._mult)]
        return GeneralizedReedSolomonCode(self._pts, self._length - self._dimension, u)

    def parity_check_matrix(self):
        """A parity check matrix (the generator matrix of the dual).

        EXAMPLES::

            sage: codes.GeneralizedReedSolomonCode(GF(13).list()[:12], 6, GF(13).list()[1:13]).parity_check_matrix()[0]
            (12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12)
        """
        return self.dual_code().generator_matrix()

    def _poly_ring(self):
        return _sa().PolynomialRing(self._base_field, "x")

    def _evaluate(self, coeffs):
        F = self._base_field
        out = []
        for a, v in zip(self._pts, self._mult):
            s = F(0)
            for c in reversed(coeffs):
                s = s * a + c
            out.append(v * s)
        return _vector(F, out)


class GRSEvaluationVectorEncoder(Encoder):
    """Messages are vectors of coefficients."""

    def _repr_(self):
        return "Evaluation vector-style encoder for %s" % (self._code,)

    def generator_matrix(self):
        """The generator matrix (rows v_j a_j^i).

        EXAMPLES::

            sage: C = codes.GeneralizedReedSolomonCode(GF(7).list()[1:6], 2); C.generator_matrix()
            [1 1 1 1 1]
            [1 2 3 4 5]
        """
        C = self._code
        F = C._base_field
        return _matrix(F, [[v * a ** i for a, v in zip(C._pts, C._mult)] for i in range(C._dimension)])


class GRSEvaluationPolynomialEncoder(Encoder):
    """Messages are polynomials of degree < k."""

    def __init__(self, code, polynomial_ring=None):
        Encoder.__init__(self, code)
        self._R = polynomial_ring or code._poly_ring()

    def _repr_(self):
        return "Evaluation polynomial-style encoder for %s" % (self._code,)

    def message_space(self):
        """The polynomial ring.

        EXAMPLES::

            sage: codes.GeneralizedReedSolomonCode(GF(59).list()[:40], 12).encoder("EvaluationPolynomial").message_space()
            Univariate Polynomial Ring in x over Finite Field of size 59
        """
        return self._R

    polynomial_ring = message_space

    def generator_matrix(self):
        return self._code.encoder("EvaluationVector").generator_matrix()

    def encode(self, p):
        """The evaluations of a polynomial.

        EXAMPLES::

            sage: C = codes.GeneralizedReedSolomonCode(GF(7).list()[1:6], 2); x = polygen(GF(7))
            sage: C.encoder("EvaluationPolynomial").encode(x + 1)
            (2, 3, 4, 5, 6)
        """
        F = self._code._base_field
        coeffs = [F(c) for c in self._R(p).list()]
        if len(coeffs) > self._code._dimension:
            raise ValueError("The polynomial to encode must have degree at most %d" % (self._code._dimension - 1))
        return self._code._evaluate(coeffs)

    def unencode_nocheck(self, c):
        m = GRSEvaluationVectorEncoder(self._code).unencode_nocheck(c)
        return self._R(list(m))


class GRSSystematicEncoder(LinearCodeSystematicEncoder):
    def generator_matrix(self):
        return self._code.encoder("EvaluationVector").generator_matrix().echelon_form()


def _poly_divmod(a, b):
    """Polynomials over a field as coefficient lists (low degree first)."""
    a = list(a)
    q = [a[0] * 0] * max(len(a) - len(b) + 1, 1)
    inv = 1 / b[-1]
    while len(a) >= len(b) and any(x != 0 for x in a):
        c = a[-1] * inv
        d = len(a) - len(b)
        q[d] = c
        for i, x in enumerate(b):
            a[i + d] = a[i + d] - c * x
        while a and a[-1] == 0:
            a.pop()
    return q, a


def _ptrim(a):
    a = list(a)
    while a and a[-1] == 0:
        a.pop()
    return a


def _pmul(a, b, zero):
    if not a or not b:
        return []
    out = [zero] * (len(a) + len(b) - 1)
    for i, x in enumerate(a):
        for j, y in enumerate(b):
            out[i + j] = out[i + j] + x * y
    return _ptrim(out)


def _psub(a, b, zero):
    n = max(len(a), len(b))
    return _ptrim([(a[i] if i < len(a) else zero) - (b[i] if i < len(b) else zero) for i in range(n)])


def _gao(F, pts, ys, k):
    """Gao's decoding: f of degree < k with f(a_i) = y_i except at most
    (n - k)/2 positions, or None."""
    zero, one = F(0), F(1)
    n = len(pts)
    # interpolate R with R(a_i) = y_i
    R = []
    for i, (a, y) in enumerate(zip(pts, ys)):
        if y == 0:
            continue
        num = [one]
        den = one
        for j, b in enumerate(pts):
            if j != i:
                num = _pmul(num, [-b, one], zero)
                den = den * (a - b)
        R = _psub(R, [-(y / den) * c for c in num], zero)
    G0 = [one]
    for a in pts:
        G0 = _pmul(G0, [-a, one], zero)
    # partial extended Euclid on (G0, R)
    r0, r1 = G0, R
    s0, s1 = [], [one]
    bound = (n + k) / 2
    while r1 and len(r1) - 1 >= bound:
        q, r = _poly_divmod(r0, r1)
        r0, r1 = r1, _ptrim(r)
        s0, s1 = s1, _psub(s0, _pmul(q, s1, zero), zero)
    if not s1:
        return None
    f, rem = _poly_divmod(r1, s1) if r1 else ([zero], [])
    if _ptrim(rem) or len(_ptrim(f)) > k:
        return None
    return _ptrim(f)


class GRSGaoDecoder(Decoder):
    """Gao's decoder (extended Euclid)."""

    def __init__(self, code):
        Decoder.__init__(self, code, code.ambient_space(), "EvaluationPolynomial")

    def _repr_(self):
        return "Gao decoder for %s" % (self._code,)

    def decoding_radius(self):
        """(n - k) // 2.

        EXAMPLES::

            sage: codes.GeneralizedReedSolomonCode(GF(13).list()[:12], 6).decoder("Gao").decoding_radius()
            3
        """
        C = self._code
        return _sa().Integer((C._length - C._dimension) // 2)

    def _decode_poly(self, r):
        C = self._code
        F = C._base_field
        ys = [F(x) / v for x, v in zip(list(r), C._mult)]
        f = _gao(F, C._pts, ys, C._dimension)
        if f is None:
            raise ValueError("decoding failed")
        return f

    def decode_to_message(self, r):
        """The polynomial f (with the codeword (v_i f(a_i))).

        EXAMPLES::

            sage: C = codes.GeneralizedReedSolomonCode(GF(7).list()[1:6], 2); x = polygen(GF(7))
            sage: c = C.encoder("EvaluationPolynomial").encode(x + 1); r = vector(GF(7), [2, 3, 0, 5, 6])
            sage: C.decoder("Gao").decode_to_message(r)
            x + 1
        """
        return self.connected_encoder().message_space()(self._decode_poly(r))

    def decode_to_code(self, r):
        """The codeword.

        EXAMPLES::

            sage: C = codes.GeneralizedReedSolomonCode(GF(7).list()[1:6], 2)
            sage: C.decoder("Gao").decode_to_code(vector(GF(7), [2, 3, 0, 5, 6]))
            (2, 3, 4, 5, 6)
        """
        f = self._decode_poly(r)
        F = self._code._base_field
        return self._code._evaluate(f + [F(0)] * (self._code._dimension - len(f)))


class GRSBerlekampWelchDecoder(GRSGaoDecoder):
    """The Berlekamp-Welch decoder (same results as Gao's for at most
    (n - k)/2 errors)."""

    def _repr_(self):
        return "Berlekamp-Welch decoder for %s" % (self._code,)


class GRSKeyEquationSyndromeDecoder(GRSGaoDecoder):
    """The key equation (syndrome) decoder."""

    def __init__(self, code):
        if any(a == 0 for a in code._pts):
            raise ValueError("Impossible to use this decoder over a GRS code which contains 0 amongst its evaluation points")
        Decoder.__init__(self, code, code.ambient_space(), "EvaluationVector")

    def _repr_(self):
        return "Key equation decoder for %s" % (self._code,)

    def decode_to_message(self, r):
        f = self._decode_poly(r)
        F = self._code._base_field
        return _vector(F, f + [F(0)] * (self._code._dimension - len(f)))


class GRSErrorErasureDecoder(Decoder):
    """Decodes (word, erasure vector) pairs."""

    def __init__(self, code):
        Decoder.__init__(self, code, None, "EvaluationVector")

    def _repr_(self):
        return "Error-Erasure decoder for %s" % (self._code,)

    def decode_to_message(self, word_and_erasure_vector):
        """The message from a (received word, erasure vector) pair.

        EXAMPLES::

            sage: C = codes.GeneralizedReedSolomonCode(GF(7).list()[1:7], 2)
            sage: D = C.decoder("ErrorErasure"); r = vector(GF(7), [2, 0, 0, 5, 6, 0]); e = vector(GF(2), [0, 1, 1, 0, 0, 0])
            sage: D.decode_to_message((r, e))
            (1, 1)
        """
        r, e = word_and_erasure_vector
        C = self._code
        F = C._base_field
        keep = [i for i in range(C._length) if e[i] == 0]
        pts = [C._pts[i] for i in keep]
        ys = [F(r[i]) / C._mult[i] for i in keep]
        f = _gao(F, pts, ys, C._dimension)
        if f is None:
            raise ValueError("decoding failed")
        return _vector(F, f + [F(0)] * (C._dimension - len(f)))

    def decode_to_code(self, word_and_erasure_vector):
        m = self.decode_to_message(word_and_erasure_vector)
        return self._code._evaluate(list(m))


class GRSGuruswamiSudanDecoder(GRSGaoDecoder):
    """The Guruswami-Sudan decoder (here: unique decoding within half the
    minimum distance)."""

    def __init__(self, code, tau=None, parameters=None, interpolation_alg=None, root_finder=None):
        GRSGaoDecoder.__init__(self, code)
        unique = (code._length - code._dimension) // 2
        # only unique decoding is implemented: a larger list-decoding radius
        # (or interpolation/root-finder choices) would be a false claim
        if tau is not None and int(tau) > unique:
            raise NotImplementedError("Guruswami-Sudan list decoding beyond %d errors is not implemented (unique decoding only)" % unique)
        if parameters is not None or interpolation_alg is not None or root_finder is not None:
            raise NotImplementedError("Guruswami-Sudan parameters, interpolation_alg and root_finder are not implemented")
        self._tau = int(tau) if tau is not None else unique

    def _repr_(self):
        return "Guruswami-Sudan decoder for %s decoding %d errors" % (self._code, self._tau)


for _n, _c in [("EvaluationVector", GRSEvaluationVectorEncoder), ("EvaluationPolynomial", GRSEvaluationPolynomialEncoder), ("Systematic", GRSSystematicEncoder)]:
    GeneralizedReedSolomonCode._registered_encoders[_n] = _c
for _n, _c in [("Gao", GRSGaoDecoder), ("BerlekampWelch", GRSBerlekampWelchDecoder), ("KeyEquationSyndrome", GRSKeyEquationSyndromeDecoder),
               ("ErrorErasure", GRSErrorErasureDecoder), ("GuruswamiSudan", GRSGuruswamiSudanDecoder),
               ("NearestNeighbor", LinearCodeNearestNeighborDecoder), ("Syndrome", LinearCodeSyndromeDecoder), ("InformationSet", LinearCodeInformationSetDecoder)]:
    GeneralizedReedSolomonCode._registered_decoders[_n] = _c

for _cls in (GRSEvaluationVectorEncoder, GRSEvaluationPolynomialEncoder, GRSSystematicEncoder, GRSGaoDecoder, GRSBerlekampWelchDecoder,
             GRSKeyEquationSyndromeDecoder, GRSErrorErasureDecoder, GRSGuruswamiSudanDecoder):
    _cls.__module__ = "sage.coding.grs_code"
del _n, _c, _cls


def random_linear_code(base_field, length, dimension):
    """A random [n, k] linear code.

    EXAMPLES::

        sage: C = codes.random_linear_code(GF(7), 10, 5); C
        [10, 5] linear code over GF(7)
    """
    F = base_field
    n, k = int(length), int(dimension)
    els = _elements(F)
    while True:
        G = _matrix(F, [[_random.choice(els) for _ in range(n)] for _ in range(k)])
        if G.rank() == k:
            return LinearCode(G)


# ------------------------------------------------- linear rank metric codes

class LinearRankMetricCode(AbstractLinearCode):
    """A linear code over GF(q^m) with the rank metric relative to GF(q).

    EXAMPLES::

        sage: C = codes.LinearRankMetricCode(Matrix(GF(4), [[1, 1, 0], [0, 0, 1]])); C
        [3, 2] linear rank metric code over GF(4)/GF(2)
        sage: list(C)[:4]
        [(0, 0, 0), (1, 1, 0), (z2, z2, 0), (z2 + 1, z2 + 1, 0)]
    """

    _registered_encoders = {"GeneratorMatrix": LinearCodeGeneratorMatrixEncoder}
    _registered_decoders = {"NearestNeighbor": LinearCodeNearestNeighborDecoder}

    def __init__(self, generator, sub_field=None, basis=None):
        G = generator
        F = G.base_ring()
        AbstractLinearCode.__init__(self, F, G.ncols(), "GeneratorMatrix", "NearestNeighbor", metric="rank")
        r = G.rank()
        if r < G.nrows():
            # dependent rows: a basis of the row space, so that the encoder
            # is a bijection onto the code (the zero row of [[0, 0], [1, 0]]
            # encoded every message as 0: the systematic review's R2-EXT-F8)
            E = G.echelon_form()
            G = _matrix(F, [list(E.row(i)) for i in range(r)]) if r else _sa().matrix(F, 0, G.ncols())
        self._generator_matrix = G
        self._dimension = r
        p = int(F.characteristic())
        self._sub = sub_field or _sa().GF(p)
        q = int(self._sub.order())
        Q = int(F.order())
        m = 0
        while q ** m < Q:
            m += 1
        self._m = m
        z = F.gen() if Q != q else F(1)
        self._basis = list(basis) if basis is not None else [z ** i for i in range(m)]

    def _repr_(self):
        return "[%d, %d] linear rank metric code over GF(%d)/GF(%d)" % (self._length, self._dimension, int(self._base_field.order()), int(self._sub.order()))

    def extension_degree(self):
        """The degree m of GF(q^m) over GF(q).

        EXAMPLES::

            sage: C = codes.LinearRankMetricCode(Matrix(GF(4), [[1, 1, 0], [0, 0, 1]])); C.extension_degree()
            2
        """
        return _sa().Integer(self._m)

    def sub_field(self):
        """The subfield GF(q).

        EXAMPLES::

            sage: C = codes.LinearRankMetricCode(Matrix(GF(4), [[1, 1, 0], [0, 0, 1]])); C.sub_field()
            Finite Field of size 2
        """
        return self._sub

    def _coords(self, x):
        """The coordinates of x in the basis over the subfield."""
        F = self._base_field
        for t in itertools.product(_elements(self._sub), repeat=self._m):
            s = F(0)
            for c, b in zip(t, self._basis):
                s = s + F(c) * b
            if s == x:
                return list(t)
        raise ValueError("not expressible")

    def matrix_form_of_vector(self, word):
        """The m x n matrix of the coordinates of the entries.

        EXAMPLES::

            sage: C = codes.LinearRankMetricCode(Matrix(GF(4), [[1, 1, 0], [0, 0, 1]]))
            sage: C.matrix_form_of_vector(C[2])
            [0 0 0]
            [1 1 0]
        """
        cols = [self._coords(x) for x in word]
        return _matrix(self._sub, [[c[i] for c in cols] for i in range(self._m)])

    def vector_form_of_matrix(self, M):
        """The vector of a matrix form.

        EXAMPLES::

            sage: C = codes.LinearRankMetricCode(Matrix(GF(4), [[1, 1, 0], [0, 0, 1]])); C.vector_form_of_matrix(C.matrix_form_of_vector(C[2])) == C[2]
            True
        """
        F = self._base_field
        return _vector(F, [sum((F(M[i, j]) * self._basis[i] for i in range(self._m)), F(0)) for j in range(M.ncols())])

    def rank_weight_of_vector(self, word):
        """The rank of the matrix form.

        EXAMPLES::

            sage: C = codes.LinearRankMetricCode(Matrix(GF(4), [[1, 1, 0], [0, 0, 1]])); C.rank_weight_of_vector(C[1])
            1
        """
        return self.matrix_form_of_vector(word).rank()

    def rank_distance_between_vectors(self, left, right):
        """The rank weight of the difference.

        EXAMPLES::

            sage: C = codes.LinearRankMetricCode(Matrix(GF(4), [[1, 1, 0], [0, 0, 1]])); C.rank_distance_between_vectors(C[1], C[2])
            1
        """
        return self.rank_weight_of_vector(left - right)

    def minimum_distance(self, algorithm=None):
        """The minimum rank distance.

        EXAMPLES::

            sage: C = codes.LinearRankMetricCode(Matrix(GF(4), [[1, 1, 0], [0, 0, 1]])); C.minimum_distance()
            1
        """
        return _sa().Integer(min(self.rank_weight_of_vector(c) for c in self if not c.is_zero()))


# ------------------------------------------------------------- the catalog

class _Codes:
    """The catalog of codes (codes.HammingCode, ...)."""

    def __init__(self):
        self.HammingCode = HammingCode
        self.GolayCode = GolayCode
        self.GeneralizedReedSolomonCode = GeneralizedReedSolomonCode
        self.LinearRankMetricCode = LinearRankMetricCode
        self.random_linear_code = random_linear_code
        self.LinearCode = LinearCode

    def ReedSolomonCode(self, base_field, length, dimension, primitive_root=None):
        """The Reed-Solomon code (GRS with multipliers 1) on the first n elements.

        EXAMPLES::

            sage: codes.ReedSolomonCode(GF(7), 6, 3)
            [6, 3, 4] Reed-Solomon Code over GF(7)
        """
        F = base_field
        if int(length) > int(F.order()):
            raise ValueError("the length must be at most the size of the field (%d)" % F.order())
        return GeneralizedReedSolomonCode(_elements(F)[:int(length)], dimension)

    def __repr__(self):
        return "The catalog of codes"


codes = _Codes()


# -------------------------------------- shift registers and Berlekamp-Massey

def lfsr_sequence(key, fill, n):
    """The first n terms of the LFSR sequence s_{i+k} = sum key_j s_{i+j}.

    EXAMPLES::

        sage: F = GF(2); o = F(0); l = F(1); key = [l,o,o,l]; fill = [l,l,o,l]
        sage: lfsr_sequence(key, fill, 20)
        [1, 1, 0, 1, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 1, 1, 1, 0, 1, 0]
    """
    k = len(fill)
    s = list(fill)
    while len(s) < int(n):
        t = key[0] * s[-k]
        for j in range(1, k):
            t = t + key[j] * s[-k + j]
        s.append(t)
    return s[:int(n)]


def lfsr_autocorrelation(L, p, k):
    """The autocorrelation (1/p) sum_{i<p} L_i L_{i+k} (indices mod p).

    EXAMPLES::

        sage: F = GF(2); s = lfsr_sequence([F(1),F(0),F(0),F(1)], [F(1),F(1),F(0),F(1)], 20)
        sage: lfsr_autocorrelation(s, 15, 7), lfsr_autocorrelation(s, 15, 0)
        (4/15, 8/15)
    """
    p, k = int(p), int(k)
    from fractions import Fraction
    tot = sum(int(L[i]) * int(L[(i + k) % p]) for i in range(p))
    return _sa()._q(Fraction(tot, p))


def berlekamp_massey(a):
    """The minimal polynomial of a linear recurrence sequence.

    EXAMPLES::

        sage: from sage.matrix.berlekamp_massey import berlekamp_massey
        sage: F = GF(2); s = lfsr_sequence([F(1),F(0),F(0),F(1)], [F(1),F(1),F(0),F(1)], 20); berlekamp_massey(s)
        x^4 + x^3 + 1
    """
    a = list(a)
    F = a[0].parent()
    C = _connection(a, F)
    R = _sa().PolynomialRing(F, "x")
    L = len(C) - 1
    # the reciprocal of the connection polynomial
    return R(list(reversed(C + [F(0)] * (L + 1 - len(C)))))


def _connection(s, F):
    """The connection polynomial (Berlekamp-Massey), as coefficients."""
    zero, one = F(0), F(1)
    C, B = [one], [one]
    L, m, b = 0, 1, one
    for n in range(len(s)):
        d = s[n]
        for i in range(1, L + 1):
            if i < len(C):
                d = d + C[i] * s[n - i]
        if d == 0:
            m += 1
            continue
        T = list(C)
        coef = d / b
        shifted = [zero] * m + B
        C = C + [zero] * max(0, len(shifted) - len(C))
        for i, x in enumerate(shifted):
            C[i] = C[i] - coef * x
        if 2 * L <= n:
            L = n + 1 - L
            B, b, m = T, d, 1
        else:
            m += 1
    C = C[:L + 1] + [zero] * max(0, L + 1 - len(C))
    return C


def lfsr_connection_polynomial(s):
    """The connection polynomial of a sequence (Berlekamp-Massey).

    EXAMPLES::

        sage: F = GF(2); s = lfsr_sequence([F(1),F(0),F(0),F(1)], [F(1),F(1),F(0),F(1)], 20); lfsr_connection_polynomial(s)
        x^4 + x + 1
    """
    s = list(s)
    F = s[0].parent()
    C = _connection(s, F)
    return _sa().PolynomialRing(F, "x")(C)


class IndexedSequence:
    """A sequence with an index set.

    EXAMPLES::

        sage: IndexedSequence([1, 2, 3], range(3))
        Indexed sequence: [1, 2, 3]
            indexed by range(0, 3)
    """

    def __init__(self, L, index_object):
        self._L, self._J = list(L), index_object

    def __repr__(self):
        return "Indexed sequence: %s\n    indexed by %s" % (self._L, self._J)

    def list(self):
        """The values.

        EXAMPLES::

            sage: IndexedSequence([1, 2, 3], range(3)).list()
            [1, 2, 3]
        """
        return list(self._L)

    def index_object(self):
        """The index set.

        EXAMPLES::

            sage: IndexedSequence([1, 2, 3], range(3)).index_object()
            range(0, 3)
        """
        return self._J

    def plot_histogram(self, clr=(0, 0, 1), eps=0.4):
        """A bar chart of the values.

        EXAMPLES::

            sage: IndexedSequence([1, 2, 3], range(3)).plot_histogram()
            Graphics object consisting of 6 graphics primitives
        """
        sa = _sa()
        g = sa.Graphics()
        for i, v in zip(list(self._J), self._L):
            x = float(i)
            pts = [(x - eps, 0), (x - eps, float(v)), (x + eps, float(v)), (x + eps, 0)]
            g += sa.polygon(pts, rgbcolor=clr)
            g += sa.line(pts + [pts[0]], rgbcolor=(0, 0, 0))
        return g


# ------------------------------------------------------------ cryptosystems

class AlphabeticStringMonoid:
    """The free monoid on the letters A-Z.

    EXAMPLES::

        sage: S = AlphabeticStrings(); S
        Free alphabetic string monoid on A-Z
    """

    def __repr__(self):
        return "Free alphabetic string monoid on A-Z"

    def __call__(self, x):
        """A string (from text or a list of integers).

        EXAMPLES::

            sage: S = AlphabeticStrings(); S('HELLOWORLD'), S([7, 4, 11, 11, 14])
            (HELLOWORLD, HELLO)
        """
        if isinstance(x, AlphabeticString):
            return x
        if isinstance(x, str):
            # the letters A-Z only (other characters, including non-ASCII
            # letters, are dropped)
            return AlphabeticString(self, "".join(c for c in x.upper() if "A" <= c <= "Z"))
        import operator
        out = []
        for i in x:
            try:
                k = operator.index(i)
            except TypeError:
                raise TypeError("letter indices must be integers, not %r" % (i,))
            if not 0 <= k < 26:
                raise ValueError("letter indices must be in 0..25, not %d" % k)
            out.append(chr(65 + k))
        return AlphabeticString(self, "".join(out))

    def ngens(self):
        """The number of letters.

        EXAMPLES::

            sage: S = AlphabeticStrings(); S.ngens()
            26
        """
        return _sa().Integer(26)

    def gens(self):
        """The letters.

        EXAMPLES::

            sage: S = AlphabeticStrings(); S.gens()[:3]
            (A, B, C)
        """
        return tuple(AlphabeticString(self, chr(65 + i)) for i in range(26))

    def __eq__(self, other):
        return isinstance(other, AlphabeticStringMonoid)

    def __hash__(self):
        return hash("AlphabeticStrings")


def AlphabeticStrings():
    """The monoid of strings on A-Z.

    EXAMPLES::

        sage: S = AlphabeticStrings(); S, S("THECAT")
        (Free alphabetic string monoid on A-Z, THECAT)
    """
    return AlphabeticStringMonoid()


class AlphabeticString:
    """

    EXAMPLES::

        sage: S = AlphabeticStrings(); m = S('THECAT'); m, len(m), m * m
        (THECAT, 6, THECATTHECAT)
    """
    def __init__(self, P, s):
        self._P, self._s = P, s

    def __repr__(self):
        return self._s

    def __str__(self):
        return self._s

    def __len__(self):
        return len(self._s)

    def __eq__(self, other):
        return isinstance(other, AlphabeticString) and self._s == other._s

    def __hash__(self):
        return hash(self._s)

    def __mul__(self, other):
        return AlphabeticString(self._P, self._s + other._s)

    def __getitem__(self, i):
        return AlphabeticString(self._P, self._s[i])

    def parent(self):
        """The monoid.

        EXAMPLES::

            sage: S = AlphabeticStrings(); S('AB').parent()
            Free alphabetic string monoid on A-Z
        """
        return self._P


class SubstitutionCryptosystem:
    """Monoalphabetic substitution: a key is a permutation of the alphabet
    (a string of the 26 letters).

    EXAMPLES::

        sage: S = AlphabeticStrings(); E = SubstitutionCryptosystem(S); e = E(S([25 - i for i in range(26)]))
        sage: e(S("THECATINTHEHAT"))
        GSVXZGRMGSVSZG
    """

    def __init__(self, S):
        self._S = S

    def __repr__(self):
        return "Substitution cryptosystem on %s" % (self._S,)

    def __call__(self, K):
        """The cipher of a key.

        EXAMPLES::

            sage: S = AlphabeticStrings(); E = SubstitutionCryptosystem(S); E(S([25 - i for i in range(26)]))
            Substitution cipher on Free alphabetic string monoid on A-Z
        """
        if sorted(K._s) != [chr(65 + i) for i in range(26)]:
            raise ValueError("a substitution key must be a permutation of the 26 letters")
        return _Cipher(self, lambda m: AlphabeticString(self._S, "".join(K._s[ord(c) - 65] for c in m._s)), "Substitution cipher on %s" % (self._S,))

    def key_space(self):
        """The key space.

        EXAMPLES::

            sage: S = AlphabeticStrings(); SubstitutionCryptosystem(S).key_space()
            Free alphabetic string monoid on A-Z
        """
        return self._S

    def plaintext_space(self):
        """The plaintext space.

        EXAMPLES::

            sage: S = AlphabeticStrings(); SubstitutionCryptosystem(S).plaintext_space()
            Free alphabetic string monoid on A-Z
        """
        return self._S

    def ciphertext_space(self):
        """The ciphertext space.

        EXAMPLES::

            sage: S = AlphabeticStrings(); SubstitutionCryptosystem(S).ciphertext_space()
            Free alphabetic string monoid on A-Z
        """
        return self._S


class TranspositionCryptosystem:
    """Block transposition: a key is a permutation of the positions of a
    block.

    EXAMPLES::

        sage: S = AlphabeticStrings(); E = TranspositionCryptosystem(S, 3); g = E.key_space()([3, 2, 1])
        sage: E(g)(S("THECAT"))
        EHTTAC
    """

    def __init__(self, S, n):
        import operator
        try:
            n = operator.index(n)
        except TypeError:
            raise TypeError("the block length must be an integer, not %r" % (n,))
        if n < 1:
            raise ValueError("the block length must be positive")
        self._S, self._n = S, n

    def __repr__(self):
        return "Transposition cryptosystem on %s of block length %d" % (self._S, self._n)

    def key_space(self):
        """The symmetric group on the positions of a block.

        EXAMPLES::

            sage: TranspositionCryptosystem(AlphabeticStrings(), 15).key_space()
            Symmetric group of order 15! as a permutation group
        """
        return _sa().SymmetricGroup(self._n)

    def block_length(self):
        """The block length.

        EXAMPLES::

            sage: S = AlphabeticStrings(); TranspositionCryptosystem(S, 15).block_length()
            15
        """
        return _sa().Integer(self._n)

    def __call__(self, g):
        """The cipher of a key.

        EXAMPLES::

            sage: S = AlphabeticStrings(); E = TranspositionCryptosystem(S, 3); E(E.key_space()([2, 3, 1]))
            Cipher on Free alphabetic string monoid on A-Z
        """
        n = self._n
        img = [int(g(i + 1)) for i in range(n)]
        if sorted(img) != list(range(1, n + 1)):
            raise ValueError("a transposition key must be a permutation of 1..%d" % n)

        def f(m):
            s = m._s
            if len(s) % n:
                raise ValueError("the message length must be a multiple of the block length %d" % n)
            out = []
            for b in range(0, len(s), n):
                blk = s[b:b + n]
                out.append("".join(blk[img[i] - 1] for i in range(n)))
            return AlphabeticString(self._S, "".join(out))
        return _Cipher(self, f, "Cipher on %s" % (self._S,))


class _Cipher:
    def __init__(self, E, f, name):
        self._E, self._f, self._name = E, f, name

    def __repr__(self):
        return self._name

    def __call__(self, m):
        """Encipher.

        EXAMPLES::

            sage: S = AlphabeticStrings(); E = TranspositionCryptosystem(S, 3); e = E(E.key_space()([2, 3, 1])); e(S('ABCDEF'))
            BCAEFD
        """
        return self._f(m)

    def parent(self):
        """The cryptosystem.

        EXAMPLES::

            sage: S = AlphabeticStrings(); E = TranspositionCryptosystem(S, 3); E(E.key_space()([2, 3, 1])).parent()
            Transposition cryptosystem on Free alphabetic string monoid on A-Z of block length 3
        """
        return self._E
