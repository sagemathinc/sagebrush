// One Magma V2.18-5 benchmark case. Inputs arrive with magma -b.
case_id := case_id;
n := StringToInteger(n);
repeats := StringToInteger(repeats);
HMOD := 1000000007;

function ScalarHash(x)
    if Type(x) eq FldRatElt then
        num := Integers()!Numerator(x);
        den := Integers()!Denominator(x);
        inv := Integers()!((Integers(HMOD)!den)^-1);
        return ((num mod HMOD) * inv) mod HMOD;
    end if;
    return (Integers()!x) mod HMOD;
end function;

function SeqHash(s)
    h := 17;
    for x in s do h := (h*1000003 + ScalarHash(x)) mod HMOD; end for;
    return h;
end function;

function MatrixHash(A)
    return SeqHash(Eltseq(A));
end function;

function PowMod(a, e, m)
    value := 1;
    base := a mod m;
    while e gt 0 do
        if IsOdd(e) then value := (value*base) mod m; end if;
        e div:= 2;
        base := (base*base) mod m;
    end while;
    return value;
end function;

function ZMat(k)
    return Matrix(Integers(), k, k, [ (PowMod(i+1,j+2,1000003)-500001) : i,j in [1..k] ]);
end function;

function FpMat(k)
    F := GF(65537);
    return Matrix(F, k, k, [ F!PowMod(i+1,j+2,65537) : i,j in [1..k] ]);
end function;

function QMat(k)
    return Matrix(Rationals(), k, k,
        [ Rationals()!(PowMod(i+1,j+2,101)-50) / (1 + ((i-1)*(j-1) mod 7)) : i,j in [1..k] ]);
end function;

function ZPoly(k, salt, R)
    return R![ ((i*i*salt + 3*i + 1) mod 1000003)-500001 : i in [0..k-1] ];
end function;

function FpPoly(k, salt, R)
    return R![ ((i*i*salt + 3*i + 1) mod 65537) : i in [0..k-1] ];
end function;

function ZFactorProduct(k, R)
    x := R.1;
    f := R!1;
    for i in [1..k] do
        f *:= x^2 + (i+1)*x + (i*i+i+1);
    end for;
    return f;
end function;

function CyclicIdeal(k)
    R := PolynomialRing(GF(32003), k, "grevlex");
    x := [R.i : i in [1..k]];
    gens := [];
    for d in [1..k-1] do
        Append(~gens, &+[ &*[x[((i+j-2) mod k)+1] : j in [1..d]] : i in [1..k] ]);
    end for;
    Append(~gens, &*x-1);
    return ideal<R|gens>;
end function;

function KatsuraIdeal(k)
    R := PolynomialRing(GF(32003), k+1, "grevlex");
    x := [R.i : i in [1..k+1]];
    gens := [ x[1] + 2*&+[x[i] : i in [2..k+1]] - 1 ];
    for m in [0..k-1] do
        f := 0;
        for j in [-k..k] do
            a := Abs(j)+1; b := Abs(m-j)+1;
            if a le k+1 and b le k+1 then f +:= x[a]*x[b]; end if;
        end for;
        Append(~gens, f-x[m+1]);
    end for;
    return ideal<R|gens>;
end function;

function ClassDisc(digits)
    if digits eq 12 then return -100000000003; end if;
    if digits eq 24 then return -1000000000000000000000003; end if;
    return -10000000000000000000000000000000000000003;
end function;

// Construct deterministic inputs before the timed region.  Only the named
// operation is timed, matching the FLINT harness discipline.
a:=0; b:=0; pa:=0; pb:=0; pf:=0; g:=0; A:=0; v:=0; I:=0;
K:=0; O:=0; M:=0; E:=0; conductor:=0; ps:=[]; answer:=0; mp:=0; sig:="";
if case_id in {"bigint_mul","bigint_gcd"} then
    a := 2^n - 2^(n div 3) + 123456789;
    b := 2^(n-1) + 2^(n div 2) + 987654321;
elif case_id in {"poly_z_mul","poly_z_gcd","poly_z_factor","poly_z_factor_product"} then
    R<x> := PolynomialRing(Integers());
    if case_id eq "poly_z_mul" then pa:=ZPoly(n,11,R); pb:=ZPoly(n,17,R); end if;
    if case_id eq "poly_z_gcd" then g:=ZPoly(n div 2,5,R); pa:=g*ZPoly(n,11,R); pb:=g*ZPoly(n,17,R); end if;
    if case_id eq "poly_z_factor" then pf:=x^n-1; end if;
    if case_id eq "poly_z_factor_product" then pf:=ZFactorProduct(n,R); end if;
elif case_id in {"poly_fp_mul","poly_fp_gcd","poly_fp_factor"} then
    R<x> := PolynomialRing(GF(65537));
    if case_id eq "poly_fp_mul" then pa:=FpPoly(n,11,R); pb:=FpPoly(n,17,R); end if;
    if case_id eq "poly_fp_gcd" then g:=FpPoly(n div 2,5,R); pa:=g*FpPoly(n,11,R); pb:=g*FpPoly(n,17,R); end if;
    if case_id eq "poly_fp_factor" then pf:=x^n-1; end if;
elif case_id in {"mat_z_det","mat_z_rank","mat_z_hnf","mat_z_smith","mat_z_charpoly"} then
    A:=ZMat(n);
elif case_id in {"mat_fp_det","mat_fp_rank","mat_fp_solve","mat_fp_charpoly"} then
    A:=FpMat(n); if case_id eq "mat_fp_solve" then v:=Vector(BaseRing(A),[i:i in [1..n]]); end if;
