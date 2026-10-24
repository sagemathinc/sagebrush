"""The Magma front end's intrinsics for search: every intrinsic Magma code
can call in Sagebrush's Magma mode (lib/_magma.py), with a signature made
from Sagebrush's own function and a one-line summary written for
Sagebrush, as JSON entries in the form of lib/_pyjs_docsearch.py's index.

    sagebrush -m _magma_docsearch --index    (web/build.ts: docs-index-magma.json)
    sagebrush --search "class group" --mode magma

No text here comes from Magma's documentation: the names are the
intrinsics' names, and the summaries, areas and examples are Sagebrush's
own.  Every name lib/_magma.py binds is either in TABLE, with an example in
EXAMPLES, or in INTERNAL (test/docsearch checks it), so a new intrinsic
needs a summary and an example to be found.
"""

import json as _json
import sys as _sys

# name -> (areas, summary), written for Sagebrush
TABLE = {
    "Vector": (["matrices"], "A row vector over the integers or the rationals, which a matrix multiplies on the right."),
    "Solution": (["matrices"], "The vector v with v * A = w, for a matrix A and a vector w."),
    "VectorSpace": (["matrices"], "The full vector space of degree n over the rationals; V.i is its i-th unit vector, V![...] a vector."),
    "KSpace": (["matrices"], "The full vector space of degree n over the rationals (the same as VectorSpace)."),
    "RSpace": (["matrices"], "The full space of row vectors of degree n over the integers (or over the rationals)."),
    "Generators": (["matrices"], "The set of the unit vectors of a full vector space."),
    "Zero": (["structures"], "The zero of the integers, the rationals or a full vector space."),
    "Submatrix": (["matrices"], "A block of a matrix, by its top left entry and its size."),
    "Subsets": (["sequences and sets"], "The set of the subsets of a set, or of those of a given size."),
    "Sym": (["structures"], "The symmetric group on 1 .. n, whose elements are permutations."),
    "DihedralGroup": (["structures"], "The dihedral group of order 2n as permutations of 1 .. n."),
    "IsIsomorphic": (["structures"], "Whether two quadratic fields, or the symmetric and dihedral groups, are isomorphic (the isomorphism itself is not given)."),
    "Identity": (["structures"], "The identity element of a group."),
    # structures and types
    "Integers": (["structures"], "The ring of integers; Integers(m), the integers modulo m; Integers(K), a number field's maximal order."),
    "IntegerRing": (["structures"], "The ring of integers (the same as Integers())."),
    "Rationals": (["structures", "rationals and reals"], "The field of rational numbers."),
    "RationalField": (["structures", "rationals and reals"], "The field of rational numbers (the same as Rationals())."),
    "RealField": (["rationals and reals"], "The real numbers to a given number of significant digits (30 by default)."),
    "Parent": (["structures"], "The structure an object belongs to."),
    "Type": (["structures"], "The category of an object, such as RngIntElt or SeqEnum."),
    "ISA": (["structures"], "Whether one type is also another, as a square matrix (AlgMatElt) is a matrix (MtrxS)."),
    "AssignNames": (["structures"], "Gives names to the generators of a structure, for printing."),
    # integers
    "IsPrime": (["integers"], "Whether an integer is prime."),
    "IsProbablePrime": (["integers"], "Whether an integer passes probable-prime tests."),
    "NextPrime": (["integers"], "The least prime greater than n."),
    "PreviousPrime": (["integers"], "The greatest prime less than n."),
    "PrimesUpTo": (["integers"], "The primes up to n, as a sequence."),
    "PrimesInInterval": (["integers"], "The primes in an interval [a, b]."),
    "NthPrime": (["integers"], "The n-th prime number, counting 2 as the first."),
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
    "GCD": (["integers", "polynomials"], "The greatest common divisor of two integers or polynomials, or of a sequence of them: the same as Gcd."),
    "GreatestCommonDivisor": (["integers", "polynomials"], "The greatest common divisor of two integers or polynomials, or of a sequence of them: the same as Gcd."),
    "Lcm": (["integers"], "The least common multiple of integers."),
    "LCM": (["integers"], "The least common multiple of two integers or of a sequence of them: the same as Lcm."),
    "LeastCommonMultiple": (["integers"], "The least common multiple of two integers or of a sequence of them: the same as Lcm."),
    "Xgcd": (["integers"], "The gcd g of a and b with x and y such that a*x + b*y = g."),
    "XGCD": (["integers"], "The gcd g of a and b with s and t such that s*a + t*b = g: the same as Xgcd."),
    "ExtendedGreatestCommonDivisor": (["integers"], "The gcd g of a and b with s and t such that s*a + t*b = g: the same as Xgcd."),
    "Quotrem": (["integers"], "The quotient and remainder of integer division."),
    "Modexp": (["integers"], "a^k reduced modulo m, computed without forming a^k itself."),
    "Modinv": (["integers"], "The inverse of a modulo m."),
    "InverseMod": (["integers"], "The same as Modinv."),
    "Binomial": (["integers"], "The binomial coefficient n choose k."),
    "Factorial": (["integers"], "The factorial n! = 1 * 2 * ... * n of a non-negative integer n."),
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
    # rational function fields (R0a)
    "FunctionField": (["function fields"], "The univariate rational function field over a supported constant ring or field."),
    "RationalFunctionField": (["function fields"], "The univariate rational function field over a supported constant ring or field: the same as FunctionField."),
    "FieldOfFractions": (["function fields"], "The fraction field of a univariate polynomial ring over the integers, rationals or a prime field."),
    "FractionField": (["function fields"], "The same as FieldOfFractions (a Sagebrush compatibility alias)."),
    "BaseField": (["function fields"], "The constant field of a rational function field when its ground structure is a field."),
    "PartialFractionDecomposition": (["function fields"], "A rational function decomposed into partial fractions over its constant field."),
    "SquarefreePartialFractionDecomposition": (["function fields"], "A rational function decomposed by squarefree denominator factors."),
    # modular forms and modular symbols
    "Gamma0": (["modular forms"], "The congruence subgroup Gamma_0(N)."),
    "ModularSymbols": (["modular forms"], "A space of modular symbols of level N, weight k and sign."),
    "Dimension": (["modular forms"], "The dimension of a space of modular symbols or modular forms."),
    "CuspidalSubspace": (["modular forms"], "The cuspidal part of a space of modular symbols."),
    "NewSubspace": (["modular forms"], "The new part of a space of modular symbols."),
    "HeckePolynomial": (["modular forms"], "The characteristic polynomial of the Hecke operator T_p on a space."),
    "HeckeOperator": (["modular forms"], "The Hecke operator T_p on a space of modular symbols."),
    "CharacteristicPolynomial": (["modular forms", "matrices", "finite fields"], "The characteristic polynomial of an operator, a matrix, or a finite field element (optionally over a subfield)."),
    "NewformDecomposition": (["modular forms"], "A space of modular symbols split into Galois orbits of newforms."),
    "DimensionCuspFormsGamma0": (["modular forms"], "The dimension of the cusp forms of level N and weight k."),
    "DimensionNewCuspFormsGamma0": (["modular forms"], "The dimension of the new cusp forms of level N and weight k."),
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
    # finite fields
    "GF": (["finite fields"], "The finite field with q = p^n elements, GF(q) or GF(p, n), defined by the Conway polynomial."),
    "FiniteField": (["finite fields"], "The finite field with q elements: the same as GF(q) or GF(p, n)."),
    "GaloisField": (["finite fields"], "The finite field with q elements: the same as GF(q) or GF(p, n)."),
    "Characteristic": (["finite fields"], "The characteristic of a finite field."),
    "PrimitiveElement": (["finite fields"], "A generator of a finite field's multiplicative group."),
    "PrimeField": (["finite fields"], "The prime field GF(p) of a finite field."),
    "Generator": (["finite fields"], "The generator F.1 of a finite field over its prime field (1 for GF(p) itself)."),
    "ChangeRing": (["polynomials", "finite fields"], "A univariate polynomial ring, or one of its polynomials, over another ring: the integers, the rationals or a finite field."),
    "RootsInSplittingField": (["finite fields", "polynomials"], "The roots of a polynomial over a finite field in its splitting field, with multiplicities, and that field."),
    "DefiningPolynomial": (["finite fields"], "The defining (Conway) polynomial of a finite field, or the minimal polynomial of F.1 over a subfield."),
    "IsSubfield": (["finite fields"], "Whether one finite field is a subfield of another."),
    "Embed": (["finite fields"], "Checks that one finite field embeds in another (Sagebrush's finite fields are already embedded)."),
    "Root": (["finite fields"], "A k-th root of a finite field element, where it is determined."),
    "IsPrimitive": (["finite fields"], "Whether an element generates its finite field's multiplicative group."),
    "Order": (["finite fields"], "The multiplicative order of an element of a finite field."),
    # number fields
    "NumberField": (["number fields"], "The number field defined by an irreducible polynomial."),
    "QuadraticField": (["number fields"], "The quadratic field Q(sqrt(d))."),
    "MaximalOrder": (["number fields"], "The ring of integers of a number field."),
    "RingOfIntegers": (["number fields"], "The same as MaximalOrder."),
    "Signature": (["number fields"], "The numbers of real and complex places of a number field."),
    "IntegralBasis": (["number fields"], "A basis of the ring of integers over Z."),
    "ClassNumber": (["number fields"], "The class number of a number field."),
    "ClassGroup": (["number fields"], "The class group of a number field, with its map to ideals."),
    "CyclotomicField": (["number fields"], "The cyclotomic field Q(zeta_n), its generator printed zeta_n until named."),
    "Basis": (["number fields"], "The power basis 1, a, ..., a^(d-1) of a number field."),
    "BaseRing": (["polynomials", "matrices", "number fields"], "The ring a polynomial ring, matrix or number field is over."),
    "CoefficientRing": (["polynomials", "matrices", "number fields"], "The same as BaseRing, for a polynomial ring, matrix or number field."),
    "UnitGroup": (["number fields"], "The unit group of a number field, with its map to units."),
    "Regulator": (["number fields"], "The regulator of a number field."),
    "UnitRank": (["number fields"], "The rank of the unit group of a number field."),
    "Decomposition": (["number fields"], "How a prime splits in a ring of integers: the primes above it."),
    "Norm": (["number fields", "finite fields"], "The norm of an element of a number field, or of a finite field (optionally over a subfield)."),
    "Trace": (["number fields", "matrices"], "The trace of an element or of a square matrix, by the type of its argument."),
    "MinimalPolynomial": (["number fields", "finite fields"], "The minimal polynomial of an algebraic number, or of a finite field element (optionally over a subfield)."),
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

# name -> an example, written for Sagebrush: Magma input after the prompt
# "> ", each statement followed by the output Sagebrush prints for it.
# test/magma-examples.test.ts runs every one in a fresh Magma session and
# requires exactly this output; it also compares Magma 2.18's (recorded in
# test/magma-examples.json, made by scripts/magma-examples-table.py) and
# lists where the two differ.
EXAMPLES = {
    "Vector": """\
> Vector(Rationals(), [1, 2, 3]);
(1 2 3)""",
    "Solution": """\
> A := Matrix(Rationals(), 2, 2, [1, 2, 3, 4]);
> Solution(A, Vector(Rationals(), [4, 6]));
(1 1)""",
    "Submatrix": """\
> C := Matrix(Integers(), 3, 3, [1, 2, 3, 4, 5, 6, 7, 8, 9]);
> Submatrix(C, 2, 2, 2, 2);
[5 6]
[8 9]""",
    "Subsets": """\
> #Subsets({1, 2, 3, 4}, 2);
6""",
    "Sym": """\
> #Sym(4);
24""",
    "DihedralGroup": """\
> G := DihedralGroup(5);
> G.1^2;
(1, 3, 5, 2, 4)""",
    "IsIsomorphic": """\
> b := IsIsomorphic(QuadraticField(5), QuadraticField(45));
> b;
true""",
    "VectorSpace": """\
> V := VectorSpace(Rationals(), 3);
> V![1, 2, 3] + V.2;
(1 3 3)""",
    "KSpace": """\
> K := KSpace(Rationals(), 2);
> K;
Full Vector space of degree 2 over Rational Field""",
    "RSpace": """\
> W := RSpace(Integers(), 2);
> W.1 - 3*W.2;
( 1 -3)""",
    "Generators": """\
> V := VectorSpace(Rationals(), 3);
> #Generators(V);
3""",
    "Zero": """\
> Zero(RSpace(Integers(), 3));
(0 0 0)""",
    "Identity": """\
> G := Sym(3);
> Identity(G);
Id(G)""",
    "ISA": """\
> ISA(AlgMatElt, MtrxS);
true""",
    "GF": """\
> F<w> := GF(9);
> F;
Finite field of size 3^2
> w^4;
2
> #F, Characteristic(F);
9 3
> GF(7) ! 10;
3""",
    "FiniteField": """\
> FiniteField(7);
Finite field of size 7""",
    "GaloisField": """\
> GaloisField(2, 3);
Finite field of size 2^3""",
    "Characteristic": """\
> Characteristic(GF(25));
5""",
    "PrimitiveElement": """\
> PrimitiveElement(GF(7));
3""",
    "PrimeField": """\
> PrimeField(GF(16));
Finite field of size 2""",
    "Generator": """\
> F<a> := GF(16);
> Generator(F);
a
> Generator(GF(7));
1""",
    "ChangeRing": """\
> P<x> := PolynomialRing(Integers());
> ChangeRing(3*x^2 - x + 7, GF(5));
3*$.1^2 + 4*$.1 + 2""",
    "RootsInSplittingField": """\
> P<x> := PolynomialRing(GF(5));
> RootsInSplittingField(x^2 + 2);
[ <$.1^9, 1>, <$.1^21, 1> ]
Finite field of size 5^2""",
    "DefiningPolynomial": """\
> DefiningPolynomial(GF(16));
$.1^4 + $.1 + 1
> K<b> := GF(16); F<a> := GF(4);
> DefiningPolynomial(K, F);
$.1^2 + $.1 + a""",
    "IsSubfield": """\
> IsSubfield(GF(4), GF(16));
true
> IsSubfield(GF(8), GF(16));
false""",
    "Embed": """\
> Embed(GF(4), GF(16));
> GF(4).1 in GF(16);
true""",
    "Root": """\
> K<b> := GF(16);
> Root(b, 7);
b^13""",
    "IsPrimitive": """\
> IsPrimitive(GF(7)!3);
true""",
    "Order": """\
> Order(GF(7) ! 2);
3
> Order(GF(7) ! 3);
6
> F<w> := GF(16);
> Order(w);
15""",
    "Integers": """\
> Z := Integers();
> Z ! 17;
17
> Z ! (6/3);
2
> R := Integers(12);
> R ! 17;
5
> (R ! 5)^2;
1""",
    "IntegerRing": """\
> IntegerRing() eq Integers();
true""",
    "Rationals": """\
> Q := Rationals();
> Q ! (6/8);
3/4
> Parent(1/2) eq Q;
true
> Type(Q ! 3);
FldRatElt
> Q ! 2 eq 2;
true""",
    "RationalField": """\
> RationalField() eq Rationals();
true
> Type(RationalField() ! 3);
FldRatElt""",
    "RealField": """\
> R := RealField(10);
> R ! (2/7);
0.2857142857""",
    "Parent": """\
> Parent(5/3);
Rational Field
> Parent(5);
Integer Ring
> Parent(GF(7) ! 3);
Finite field of size 7
> P<x> := PolynomialRing(Integers());
> Parent(x^2);
Univariate Polynomial Ring in x over Integer Ring""",
    "Type": """\
> Type([1, 2]);
SeqEnum""",
    "AssignNames": """\
> P := PolynomialRing(Integers());
> AssignNames(~P, ["u"]);
> P.1^2 + 1;
u^2 + 1""",
    "IsPrime": """\
> IsPrime(101);
true
> IsPrime(91);
false""",
    "IsProbablePrime": """\
> IsProbablePrime(1009);
true""",
    "NextPrime": """\
> NextPrime(100);
101""",
    "PreviousPrime": """\
> PreviousPrime(100);
97""",
    "PrimesUpTo": """\
> PrimesUpTo(30);
[ 2, 3, 5, 7, 11, 13, 17, 19, 23, 29 ]""",
    "PrimesInInterval": """\
> PrimesInInterval(40, 60);
[ 41, 43, 47, 53, 59 ]""",
    "NthPrime": """\
> NthPrime(25);
97""",
    "PrimeDivisors": """\
> PrimeDivisors(360);
[ 2, 3, 5 ]""",
    "Divisors": """\
> Divisors(28);
[ 1, 2, 4, 7, 14, 28 ]""",
    "NumberOfDivisors": """\
> NumberOfDivisors(360);
24""",
    "SumOfDivisors": """\
> SumOfDivisors(28);
56""",
    "DivisorSigma": """\
> DivisorSigma(2, 6);
50""",
    "EulerPhi": """\
> EulerPhi(36);
12""",
    "MoebiusMu": """\
> MoebiusMu(30), MoebiusMu(12);
-1 0""",
    "IsPrimePower": """\
> IsPrimePower(243);
true 3 5""",
    "Factorization": """\
> Factorization(720);
[ <2, 4>, <3, 2>, <5, 1> ]
> Factorization(-12);
[ <2, 2>, <3, 1> ]
> P<x> := PolynomialRing(Rationals());
> Factorization(x^4 - 1);
[
    <x - 1, 1>,
    <x + 1, 1>,
    <x^2 + 1, 1>
]""",
    "Factorisation": """\
> Factorisation(1001);
[ <7, 1>, <11, 1>, <13, 1> ]""",
    "Gcd": """\
> Gcd(84, 120);
12""",
    "GCD": """\
> GCD(35, 21);
7""",
    "GreatestCommonDivisor": """\
> GreatestCommonDivisor(48, 180);
12""",
    "Lcm": """\
> Lcm(12, 18);
36""",
    "LCM": """\
> LCM(4, 10);
20""",
    "LeastCommonMultiple": """\
> LeastCommonMultiple(6, 15);
30""",
    "Xgcd": """\
> g, x, y := Xgcd(30, 42);
> g, 30*x + 42*y;
6 6""",
    "XGCD": """\
> g, x, y := XGCD(14, 9);
> g eq 14*x + 9*y;
true""",
    "ExtendedGreatestCommonDivisor": """\
> g := ExtendedGreatestCommonDivisor(20, 12);
> g;
4""",
    "Quotrem": """\
> Quotrem(47, 6);
7 5""",
    "Modexp": """\
> Modexp(3, 100, 7);
4""",
    "Modinv": """\
> Modinv(5, 17);
7""",
    "InverseMod": """\
> InverseMod(3, 11);
4""",
    "Binomial": """\
> Binomial(10, 3);
120""",
    "Factorial": """\
> Factorial(12);
479001600""",
    "Fibonacci": """\
> Fibonacci(30);
832040""",
    "IsSquare": """\
> IsSquare(144);
true 12
> IsSquare(50);
false""",
    "Isqrt": """\
> Isqrt(150);
12""",
    "IsEven": """\
> IsEven(10);
true""",
    "IsOdd": """\
> IsOdd(10);
false""",
    "Valuation": """\
> Valuation(96, 2);
5""",
    "Intseq": """\
> Intseq(1234);
[ 4, 3, 2, 1 ]
> Intseq(10, 2);
[ 0, 1, 0, 1 ]""",
    "Seqint": """\
> Seqint([4, 3, 2, 1]);
1234""",
    "ChineseRemainderTheorem": """\
> ChineseRemainderTheorem([2, 3], [5, 7]);
17""",
    "CRT": """\
> CRT([1, 4], [3, 5]);
4""",
    "IsZero": """\
> IsZero(0), IsZero(3/4);
true false""",
    "IsOne": """\
> IsOne(1), IsOne(-1);
true false""",
    "IsUnit": """\
> IsUnit(-1), IsUnit(2);
true false""",
    "Abs": """\
> Abs(-7/3);
7/3""",
    "Sign": """\
> Sign(-12), Sign(0);
-1 0""",
    "Floor": """\
> Floor(17/5);
3""",
    "Ceiling": """\
> Ceiling(17/5);
4""",
    "Round": """\
> Round(7/2), Round(-13/4);
4 -3""",
    "Truncate": """\
> Truncate(-17/5);
-3""",
    "Numerator": """\
> Numerator(12/18);
2""",
    "Denominator": """\
> Denominator(12/18);
3""",
    "Sqrt": """\
> Sqrt(RealField(15) ! 3);
1.73205080756888""",
    "Exp": """\
> Exp(RealField(15) ! 2);
7.38905609893065""",
    "Log": """\
> Log(RealField(15) ! 10);
2.30258509299405""",
    "Pi": """\
> Pi(RealField(20));
3.1415926535897932385""",
    "Max": """\
> Max(3, 11);
11
> Max([4, 9, 2]);
9 2""",
    "Min": """\
> Min(3, 11);
3
> Min([4, 9, 2]);
2 3""",
    "Maximum": """\
> Maximum([4, 9, 2]);
9 2""",
    "Minimum": """\
> Minimum([4, 9, 2]);
2 3""",
    "IntegerToString": """\
> IntegerToString(255);
255
> IntegerToString(255, 16);
FF""",
    "StringToInteger": """\
> StringToInteger("4096") + 1;
4097""",
    "Sprint": """\
> s := Sprint([1, 2]);
> #s;
8""",
    "Sprintf": """\
> Sprintf("%o squared is %o", 7, 49);
7 squared is 49""",
    "Append": """\
> Append([1, 2], 3);
[ 1, 2, 3 ]""",
    "Include": """\
> Include({1, 2}, 5);
{ 1, 2, 5 }""",
    "Exclude": """\
> Exclude({1, 2, 5}, 2);
{ 1, 5 }""",
    "Remove": """\
> Remove([10, 20, 30], 2);
[ 10, 30 ]""",
    "Insert": """\
> Insert([10, 30], 2, 20);
[ 10, 20, 30 ]""",
    "Reverse": """\
> Reverse([1, 2, 3]);
[ 3, 2, 1 ]""",
    "Sort": """\
> Sort([5, 1, 4]);
[ 1, 4, 5 ]""",
    "Index": """\
> Index([7, 8, 9], 8);
2""",
    "Position": """\
> Position([7, 8, 9], 10);
0""",
    "IsEmpty": """\
> IsEmpty([]), IsEmpty({1});
true false""",
    "Seqset": """\
> Seqset([3, 1, 3, 2]);
{ 1, 2, 3 }""",
    "SetToSequence": """\
> Sort(SetToSequence({4, 2, 9}));
[ 2, 4, 9 ]""",
    "Setseq": """\
> #Setseq({1, 2, 3});
3""",
    "SequenceToSet": """\
> SequenceToSet([2, 2, 5]);
{ 2, 5 }""",
    "Set": """\
> Set([1, 1, 2]);
{ 1, 2 }""",
    "Eltseq": """\
> P<x> := PolynomialRing(Integers());
> Eltseq(3*x^2 + 1);
[ 1, 0, 3 ]""",
    "Universe": """\
> Universe([1/2, 3]);
Rational Field""",
    "Random": """\
> x := Random([1..10]);
> x in [1..10];
true
> Random({3});
3""",
    "Names": """\
> F := recformat< a, b >;
> Names(F);
[ a, b ]""",
    "Format": """\
> F := recformat< a, b >;
> r := rec< F | a := 1 >;
> Names(Format(r));
[ a, b ]""",
    "PolynomialRing": """\
> P<t> := PolynomialRing(Rationals());
> f := (t + 1)^3;
> f;
t^3 + 3*t^2 + 3*t + 1
> Degree(f), Coefficients(f);
3 [ 1, 3, 3, 1 ]
> Evaluate(f, 1/2);
27/8
> Q<y> := PolynomialRing(GF(5));
> (y + 1)^5;
y^5 + 1""",
    "Degree": """\
> P<x> := PolynomialRing(Integers());
> Degree(x^5 - x);
5
> Degree(P ! 7);
0
> Degree(P ! 0);
-1
> K<a> := NumberField(x^2 + 1);
> Degree(K);
2""",
    "Coefficients": """\
> P<x> := PolynomialRing(Integers());
> Coefficients(2*x^3 - x + 7);
[ 7, -1, 0, 2 ]""",
    "Coefficient": """\
> P<x> := PolynomialRing(Integers());
> Coefficient(2*x^3 - x + 7, 1);
-1""",
    "LeadingCoefficient": """\
> P<x> := PolynomialRing(Integers());
> LeadingCoefficient(5*x^2 + x);
5""",
    "Evaluate": """\
> P<x> := PolynomialRing(Integers());
> f := x^2 + 1;
> Evaluate(f, 3);
10
> Evaluate(f, 1/2);
5/4
> Evaluate(f, GF(5) ! 2);
0""",
    "Derivative": """\
> P<x> := PolynomialRing(Integers());
> Derivative(x^4 + 3*x);
4*x^3 + 3""",
    "Discriminant": """\
> P<x> := PolynomialRing(Integers());
> Discriminant(x^2 + x + 1);
-3""",
    "Resultant": """\
> P<x> := PolynomialRing(Integers());
> Resultant(x^2 - 2, x - 3);
7""",
    "IsIrreducible": """\
> P<x> := PolynomialRing(Rationals());
> IsIrreducible(x^4 + 1), IsIrreducible(x^2 - 4);
true false""",
    "Roots": """\
> P<x> := PolynomialRing(Rationals());
> Roots((x - 2)^2 * (x + 5));
[ <-5, 1>, <2, 2> ]""",
    "FunctionField": """\
> F<x> := FunctionField(Rationals());
> F;
Univariate rational function field over Rational Field
Variables: x
> (x^2 + 1)/(x - 1);
(x^2 + 1)/(x - 1)""",
    "RationalFunctionField": """\
> F<t> := RationalFunctionField(GF(5));
> F;
Univariate rational function field over GF(5)
Variables: t""",
    "FieldOfFractions": """\
> P<u> := PolynomialRing(Integers());
> F<x> := FieldOfFractions(P);
> F;
Univariate rational function field over Integer Ring
Variables: x""",
    "FractionField": """\
> P<u> := PolynomialRing(Rationals());
> F<x> := FieldOfFractions(P);
> F;
Univariate rational function field over Rational Field
Variables: x""",
    "BaseField": """\
> F<x> := FunctionField(GF(5));
> BaseField(F);
Finite field of size 5""",
    "PartialFractionDecomposition": """\
> F<x> := FunctionField(Rationals());
> P<y> := IntegerRing(F);
> PartialFractionDecomposition(1/(x^2 - 1));
[
    <y - 1, 1, 1/2>,
    <y + 1, 1, -1/2>
]""",
    "SquarefreePartialFractionDecomposition": """\
> F<x> := FunctionField(Rationals());
> P<y> := IntegerRing(F);
> SquarefreePartialFractionDecomposition(1/(x^2 - 1));
[
    <y^2 - 1, 1, 1>
]""",
    "Gamma0": """\
> Gamma0(11);
Gamma_0(11)""",
    "ModularSymbols": """\
> M := ModularSymbols(23, 2, 1);
> Dimension(M);
3""",
    "Dimension": """\
> M := ModularSymbols(37, 2, 1);
> Dimension(M);
3
> Dimension(CuspidalSubspace(M));
2
> Dimension(CuspForms(23));
2""",
    "CuspidalSubspace": """\
> S := CuspidalSubspace(ModularSymbols(11, 2, 1));
> Dimension(S);
1""",
    "NewSubspace": """\
> Dimension(NewSubspace(CuspidalSubspace(ModularSymbols(22, 2, 1))));
0""",
    "HeckePolynomial": """\
> S := CuspidalSubspace(ModularSymbols(23, 2, 1));
> HeckePolynomial(S, 2);
x^2 + x - 1""",
    "HeckeOperator": """\
> S := CuspidalSubspace(ModularSymbols(11, 2, 1));
> T := HeckeOperator(S, 5);
> Coefficients(CharacteristicPolynomial(T));
[ -1, 1 ]""",
    "CharacteristicPolynomial": """\
> S := CuspidalSubspace(ModularSymbols(11, 2, 1));
> Coefficients(CharacteristicPolynomial(HeckeOperator(S, 2)));
[ 2, 1 ]""",
    "NewformDecomposition": """\
> S := CuspidalSubspace(ModularSymbols(33, 2, 1));
> #NewformDecomposition(NewSubspace(S));
1""",
    "DimensionCuspFormsGamma0": """\
> DimensionCuspFormsGamma0(37, 2);
2""",
    "DimensionNewCuspFormsGamma0": """\
> DimensionNewCuspFormsGamma0(22, 2);
0""",
    "CuspForms": """\
> Dimension(CuspForms(23, 2));
2""",
    "ModularForms": """\
> Dimension(ModularForms(1, 12));
2""",
    "Newforms": """\
> #Newforms(CuspForms(11, 2));
1""",
    "qExpansion": """\
> f := Newforms(CuspForms(11, 2))[1][1];
> qExpansion(f, 6);
q - 2*q^2 - q^3 + 2*q^4 + q^5 + O(q^6)""",
    "EllipticCurve": """\
> E := EllipticCurve([0, 0, 1, -1, 0]);
> Conductor(E);
37
> aInvariants(E);
[ 0, 0, 1, -1, 0 ]
> jInvariant(E);
110592/37
> Discriminant(E);
37
> Conductor(EllipticCurve("11a1"));
11""",
    "TraceOfFrobenius": """\
> E := EllipticCurve([0, -1, 1, 0, 0]);
> TraceOfFrobenius(E, 7);
-2""",
    "Conductor": """\
> Conductor(EllipticCurve([1, 0, 0, 0, 1]));
433""",
    "aInvariants": """\
> aInvariants(EllipticCurve([3, 5]));
[ 0, 0, 0, 3, 5 ]""",
    "jInvariant": """\
> jInvariant(EllipticCurve([0, 0, 1, -1, 0]));
110592/37""",
    "CremonaReference": """\
> CremonaReference(EllipticCurve([0, -1, 1, -10, -20]));
11a1""",
    "TorsionSubgroup": """\
> #TorsionSubgroup(EllipticCurve([0, -1, 1, -10, -20]));
5""",
    "Rank": """\
> Rank(EllipticCurve([0, 0, 1, -1, 0]));
1
> Rank(Matrix(Integers(), 2, 2, [1, 2, 2, 4]));
1""",
    "NumberField": """\
> P<x> := PolynomialRing(Integers());
> K<a> := NumberField(x^3 - 2);
> a^4;
2*a
> Degree(K);
3
> Norm(a + 1);
3""",
    "QuadraticField": """\
> K<w> := QuadraticField(-5);
> w^2;
-5""",
    "MaximalOrder": """\
> K := QuadraticField(5);
> Discriminant(MaximalOrder(K));
5""",
    "RingOfIntegers": """\
> K := QuadraticField(-3);
> Discriminant(RingOfIntegers(K));
-3""",
    "Signature": """\
> P<x> := PolynomialRing(Integers());
> Signature(NumberField(x^3 - 2));
1 1""",
    "IntegralBasis": """\
> K<w> := QuadraticField(13);
> IntegralBasis(K)[2];
1/2*(w + 1)""",
    "ClassNumber": """\
> ClassNumber(QuadraticField(-23));
3""",
    "ClassGroup": """\
> G := ClassGroup(QuadraticField(-14));
> #G;
4""",
    "CyclotomicField": """\
> K<z> := CyclotomicField(5);
> z^5;
1
> Degree(K);
4""",
    "Basis": """\
> K<w> := QuadraticField(-5);
> Basis(K);
[ 1, w ]""",
    "BaseRing": """\
> P<x> := PolynomialRing(GF(7));
> BaseRing(P);
Finite field of size 7""",
    "CoefficientRing": """\
> CoefficientRing(Matrix(Rationals(), 2, 2, [1, 2, 3, 4]));
Rational Field""",
    "UnitGroup": """\
> U := UnitGroup(QuadraticField(-1));
> #U;
4""",
    "Regulator": """\
> Round(1000 * Regulator(QuadraticField(5)));
481""",
    "UnitRank": """\
> P<x> := PolynomialRing(Integers());
> UnitRank(NumberField(x^3 - 2));
1""",
    "Decomposition": """\
> O := MaximalOrder(QuadraticField(-1));
> #Decomposition(O, 5);
2""",
    "Norm": """\
> K<w> := QuadraticField(7);
> Norm(3 + w);
2""",
    "Trace": """\
> K<w> := QuadraticField(7);
> Trace(3 + w);
6""",
    "MinimalPolynomial": """\
> K<w> := QuadraticField(7);
> MinimalPolynomial(1 + w);
$.1^2 - 2*$.1 - 6""",
    "Matrix": """\
> A := Matrix(Integers(), 2, 3, [1, 2, 3, 4, 5, 6]);
> A;
[1 2 3]
[4 5 6]
> Transpose(A);
[1 4]
[2 5]
[3 6]
> B := Matrix(Rationals(), [[1, 2], [3, 4]]);
> Determinant(B);
-2
> B^-1;
[  -2    1]
[ 3/2 -1/2]""",
    "HermiteForm": """\
> HermiteForm(Matrix(Integers(), 2, 2, [2, 4, 3, 1]));
[ 1  7]
[ 0 10]""",
    "EchelonForm": """\
> EchelonForm(Matrix(Rationals(), 2, 3, [1, 2, 3, 2, 4, 7]));
[1 2 0]
[0 0 1]""",
    "SmithForm": """\
> D := SmithForm(Matrix(Integers(), 2, 2, [2, 4, 6, 8]));
> D;
[2 0]
[0 4]""",
    "ElementaryDivisors": """\
> ElementaryDivisors(Matrix(Integers(), 2, 2, [2, 4, 6, 8]));
[ 2, 4 ]""",
    "LLL": """\
> LLL(Matrix(Integers(), 2, 2, [1, 0, 99, 1]));
[1 0]
[0 1]""",
    "Determinant": """\
> Determinant(Matrix(Integers(), 3, 3, [2, 0, 1, 1, 3, 0, 0, 1, 4]));
25""",
    "Transpose": """\
> Transpose(Matrix(Integers(), 2, 3, [1, 2, 3, 4, 5, 6]));
[1 4]
[2 5]
[3 6]""",
    "NumberOfRows": """\
> NumberOfRows(Matrix(Integers(), 2, 3, [1, 2, 3, 4, 5, 6]));
2""",
    "NumberOfColumns": """\
> NumberOfColumns(Matrix(Integers(), 2, 3, [1, 2, 3, 4, 5, 6]));
3""",
    "Nrows": """\
> Nrows(Matrix(Integers(), 4, 1, [1, 2, 3, 4]));
4""",
    "Ncols": """\
> Ncols(Matrix(Integers(), 4, 1, [1, 2, 3, 4]));
1""",
    "Domain": """\
> f := map< Integers() -> Rationals() | n :-> n / 2 >;
> Domain(f);
Integer Ring""",
    "Codomain": """\
> f := map< Integers() -> Rationals() | n :-> n / 2 >;
> Codomain(f);
Rational Field""",
    "Image": """\
> f := map< {1, 2, 3} -> Integers() | [<1, 5>, <2, 5>, <3, 7>] >;
> Image(f);
{ 5, 7 }""",
    "Inverse": """\
> f := map< Integers() -> Integers() | n :-> n + 4, m :-> m - 4 >;
> g := Inverse(f);
> g(10);
6""",
}


# An intrinsic of several signatures (lib/_magma.py's _signature: one name,
# a function for each type of argument) has an entry for each signature
# Sagebrush implements: name -> {its types, as "T" or "T1, T2": (summary,
# example)}, written for Sagebrush.  (Its TABLE summary and EXAMPLES entry
# are for the name as a whole.)
SIGNATURES = {
    "Vector": {
        "SeqEnum": ("A vector of the integers or rationals of a sequence (over the rationals if any is not an integer).",
                    "> Vector([3, -1]);\n( 3 -1)"),
        "Rng, SeqEnum": ("A vector over the integers or the rationals of the elements of a sequence.",
                         "> Vector(Rationals(), [1, 2]) * Matrix(Rationals(), 2, 2, [1, 2, 3, 4]);\n( 7 10)"),
    },
    "Solution": {
        "MtrxS, ModTupRngElt": ("The unique vector v with v * A = w, over A's ring; an error when there is none.",
                                "> Solution(Matrix(Integers(), 2, 2, [2, 0, 0, 2]), Vector(Integers(), [2, 4]));\n(1 2)"),
    },
    "Submatrix": {
        "Mtrx, RngIntElt, RngIntElt, RngIntElt, RngIntElt": ("The p by q block of a matrix whose top left entry is in row i, column j.",
                                                             "> Submatrix(Matrix(Integers(), 2, 3, [1, 2, 3, 4, 5, 6]), 1, 2, 2, 2);\n[2 3]\n[5 6]"),
    },
    "Subsets": {
        "SetEnum": ("The set of all subsets of a set.", "> #Subsets({1, 2, 3});\n8"),
        "SetEnum, RngIntElt": ("The set of the subsets of a set that have k elements.", "> #Subsets({1..10}, 3);\n120"),
    },
    "Sym": {
        "RngIntElt": ("The symmetric group on 1 .. n; i^p is the image of i under a permutation p.",
                      "> G := Sym(3);\n> p := G!(1, 2, 3);\n> [i^p : i in [1..3]];\n[ 2, 3, 1 ]"),
    },
    "Identity": {
        "GrpPerm": ("The identity permutation of a symmetric group.", "> Order(Identity(Sym(5)));\n1"),
    },
    "ChangeRing": {
        "RngUPol, Rng": ("The univariate polynomial ring over R (the integers, the rationals or a finite field), and the map to it.",
                         "> P<x> := PolynomialRing(Integers());\n> ChangeRing(P, GF(25));\nUnivariate Polynomial Ring over GF(5^2)\nMapping from: RngUPol: P to Univariate Polynomial Ring over GF(5^2)"),
        "RngUPolElt, Rng": ("The polynomial with each coefficient coerced into R; between finite fields into an overfield or a subfield.",
                            "> K<b> := GF(16); U<u> := PolynomialRing(K); F<a> := GF(4);\n> ChangeRing(u^2 + b^5*u + 1, F);\n$.1^2 + a*$.1 + 1"),
    },
    "Trace": {
        "RngIntElt": ("An integer is its own trace.", "> Trace(-7);\n-7"),
        "FldRatElt": ("A rational number is its own trace.", "> Trace(3/4);\n3/4"),
        "FldFinElt": ("The absolute trace of a finite field element: the sum of its conjugates, in the prime field.",
                      "> F<z> := GF(9);\n> Trace(z);\n1"),
        "FldFinElt, FldFin": ("The trace of a finite field element over a subfield of its field.",
                              "> K<b> := GF(16); F<a> := GF(4);\n> Trace(b, F);\n1"),
        "FldAlgElt": ("The trace of a number field element: the sum of its conjugates.",
                      "> K<w> := QuadraticField(7);\n> Trace(3 + w);\n6"),
        "MtrxS": ("The trace of a square matrix: the sum of its diagonal entries.",
                  "> Trace(Matrix(Integers(), 2, 2, [1, 2, 3, 4]));\n5"),
    },
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


def _signatures(name):
    """name's registered signatures (lib/_magma.py _signature), or []."""
    import _magma
    f = getattr(_magma, name, None)
    return getattr(getattr(f, "__wrapped__", f), "_magma_signatures", [])


def _sig_key(name, types):
    return "%s(%s)" % (name, ", ".join(types))


def _sig_text(f, types, ret):
    """(<RngIntElt> x) -> RngIntElt, as Magma lists a signature: the
    argument names of Sagebrush's own function, with the signature's types."""
    names = f.__code__.co_varnames[:f.__code__.co_argcount] if f else ["x%d" % (i + 1) for i in range(len(types))]
    return "(" + ", ".join("<%s> %s" % (t, n) for n, t in zip(names, types)) + ") -> " + ret


def _para(text, indent, width=80):
    """text as lines of at most `width` columns, each indented."""
    lines, line = [], ""
    for w in text.split():
        if line and len(indent) + len(line) + 1 + len(w) > width:
            lines.append(indent + line)
            line = w
        else:
            line = (line + " " + w) if line else w
    return "\n".join(lines + [indent + line])


def intrinsic_text(name):
    """An intrinsic as Magma mode prints it (Trace;): Magma's layout, with
    the signatures and summaries Sagebrush has."""
    import _magma
    sigs = _signatures(name)
    out = ["Intrinsic '%s'" % name, "", "Signatures:", ""]
    if sigs:
        for types, f, ret in sigs:
            text = SIGNATURES.get(name, {}).get(", ".join(types), ("",))[0] if f else "Not supported yet in Sagebrush."
            out += ["    " + _sig_text(f, types, ret), "", _para(text, "        "), ""]
    else:
        text = TABLE.get(name, ([], ""))[1]
        out += ["    " + _magma_signature(name, getattr(_magma, name))[len(name):], ""] + ([_para(text, "        "), ""] if text else [])
    return "\n".join(out)


def examples():
    """Every example, by name (and by name(types) for a signature's)."""
    out = dict(EXAMPLES)
    for name, sigs in SIGNATURES.items():
        for types, (_, example) in sigs.items():
            out[_sig_key(name, types.split(", "))] = example
    return out


def _with_example(summary, example):
    return summary + ("\n\nExample:\n\n" + "\n".join("    " + line for line in example.split("\n")) if example else "")


def build_index():
    """[{name, module, kind, signature, summary, doc, examples, open_problem,
    language, areas}] for Magma mode's intrinsics, by name; one for each
    signature of an intrinsic of several (with its example's key)."""
    import _magma
    out = []
    for name in sorted(bound_names(), key=str.lower):
        if name not in TABLE:
            continue  # (test/docsearch fails for these)
        areas, summary = TABLE[name]
        sigs = _signatures(name)
        if sigs:
            listing = "\n".join("    %s%s%s" % (name, _sig_text(f, types, ret), "" if f else "    (not supported yet)")
                                for types, f, ret in sigs)
            for types, f, ret in sigs:
                if f is None or ", ".join(types) not in SIGNATURES.get(name, {}):
                    continue  # (check() reports a missing one)
                s_summary, example = SIGNATURES[name][", ".join(types)]
                out.append({
                    "name": name,
                    "key": _sig_key(name, types),
                    "module": "magma",
                    "kind": "function",
                    "signature": _sig_text(f, types, ret),
                    "summary": s_summary,
                    "doc": _with_example(s_summary, example) + "\n\nThe signatures of %s:\n\n%s" % (name, listing),
                    "examples": sum(1 for line in example.split("\n") if line.startswith("> ")),
                    "open_problem": False,
                    "language": "magma",
                    "areas": areas,
                })
            continue
        example = EXAMPLES.get(name, "")
        doc = _with_example(summary, example)
        out.append({
            "name": name,
            "module": "magma",
            "kind": "function",
            "signature": _magma_signature(name, getattr(_magma, name))[len(name):],
            "summary": summary,
            "doc": doc,
            "examples": sum(1 for line in example.split("\n") if line.startswith("> ")),
            "open_problem": False,
            "language": "magma",
            "areas": areas,
        })
    return out


def check():
    """Names bound but not in TABLE (they need a summary), names in TABLE
    that are not bound, and names of TABLE without an example (or examples
    of names not in TABLE)."""
    bound = set(bound_names())
    missing, extra = sorted(bound - set(TABLE)), sorted(set(TABLE) - bound)
    # (and each implemented signature of an intrinsic of several needs its
    # own summary and example: name(types) is missing, or extra)
    have = {_sig_key(n, t.split(", ")) for n, sigs in SIGNATURES.items() for t in sigs}
    want = {_sig_key(n, types) for n in bound for types, f, _ in _signatures(n) if f is not None}
    missing += sorted(want - have)
    extra += sorted(have - want)
    return missing, extra, sorted(set(TABLE) ^ set(EXAMPLES))


def main(argv):
    if "--index" in argv:
        print(_json.dumps(build_index(), separators=(",", ":")))
        return 0
    if "--check" in argv:
        missing, extra, no_example = check()
        print(_json.dumps({"missing": missing, "extra": extra, "no_example": no_example}))
        return 1 if missing or extra or no_example else 0
    if "--examples" in argv:
        print(_json.dumps(examples()))
        return 0
    print("usage: sagebrush -m _magma_docsearch --index | --check | --examples")
    return 2


if __name__ == "__main__":
    _sys.exit(main(_sys.argv[1:]))
