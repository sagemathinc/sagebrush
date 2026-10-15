"""The Magma front end's intrinsics for search: every intrinsic Magma code
can call in Sagebrush's Magma mode (lib/_magma.py), with a signature made
from Sagebrush's own function and a one-line summary written for
Sagebrush, as JSON entries in the form of lib/_pyjs_docsearch.py's index.

    sagebrush -m _magma_docsearch --index    (web/build.ts: docs-index-magma.json)
    sagebrush --search "class group" --mode magma

No text here comes from Magma's documentation: the names are the
intrinsics' names, and the summaries and areas are Sagebrush's own.  Every
name lib/_magma.py binds is either in TABLE or in INTERNAL (test/docsearch
checks it), so a new intrinsic needs a summary to be found.
"""

import json as _json
import sys as _sys

# name -> (areas, summary), written for Sagebrush
TABLE = {
    # structures and types
    "Integers": (["structures"], "The ring of integers."),
    "IntegerRing": (["structures"], "The ring of integers (the same as Integers())."),
    "Rationals": (["structures", "rationals and reals"], "The field of rational numbers."),
    "RationalField": (["structures", "rationals and reals"], "The field of rational numbers (the same as Rationals())."),
    "RealField": (["rationals and reals"], "The real numbers to a given number of significant digits (30 by default)."),
    "Parent": (["structures"], "The structure an object belongs to."),
    "Type": (["structures"], "The category of an object, such as RngIntElt or SeqEnum."),
    "AssignNames": (["structures"], "Gives names to the generators of a structure, for printing."),
    # integers
    "IsPrime": (["integers"], "Whether an integer is prime."),
    "IsProbablePrime": (["integers"], "Whether an integer passes probable-prime tests."),
    "NextPrime": (["integers"], "The least prime greater than n."),
    "PreviousPrime": (["integers"], "The greatest prime less than n."),
    "PrimesUpTo": (["integers"], "The primes up to n, as a sequence."),
    "PrimesInInterval": (["integers"], "The primes in an interval [a, b]."),
    "NthPrime": (["integers"], "The n-th prime."),
    "PrimeDivisors": (["integers"], "The distinct primes dividing n, in increasing order."),
    "Divisors": (["integers"], "The positive divisors of n, in increasing order."),
    "NumberOfDivisors": (["integers"], "The number of positive divisors of n."),
    "SumOfDivisors": (["integers"], "The sum of the positive divisors of n."),
    "DivisorSigma": (["integers"], "The sum of the k-th powers of the divisors of n."),
    "EulerPhi": (["integers"], "Euler's totient function: the number of units modulo n."),
    "MoebiusMu": (["integers"], "The Moebius function of n."),
    "IsPrimePower": (["integers"], "Whether n is a prime power (and the prime and exponent)."),
    "Factorization": (["integers", "polynomials"], "The factorization of an integer or a polynomial, as a sequence of <factor, exponent> pairs."),
    "Factorisation": (["integers", "polynomials"], "The same as Factorization."),
    "Gcd": (["integers", "polynomials"], "The greatest common divisor of integers or polynomials."),
    "GCD": (["integers", "polynomials"], "The same as Gcd."),
    "GreatestCommonDivisor": (["integers", "polynomials"], "The same as Gcd."),
    "Lcm": (["integers"], "The least common multiple of integers."),
    "LCM": (["integers"], "The same as Lcm."),
    "LeastCommonMultiple": (["integers"], "The same as Lcm."),
    "Xgcd": (["integers"], "The gcd g of a and b with x and y such that a*x + b*y = g."),
    "XGCD": (["integers"], "The same as Xgcd."),
    "ExtendedGreatestCommonDivisor": (["integers"], "The same as Xgcd."),
    "Quotrem": (["integers"], "The quotient and remainder of integer division."),
    "Modexp": (["integers"], "a^k modulo m."),
    "Modinv": (["integers"], "The inverse of a modulo m."),
    "InverseMod": (["integers"], "The same as Modinv."),
    "Binomial": (["integers"], "The binomial coefficient n choose k."),
    "Factorial": (["integers"], "n factorial."),
    "Fibonacci": (["integers"], "The n-th Fibonacci number."),
    "IsSquare": (["integers", "rationals and reals"], "Whether a number is a square (and a square root)."),
    "Isqrt": (["integers"], "The integer part of the square root of n."),
    "IsEven": (["integers"], "Whether an integer is even."),
    "IsOdd": (["integers"], "Whether an integer is odd."),
    "Valuation": (["integers"], "The exponent of the prime p in n."),
    "Intseq": (["integers"], "The digits of n in a base (10 by default), least significant first."),
    "Seqint": (["integers"], "The integer with given digits in a base (the inverse of Intseq)."),
    "ChineseRemainderTheorem": (["integers"], "The integer congruent to given residues modulo given moduli."),
    "CRT": (["integers"], "The same as ChineseRemainderTheorem."),
    # numbers in general
    "IsZero": (["integers", "rationals and reals"], "Whether x is zero."),
    "IsOne": (["integers", "rationals and reals"], "Whether x is one."),
    "IsUnit": (["integers", "rationals and reals"], "Whether x is a unit of its ring."),
    "Abs": (["integers", "rationals and reals"], "The absolute value."),
    "Sign": (["integers", "rationals and reals"], "The sign: -1, 0 or 1."),
    "Floor": (["rationals and reals"], "The greatest integer at most x."),
    "Ceiling": (["rationals and reals"], "The least integer at least x."),
    "Round": (["rationals and reals"], "The nearest integer to x."),
    "Truncate": (["rationals and reals"], "The integer part of x, rounded toward zero."),
    "Numerator": (["rationals and reals"], "The numerator of a rational number."),
    "Denominator": (["rationals and reals"], "The denominator of a rational number."),
    "Sqrt": (["rationals and reals"], "The square root of a real number."),
    "Exp": (["rationals and reals"], "The exponential function."),
    "Log": (["rationals and reals"], "The natural logarithm, or the logarithm to a given base."),
    "Pi": (["rationals and reals"], "The number pi, to the precision of a real field."),
    "Max": (["integers", "rationals and reals", "sequences and sets"], "The largest of its arguments."),
    "Min": (["integers", "rationals and reals", "sequences and sets"], "The smallest of its arguments."),
    "Maximum": (["sequences and sets"], "The largest element of a sequence (and its position)."),
    "Minimum": (["sequences and sets"], "The smallest element of a sequence (and its position)."),
    # strings and printing
    "IntegerToString": (["strings and printing"], "An integer written as a string, in a base (10 by default)."),
    "StringToInteger": (["strings and printing"], "The integer a string of digits stands for."),
    "Sprint": (["strings and printing"], "The string Magma would print for a value."),
    "Sprintf": (["strings and printing"], "A string formatted from a format string and values."),
    # sequences and sets
    "Append": (["sequences and sets"], "A sequence with one more element at the end."),
    "Include": (["sequences and sets"], "A set or sequence with an element added (if not already there)."),
    "Exclude": (["sequences and sets"], "A set or sequence with an element removed."),
    "Remove": (["sequences and sets"], "A sequence without its i-th element."),
    "Insert": (["sequences and sets"], "A sequence with an element inserted at position i."),
    "Reverse": (["sequences and sets"], "A sequence in reverse order."),
    "Sort": (["sequences and sets"], "A sequence in increasing order, or by a comparison function."),
    "Index": (["sequences and sets"], "The first position of an element in a sequence (0 if absent)."),
    "Position": (["sequences and sets"], "The same as Index."),
    "IsEmpty": (["sequences and sets"], "Whether a set or sequence is empty."),
    "Seqset": (["sequences and sets"], "The set of the elements of a sequence."),
    "SetToSequence": (["sequences and sets"], "The elements of a set as a sequence."),
    "Setseq": (["sequences and sets"], "The same as SetToSequence."),
    "SequenceToSet": (["sequences and sets"], "The same as Seqset."),
    "Set": (["sequences and sets"], "The set of the elements of a sequence or other collection."),
    "Eltseq": (["sequences and sets", "polynomials"], "The sequence of an object's coefficients or elements."),
    "Sum": (["sequences and sets"], "The sum of the elements of a sequence."),
    "Universe": (["sequences and sets"], "The structure containing the elements of a set or sequence."),
    "Random": (["sequences and sets"], "A random element of a set, sequence or structure."),
    # records
    "Names": (["records"], "The field names of a record format or a record."),
    "Format": (["records"], "The format of a record."),
    # polynomials
    "PolynomialRing": (["polynomials"], "A polynomial ring over a ring."),
    "Degree": (["polynomials"], "The degree of a polynomial."),
    "Coefficients": (["polynomials"], "The coefficients of a polynomial, constant term first."),
    "Coefficient": (["polynomials"], "The coefficient of x^i in a polynomial."),
    "LeadingCoefficient": (["polynomials"], "The coefficient of the highest power."),
    "Evaluate": (["polynomials"], "A polynomial's value at a point."),
    "Derivative": (["polynomials"], "The derivative of a polynomial."),
    "Discriminant": (["polynomials", "elliptic curves"], "The discriminant of a polynomial or an elliptic curve."),
    "Resultant": (["polynomials"], "The resultant of two polynomials."),
    "IsIrreducible": (["polynomials"], "Whether a polynomial is irreducible."),
    "Roots": (["polynomials"], "The roots of a polynomial with their multiplicities."),
    # modular forms and modular symbols
    "Gamma0": (["modular forms"], "The congruence subgroup Gamma_0(N)."),
    "ModularSymbols": (["modular forms"], "A space of modular symbols of level N, weight k and sign."),
    "Dimension": (["modular forms"], "The dimension of a space of modular symbols or modular forms."),
    "CuspidalSubspace": (["modular forms"], "The cuspidal part of a space of modular symbols."),
    "NewSubspace": (["modular forms"], "The new part of a space of modular symbols."),
    "HeckePolynomial": (["modular forms"], "The characteristic polynomial of the Hecke operator T_p on a space."),
    "HeckeOperator": (["modular forms"], "The Hecke operator T_p on a space of modular symbols."),
    "CharacteristicPolynomial": (["modular forms", "matrices"], "The characteristic polynomial of an operator."),
    "NewformDecomposition": (["modular forms"], "A space of modular symbols split into Galois orbits of newforms."),
    "DimensionCuspFormsGamma0": (["modular forms"], "The dimension of the cusp forms of level N and weight k."),
    "DimensionNewCuspFormsGamma0": (["modular forms"], "The dimension of the new cusp forms of level N and weight k."),
    "DimensionModularFormsGamma0": (["modular forms"], "The dimension of the modular forms of level N and weight k."),
    "CuspForms": (["modular forms"], "The space of cusp forms of level N and weight k."),
    "ModularForms": (["modular forms"], "The space of modular forms of level N and weight k."),
    "Newforms": (["modular forms"], "The newforms of a space of cusp forms, by Galois orbit."),
    "qExpansion": (["modular forms"], "The q-expansion of a modular form to a precision."),
    # elliptic curves
    "EllipticCurve": (["elliptic curves"], "An elliptic curve from its a-invariants or a Cremona label."),
    "TraceOfFrobenius": (["elliptic curves"], "a_p: p + 1 minus the number of points modulo p."),
    "Conductor": (["elliptic curves"], "The conductor of an elliptic curve over Q."),
    "aInvariants": (["elliptic curves"], "The a-invariants [a1, a2, a3, a4, a6] of an elliptic curve."),
    "jInvariant": (["elliptic curves"], "The j-invariant of an elliptic curve."),
    "CremonaReference": (["elliptic curves"], "The Cremona label of an elliptic curve over Q."),
    "TorsionSubgroup": (["elliptic curves"], "The torsion subgroup of the rational points of an elliptic curve."),
    "Rank": (["elliptic curves", "matrices"], "The rank of an elliptic curve or a matrix."),
    # number fields
    "NumberField": (["number fields"], "The number field defined by an irreducible polynomial."),
    "QuadraticField": (["number fields"], "The quadratic field Q(sqrt(d))."),
    "MaximalOrder": (["number fields"], "The ring of integers of a number field."),
    "RingOfIntegers": (["number fields"], "The same as MaximalOrder."),
    "Signature": (["number fields"], "The numbers of real and complex places of a number field."),
    "IntegralBasis": (["number fields"], "A basis of the ring of integers over Z."),
    "ClassNumber": (["number fields"], "The class number of a number field."),
    "ClassGroup": (["number fields"], "The class group of a number field, with its map to ideals."),
    "UnitGroup": (["number fields"], "The unit group of a number field, with its map to units."),
    "Regulator": (["number fields"], "The regulator of a number field."),
    "UnitRank": (["number fields"], "The rank of the unit group of a number field."),
    "Decomposition": (["number fields"], "How a prime splits in a ring of integers: the primes above it."),
    "Norm": (["number fields"], "The norm of an element of a number field."),
    "Trace": (["number fields"], "The trace of an element of a number field."),
    "MinimalPolynomial": (["number fields"], "The minimal polynomial of an algebraic number."),
    # matrices
    "Matrix": (["matrices"], "A matrix from rows or from a size and entries."),
    "HermiteForm": (["matrices"], "The Hermite normal form of an integer matrix."),
    "EchelonForm": (["matrices"], "The echelon form of a matrix."),
    "SmithForm": (["matrices"], "The Smith normal form of an integer matrix."),
    "ElementaryDivisors": (["matrices"], "The elementary divisors of an integer matrix."),
    "LLL": (["matrices"], "An LLL-reduced basis of the lattice spanned by a matrix's rows."),
    "Determinant": (["matrices"], "The determinant of a square matrix."),
    "Transpose": (["matrices"], "The transpose of a matrix."),
    "NumberOfRows": (["matrices"], "The number of rows of a matrix."),
    "NumberOfColumns": (["matrices"], "The number of columns of a matrix."),
    "Nrows": (["matrices"], "The same as NumberOfRows."),
    "Ncols": (["matrices"], "The same as NumberOfColumns."),
    "Domain": (["maps"], "The domain of a map."),
    "Codomain": (["maps"], "The codomain of a map."),
    "Image": (["maps"], "The set of images of a map given by its graph."),
    "Inverse": (["maps"], "The inverse of a map given by a rule; applying it needs an inverse rule."),
}