elif case_id in {"mat_q_det","mat_q_rank","mat_q_solve","mat_q_charpoly"} then
    A:=QMat(n); if case_id eq "mat_q_solve" then v:=Vector(Rationals(),[i:i in [1..n]]); end if;
elif case_id eq "groebner_cyclic" then I:=CyclicIdeal(n);
elif case_id eq "groebner_katsura" then I:=KatsuraIdeal(n);
elif case_id eq "class_group" then K:=QuadraticField(ClassDisc(n)); O:=MaximalOrder(K);
elif case_id eq "galois_group" then R<x>:=PolynomialRing(Rationals()); pf:=x^n-x-1;
elif case_id eq "modsym_charpoly" then M:=ModularSymbols(n,2,+1);
elif case_id eq "newforms" then M:=NewSubspace(CuspidalSubspace(ModularSymbols(n,2,+1)));
elif case_id eq "ec_aplist" then
    E:=EllipticCurve([0,0,1,-7,6]); conductor:=Conductor(E);
    ps:=[p:p in PrimesUpTo(n)|conductor mod p ne 0];
else error "unknown case"; end if;

t := Realtime();
for rep in [1..repeats] do
    if case_id eq "bigint_mul" then answer:=a*b;
    elif case_id eq "bigint_gcd" then answer:=GCD(a*1000003,b*1000003);
    elif case_id in {"poly_z_mul","poly_fp_mul"} then answer:=pa*pb;
    elif case_id in {"poly_z_gcd","poly_fp_gcd"} then answer:=GCD(pa,pb);
    elif case_id in {"poly_z_factor","poly_z_factor_product","poly_fp_factor"} then answer:=Factorization(pf);
    elif case_id in {"mat_z_det","mat_fp_det","mat_q_det"} then answer:=Determinant(A);
    elif case_id in {"mat_z_rank","mat_fp_rank","mat_q_rank"} then answer:=Rank(A);
    elif case_id eq "mat_z_hnf" then answer:=HermiteForm(A);
    elif case_id eq "mat_z_smith" then answer:=SmithForm(A);
    elif case_id in {"mat_z_charpoly","mat_fp_charpoly","mat_q_charpoly"} then answer:=CharacteristicPolynomial(A);
    elif case_id in {"mat_fp_solve","mat_q_solve"} then answer:=Solution(Transpose(A),v);
    elif case_id in {"groebner_cyclic","groebner_katsura"} then answer:=GroebnerBasis(I);
    elif case_id eq "class_group" then answer,mp:=ClassGroup(O);
    elif case_id eq "galois_group" then answer:=GaloisGroup(pf);
    elif case_id eq "modsym_charpoly" then answer:=CharacteristicPolynomial(HeckeOperator(M,2));
    elif case_id eq "newforms" then answer:=NewformDecomposition(M);
    elif case_id eq "ec_aplist" then answer:=[<p,TraceOfFrobenius(ChangeRing(E,GF(p)))>:p in ps];
    end if;
end for;
seconds := Realtime(t)/repeats;

if case_id in {"bigint_mul","bigint_gcd"} then
    sig := IntegerToString(Ilog2(answer)+1) cat ":" cat IntegerToString(answer mod HMOD);
elif case_id in {"poly_z_mul","poly_z_gcd","poly_fp_mul","poly_fp_gcd"} then
    sig := IntegerToString(Degree(answer)) cat ":" cat IntegerToString(SeqHash(Coefficients(answer)));
elif case_id in {"poly_z_factor","poly_z_factor_product","poly_fp_factor"} then
    items := [<Degree(z[1]),z[2],SeqHash(Coefficients(z[1]))>:z in answer]; Sort(~items);
    flat := &cat [[z[1],z[2],z[3]]:z in items];
    sig := IntegerToString(#items) cat ":" cat IntegerToString(SeqHash(flat));
elif case_id in {"mat_z_det","mat_z_rank","mat_fp_det","mat_fp_rank","mat_q_det","mat_q_rank"} then
    sig := Sprint(answer);
elif case_id in {"mat_z_charpoly","mat_fp_charpoly","mat_q_charpoly"} then
    sig := IntegerToString(Degree(answer)) cat ":" cat IntegerToString(SeqHash(Coefficients(answer)));
elif case_id eq "mat_z_smith" then
    sig := IntegerToString(n) cat ":" cat IntegerToString(SeqHash([Abs(answer[i,i]):i in [1..n]]));
elif case_id in {"mat_z_hnf","mat_fp_solve","mat_q_solve"} then
    sig := IntegerToString(n) cat ":" cat IntegerToString(SeqHash(Eltseq(answer)));
elif case_id in {"groebner_cyclic","groebner_katsura"} then
    ds:=[TotalDegree(f):f in answer]; Sort(~ds); sig:=IntegerToString(#answer) cat ":" cat IntegerToString(SeqHash(ds));
elif case_id eq "class_group" then
    inv:=[Integers()!z:z in Invariants(answer)]; Sort(~inv); sig:=IntegerToString(#answer) cat ":" cat Join([IntegerToString(z):z in inv],",");
elif case_id eq "galois_group" then sig:=IntegerToString(#answer);
elif case_id eq "modsym_charpoly" then sig:=IntegerToString(Degree(answer)) cat ":" cat IntegerToString(SeqHash(Coefficients(answer)));
elif case_id eq "newforms" then ds:=[Dimension(A):A in answer]; Sort(~ds); sig:=IntegerToString(#ds) cat ":" cat Join([IntegerToString(d):d in ds],",");
elif case_id eq "ec_aplist" then sig:=IntegerToString(#answer) cat ":" cat IntegerToString(SeqHash([z[1]*1000+z[2]:z in answer]));
end if;
printf "RESULT|%.9o|%o\n",seconds,sig;
quit;
