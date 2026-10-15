// Magma fixtures for Hilbert cusp forms of weight k != (2, 2) over real
// quadratic fields other than Q(sqrt 5) (engine/hmf/src/defweight.rs and
// defweightnew.rs; tests only): Magma is used as a black box. Run from this
// directory with
//     magma -b magma-weight-general.m > magma-weight-general.txt
// For each field Q(sqrt d) below (w the generator of the maximal order with
// w^2 = w + (d - 1)/4 or w^2 = d, as in rqf.rs), levels N are given by two
// generators x1 + y1 w, x2 + y2 w, primes P = (p, x + y w) by p x y, and
// weights [k1, k2] in Magma's order, k_i at InfinitePlaces(F)[i]:
//
//   F d | s
//       s = + if sqrt d is positive at Magma's first infinite place, - if
//       negative (so the test can put k1 at sqrt d -> -sqrt d, Sagebrush's
//       convention);
//   D d | x1 y1 ; x2 y2 | k1 k2 | dim
//       Dimension(HilbertCuspForms(F, N, [k1, k2])) for every level of norm
//       <= the field's bound and every weight;
//   H d | x1 y1 ; x2 y2 | k1 k2 | p x y | c0;c1;...;cn
//       in parallel weight, the characteristic polynomial (over Q, written
//       a,0) of HeckeOperator(M, P) on the full space (U_P when P | N), for
//       the primes of norm <= 7, constant term first;
//   C d | x1 y1 ; x2 y2 | k1 k2 | p x y | a0,b0;a1,b1;...
//       the same in non-parallel weight, where HeckeOperator's matrices lie
//       in an extension K of F: the coefficients lie in a copy of F in K, read
//       back through an embedding F -> K from IsSubfield, which is only
//       determined up to the conjugation of F, so these are compared up to
//       conjugation;
//   O d | x1 y1 ; x2 y2 | k1 k2 | dim | p x y:c0;c1;... ...
//       at prime levels, for each newform orbit (NewformDecomposition of
//       NewSubspace), its dimension over F and, for every prime of norm <=
//       11, the characteristic polynomial over F of HeckeEigenvalue(Eigenform
//       (orbit), P): x - a for a in F, CharacteristicPolynomial over the base
//       field F of a relative eigenvalue field; Q in place of the
//       coefficients means the eigenvalue field was an absolute field other
//       than F, and the characteristic polynomial over Q is given instead (it
//       is N_(F/Q) of that over F);
//   E d | x1 y1 ; x2 y2 | k1 k2 | Magma raised an error
//       where Magma 2.18 fails in NewSubspace, NewformDecomposition or
//       Eigenform (e.g. InsertBlock when there are forms of level one);
//       not compared.
SetColumns(0);
R<x> := PolynomialRing(Rationals());
va, vb, vc := GetVersion();
printf "# Magma %o.%o-%o, black box: HilbertCuspForms(F, N, k), Dimension, HeckeOperator, NewSubspace, NewformDecomposition, Eigenform, HeckeEigenvalue, IdealsUpTo, IsSubfield\n", va, vb, vc;
function js(s, sep)
  if #s eq 0 then return ""; end if;
  line := Sprint(s[1]);
  for z in s[2..#s] do line cat:= sep cat Sprint(z); end for;
  return line;
end function;
weights := [[2,4],[4,2],[3,3],[4,4],[3,5],[5,3],[2,6]];
for t in [<2, 12>, <3, 12>, <6, 9>, <7, 9>, <10, 9>, <13, 12>, <15, 6>, <17, 9>, <21, 9>, <34, 4>] do
  d := t[1];
  if d mod 4 eq 1 then
    F<w> := NumberField(x^2 - x - (d - 1) div 4);
    sq := 2*w - 1;
  else
    F<w> := NumberField(x^2 - d);
    sq := w;
  end if;
  O := MaximalOrder(F);
  elt := func<e | [Integers()!c : c in Eltseq(F!e)]>;
  gens := function(N)
    g := Generators(N);
    g1 := elt(g[1]);
    g2 := #g gt 1 select elt(g[2]) else [0, 0];
    return Sprintf("%o %o ; %o %o", g1[1], g1[2], g2[1], g2[2]);
  end function;
  pstr := function(P)
    p := Minimum(P);
    if Norm(P) eq p^2 then return Sprintf("%o 0 0", p); end if;
    for a in [0..p-1] do
      if a + w in P then return Sprintf("%o %o 1", p, a); end if;
    end for;
    error "no generator";
  end function;
  s := Evaluate(sq, InfinitePlaces(F)[1]) gt 0 select "+" else "-";
  printf "F %o | %o\n", d, s;
  primes := [P : P in PrimesUpTo(7, F)];
  primes11 := [P : P in PrimesUpTo(11, F)];
  for N in IdealsUpTo(t[2], F) do
    for k in weights do
      M := HilbertCuspForms(F, N, k);
      dim := Dimension(M);
      printf "D %o | %o | %o %o | %o\n", d, gens(N), k[1], k[2], dim;
      if dim eq 0 or dim gt 40 then continue; end if;
      for P in primes do
        T := HeckeOperator(M, P);
        c := CharacteristicPolynomial(T);
        K := BaseRing(Parent(c));
        if k[1] eq k[2] then
          printf "H %o | %o | %o %o | %o | %o\n", d, gens(N), k[1], k[2], pstr(P), js([Sprintf("%o,0", Rationals()!a) : a in Coefficients(c)], ";");
        else
          ok, phi := IsSubfield(F, K);
          assert ok;
          L := sub<K | phi(F.1)>;
          cs := [];
          for a in Coefficients(c) do
            e := Eltseq(L!a);
            // L = Q(phi(w)) with basis 1, phi(w)
            Append(~cs, Sprintf("%o,%o", e[1], e[2]));
          end for;
          printf "C %o | %o | %o %o | %o | %o\n", d, gens(N), k[1], k[2], pstr(P), js(cs, ";");
        end if;
      end for;
      // newform orbits at prime levels
      fac := Factorization(N);
      if not (#fac eq 1 and fac[1][2] eq 1) then continue; end if;
      lines := [];
      try
        for D in NewformDecomposition(NewSubspace(M)) do
          f := Eigenform(D);
          parts := "";
          for Q in primes11 do
            a := HeckeEigenvalue(f, Q);
            E := Parent(a);
            ok, b := IsCoercible(F, a);
            if ok then
              e := elt(b);
              cp := Sprintf("%o,%o;1,0", -e[1], -e[2]);
            elif Type(E) eq FldNum and not IsAbsoluteField(E) and BaseField(E) eq F then
              cp := js([Sprintf("%o,%o", elt(z)[1], elt(z)[2]) : z in Coefficients(CharacteristicPolynomial(a))], ";");
            else
              cp := "Q" cat js([Rationals()!z : z in Coefficients(CharacteristicPolynomial(AbsoluteField(E)!a))], ";");
            end if;
            parts cat:= Sprintf(" %o:%o", pstr(Q), cp);
          end for;
          Append(~lines, Sprintf("O %o | %o | %o %o | %o |%o", d, gens(N), k[1], k[2], Dimension(D), parts));
        end for;
      catch err
        lines := [Sprintf("E %o | %o | %o %o | %o", d, gens(N), k[1], k[2], Split(Sprint(err`Object), "\n")[1])];
      end try;
      for l in lines do printf "%o\n", l; end for;
    end for;
  end for;
end for;
quit;