# names lib/_magma.py exports that are not Magma intrinsics (its classes
# and internal aliases)
INTERNAL = {"MagmaError", "Multi", "Ref1", "RefK", "MSeq", "MRange", "MSet", "MTuple", "MRecFormat", "MRec",
            "MReal", "RealField_", "Perm", "MGamma0", "MModSym", "MModForms", "MNewform", "MList", "IntegerRing_", "MMap"}

# Magma's syntax that Sagebrush's Magma mode runs, by area (Sagebrush's words)
LANGUAGE = [
    ("statements", "assignment :=, op:= forms, if/elif/else, for (in a set or a range), while, repeat/until, case/when, break, continue"),
    ("functions", "function/procedure definitions and expressions, func< >, ~x reference arguments, $$ recursion, several return values"),
    ("expressions", "select ... else, comprehensions [ e : x in S | P ], ranges [a..b by c], &+ and other reductions, cat, join, meet, diff"),
    ("collections", "sequences (1-based, value semantics), sets, indexed sets, multisets, tuples, lists [* *]"),
    ("records", "recformat< ... >, rec< F | ... >, fields r`f and r``s, assigned, delete"),
    ("errors and output", "print, printf, error, assert. In a file, a statement Magma rejects before running it (an undeclared identifier, for example) "
     "is reported and the next one runs, and a runtime or syntax error stops the file; standard input (a session) reports every error and goes on; "
     "a notebook cell stops at its first error"),
    ("maps", "map< A -> B | x :-> e >, pmap< >, hom< > by a rule (with an inverse rule), a graph of pairs or arrows; f(x), x @ f, y @@ f, composition f * g"),
    ("constructors", "name< ... >: those not implemented yet raise a clear error"),
]


def _magma_signature(name, f):
    """name(x, y [, z] : Param): from the parameters of Sagebrush's own
    function (optional positional arguments in brackets; capitalized ones
    with defaults are Magma's named parameters)."""
    from _pyjs_help import signature
    try:
        sig = signature(f) or ""
    except Exception:
        sig = ""
    if not (sig.startswith("(") and sig.endswith(")")):
        return name + "(...)"
    req, opt, named = [], [], []
    for p in [x.strip() for x in sig[1:-1].split(",") if x.strip()]:
        if p.startswith("**") or p in ("/", "*"):
            continue
        if p.startswith("*"):
            req.append("...")
            continue
        pname, eq, _ = p.partition("=")
        pname = pname.split(":")[0].strip()
        if not eq:
            req.append(pname)
        elif pname[:1].isupper() and pname != "R":
            named.append(pname)
        else:
            opt.append(pname)
    s = name + "(" + ", ".join(req)
    if opt:
        s += (" [, " if req else "[") + ", ".join(opt) + "]"
    if named:
        s += " : " + ", ".join(named)
    return s + ")"


def bound_names():
    """The intrinsics lib/_magma.py binds (its exports, but not its
    categories nor its internal classes)."""
    import _magma
    return [n for n in _magma.__all__ if not isinstance(getattr(_magma, n), str) and n not in INTERNAL]


def build_index():
    """[{name, module, kind, signature, summary, doc, examples, open_problem,
    language, areas}] for Magma mode's intrinsics, by name."""
    import _magma
    out = []
    for name in sorted(bound_names(), key=str.lower):
        if name not in TABLE:
            continue  # (test/docsearch fails for these)
        areas, summary = TABLE[name]
        out.append({
            "name": name,
            "module": "magma",
            "kind": "function",
            "signature": _magma_signature(name, getattr(_magma, name))[len(name):],
            "summary": summary,
            "doc": summary,
            "examples": 0,
            "open_problem": False,
            "language": "magma",
            "areas": areas,
        })
    return out


def check():
    """Names bound but not in TABLE (they need a summary), and names in
    TABLE that are not bound."""
    bound = set(bound_names())
    return sorted(bound - set(TABLE)), sorted(set(TABLE) - bound)


def main(argv):
    if "--index" in argv:
        print(_json.dumps(build_index(), separators=(",", ":")))
        return 0
    if "--check" in argv:
        missing, extra = check()
        print(_json.dumps({"missing": missing, "extra": extra}))
        return 1 if missing or extra else 0
    print("usage: sagebrush -m _magma_docsearch --index | --check")
    return 2


if __name__ == "__main__":
    _sys.exit(main(_sys.argv[1:]))
