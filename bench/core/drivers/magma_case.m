// One Magma V2.18-5 case (a black-box oracle).  Inputs arrive with magma -b:
// case_id, n, mode and variants (K, default 1); the protocol is common.py's.
case_id := case_id;
n := StringToInteger(n);
mode := mode;
K := assigned variants select StringToInteger(variants) else 1;
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

// Variant v: entry (i, j) from the node i + 1 + v (1-based i, j).
// The hard Smith family (drivers/sagebrush_case.py's smith_hard_rows):
// U diag(1, p, ..., p) V, p = 1000003, U and V unit lower times unit upper
// triangular with LCG entries in [-2^16, 2^16], drawn in the same order.
function SmithHard(k, v)
    s := 987654321 + 7919*v;
    Unimodular := function(k, s)
        lo := IdentityMatrix(Integers(), k); up := IdentityMatrix(Integers(), k);
        for i in [2..k] do for j in [1..i-1] do
            s := (6364136223846793005*s + 1442695040888963407) mod 2^64;
            lo[i,j] := (s div 2^33) mod 131073 - 65536;
        end for; end for;
        for i in [1..k-1] do for j in [i+1..k] do
            s := (6364136223846793005*s + 1442695040888963407) mod 2^64;
            up[i,j] := (s div 2^33) mod 131073 - 65536;
        end for; end for;
        return lo*up, s;
    end function;
    U, s := Unimodular(k, s);
    W, s := Unimodular(k, s);
    D := DiagonalMatrix(Integers(), [1] cat [1000003 : i in [2..k]]);
    return U*D*W;
end function;

function ZMat(k, v)
    return Matrix(Integers(), k, k, [ (PowMod(i+1+v,j+2,1000003)-500001) : i,j in [1..k] ]);
end function;

function FpMat(k, v : p := 65537)
    F := GF(p);
    return Matrix(F, k, k, [ F!PowMod(i+1+v,j+2,p) : i,j in [1..k] ]);
end function;

function QMat(k, v)
    return Matrix(Rationals(), k, k,
        [ Rationals()!(PowMod(i+1+v,j+2,101)-50) / (1 + ((i-1)*(j-1) mod 7)) : i,j in [1..k] ]);
end function;

// The rank rows beyond the square ones (expected_inputs.py's formulas, which
// also certify the ranks): wide R(n x 2n); def R(n x n div 2) R(n div 2 x n);
// def_p R(n x n) diag(1, ..., 1, p) R(n x n), p = 2^62 - 57.  Over Q, row i
// (from 0) is divided by 1 + i mod 7.  Entries row-major: a Magma sequence
// constructor varies its FIRST variable fastest, so j comes first.
function RankRnd(rows, cols, s, kind)
    m := kind eq "z" select 1000003 else 101;
    off := kind eq "z" select 500001 else 50;
    return Matrix(Integers(), rows, cols,
        [ PowMod(131*i + 31*j + s, 5, m) - off : j in [0..cols-1], i in [0..rows-1] ]);
end function;

function RankMat(case_id, n, v)
    kind := case_id[5];
    s1 := 10*v + 1; s2 := 10*v + 2;
    if case_id in {"mat_z_rank_wide","mat_q_rank_wide"} then
        A := RankRnd(n, 2*n, s1, kind);
    elif case_id in {"mat_z_rank_def","mat_q_rank_def"} then
        r := n div 2;
        A := RankRnd(n, r, s1, kind) * RankRnd(r, n, s2, kind);
    else
        C := RankRnd(n, n, s2, kind);
        MultiplyRow(~C, 2^62 - 57, n);
        A := RankRnd(n, n, s1, kind) * C;
    end if;
    if kind eq "z" then return A; end if;
    return Matrix(Rationals(), Nrows(A), Ncols(A),
        [ A[i,j] / (1 + ((i-1) mod 7)) : j in [1..Ncols(A)], i in [1..Nrows(A)] ]);
end function;

function ZPoly(k, salt, R)
    return R![ ((i*i*salt + 3*i + 1) mod 1000003)-500001 : i in [0..k-1] ];
end function;

// The dense factoring rows' input (bench/core/drivers/sagebrush_case.py's
// dense_poly): monic of degree n, coefficients from a 64-bit LCG, residues
// mod 65537 (k = 1) or integers in [-1000, 1000] (k = 2).
function DensePoly(n, k, v, R)
    s := 1000003*k + 7919*v + 12345; c := [];
    for i in [1..n] do
        s := (6364136223846793005*s + 1442695040888963407) mod 2^64;
        r := s div 2^33;
        Append(~c, k eq 1 select r mod 65537 else (r mod 2001) - 1000);
    end for;
    Append(~c, 1);
    return R!c;
end function;

function FpPoly(k, salt, R)
    return R![ ((i*i*salt + 3*i + 1) mod 65537) : i in [0..k-1] ];
end function;

function ZFactorProduct(k, R, v)
    x := R.1;
    f := R!1;
    for i in [1..k] do
        f *:= x^2 + (i+1)*x + (i*i+i+1+v);
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

// The inputs of variant v, built outside the timed region: S holds every
// operand a case may use, ops the operands' integers (residues of
// rationals) for the drivers' input check.  Variants: the bigints + v 1000003
// and + v 998244353, salts + 6 v, matrix nodes + v, the factor product's
// constant terms + v.
function Build(case_id, n, v)
    a:=0; b:=0; pa:=0; pb:=0; pf:=0; A:=0; w:=0; I:=0; O:=0; M:=0; E:=0; ps:=[]; ops:=[];
    if case_id in {"bigint_mul","bigint_gcd"} then
        a := 2^n - 2^(n div 3) + 123456789 + v*1000003;
        b := 2^(n-1) + 2^(n div 2) + 987654321 + v*998244353;
        ops := [a, b];
    elif case_id in {"poly_z_mul","poly_z_gcd","poly_z_factor","poly_z_factor_product","poly_z_factor_dense"} then
        R<x> := PolynomialRing(Integers());
        if case_id eq "poly_z_mul" then pa:=ZPoly(n,11+6*v,R); pb:=ZPoly(n,17+6*v,R); end if;
        if case_id eq "poly_z_gcd" then g:=ZPoly(n div 2,5+6*v,R); pa:=g*ZPoly(n,11+6*v,R); pb:=g*ZPoly(n,17+6*v,R); end if;
        if case_id eq "poly_z_factor" then pf:=x^n-1; end if;
        if case_id eq "poly_z_factor_product" then pf:=ZFactorProduct(n,R,v); end if;
        if case_id eq "poly_z_factor_dense" then pf:=DensePoly(n,2,v,R); end if;
        ops := case_id in {"poly_z_mul","poly_z_gcd"} select Coefficients(pa) cat Coefficients(pb) else Coefficients(pf);
    elif case_id in {"poly_fp_mul","poly_fp_gcd","poly_fp_factor","poly_fp_factor_dense"} then
        R<x> := PolynomialRing(GF(65537));
        if case_id eq "poly_fp_mul" then pa:=FpPoly(n,11+6*v,R); pb:=FpPoly(n,17+6*v,R); end if;
        if case_id eq "poly_fp_gcd" then g:=FpPoly(n div 2,5+6*v,R); pa:=g*FpPoly(n,11+6*v,R); pb:=g*FpPoly(n,17+6*v,R); end if;
        if case_id eq "poly_fp_factor" then pf:=x^n-1; end if;
        if case_id eq "poly_fp_factor_dense" then pf:=DensePoly(n,1,v,R); end if;
        ops := case_id in {"poly_fp_factor","poly_fp_factor_dense"} select Coefficients(pf) else Coefficients(pa) cat Coefficients(pb);
    elif case_id in {"mat_z_det","mat_z_rank","mat_z_hnf","mat_z_smith","mat_z_charpoly","mat_z_elementary_divisors","mat_z_smith_hard","mat_z_elementary_divisors_hard"} then
        A := case_id in {"mat_z_smith_hard","mat_z_elementary_divisors_hard"} select SmithHard(n,v) else ZMat(n,v);
        ops := Eltseq(A);
    elif case_id in {"mat_fp_det","mat_fp_rank","mat_fp_solve","mat_fp_charpoly","mat_fp31_det","mat_fp31_rank","mat_fp31_solve","mat_fp31_charpoly"} then
        // (mat_fp31_*: the same rows modulo 2^31 - 1)
        A:=FpMat(n,v : p := Substring(case_id, 1, 9) eq "mat_fp31_" select 2147483647 else 65537); ops := Eltseq(A);
        if case_id in {"mat_fp_solve","mat_fp31_solve"} then w:=Vector(BaseRing(A),[i:i in [1..n]]); ops := ops cat Eltseq(w); end if;
    elif case_id in {"mat_q_det","mat_q_rank","mat_q_solve","mat_q_charpoly"} then
        A:=QMat(n,v); ops := Eltseq(A);
        if case_id eq "mat_q_solve" then w:=Vector(Rationals(),[i:i in [1..n]]); ops := ops cat Eltseq(w); end if;
    elif case_id in {"mat_z_rank_wide","mat_z_rank_def","mat_z_rank_def_p","mat_q_rank_wide","mat_q_rank_def","mat_q_rank_def_p"} then
        A:=RankMat(case_id,n,v); ops := Eltseq(A);
    elif case_id in {"groebner_cyclic","groebner_katsura"} then
        I := case_id eq "groebner_cyclic" select CyclicIdeal(n) else KatsuraIdeal(n);
        shape := Sort([TotalDegree(f)*100000 + #Terms(f) : f in Basis(I)]);
        ops := &cat [[z div 100000, z mod 100000] : z in shape];
    elif case_id eq "class_group" then
        K:=QuadraticField(ClassDisc(n)); O:=MaximalOrder(K); ops := [ClassDisc(n)];
    elif case_id eq "galois_group" then
        R<x>:=PolynomialRing(Rationals()); pf:=x^n-x-1; ops := Coefficients(pf);
    elif case_id eq "galois_group_small" then
        // (drivers/sagebrush_case.py's SMALL_GROUP_POLYS)
        R<x>:=PolynomialRing(Rationals());
        pf := R!(n eq 6 select [3,2,-2,-2,-1,0,1] else [-2] cat [0 : i in [1..n-1]] cat [1]);
        ops := Coefficients(pf);
    elif case_id eq "modsym_charpoly" then M:=ModularSymbols(n,2,+1); ops := [n, 2];
    elif case_id eq "newforms" then M:=NewSubspace(CuspidalSubspace(ModularSymbols(n,2,+1))); ops := [n, 2];
    elif case_id eq "hecke_matrix" then ops := [389, 2, n];
    elif case_id eq "hecke_matrix_prebuilt" then
        // (the space outside the timer: informational, no ratio)
        M:=CuspidalSubspace(ModularSymbols(389,2,+1)); ops := [389, 2, n];
    elif case_id eq "ec_aplist" then
        E:=EllipticCurve([0,0,1,-7,6]); conductor:=Conductor(E);
        ps:=[p:p in PrimesUpTo(n)|conductor mod p ne 0]; ops := [0, 0, 1, -7, 6, n];
    else error "unknown case"; end if;
    return [* a, b, pa, pb, pf, A, w, I, O, M, E, ps *], ops;
end function;

// The named operation, alone.
function DoOp(case_id, S)
    a:=S[1]; b:=S[2]; pa:=S[3]; pb:=S[4]; pf:=S[5]; A:=S[6]; v:=S[7]; I:=S[8]; O:=S[9]; M:=S[10]; E:=S[11]; ps:=S[12];
    if case_id eq "bigint_mul" then return a*b;
    elif case_id eq "bigint_gcd" then return GCD(a*1000003,b*1000003);
    elif case_id in {"poly_z_mul","poly_fp_mul"} then return pa*pb;
    elif case_id in {"poly_z_gcd","poly_fp_gcd"} then return GCD(pa,pb);
    elif case_id in {"poly_z_factor","poly_z_factor_product","poly_fp_factor","poly_z_factor_dense","poly_fp_factor_dense"} then return Factorization(pf);
    elif case_id in {"mat_z_det","mat_fp_det","mat_fp31_det","mat_q_det"} then return Determinant(A);
    elif case_id in {"mat_z_rank","mat_fp_rank","mat_fp31_rank","mat_q_rank","mat_z_rank_wide","mat_z_rank_def","mat_z_rank_def_p","mat_q_rank_wide","mat_q_rank_def","mat_q_rank_def_p"} then return Rank(A);
    elif case_id eq "mat_z_hnf" then return HermiteForm(A);
    elif case_id in {"mat_z_smith","mat_z_smith_hard"} then return SmithForm(A);
    elif case_id in {"mat_z_elementary_divisors","mat_z_elementary_divisors_hard"} then return ElementaryDivisors(A);
    elif case_id in {"mat_z_charpoly","mat_fp_charpoly","mat_fp31_charpoly","mat_q_charpoly"} then return CharacteristicPolynomial(A);
    elif case_id in {"mat_fp_solve","mat_fp31_solve","mat_q_solve"} then return Solution(Transpose(A),v);
    elif case_id in {"groebner_cyclic","groebner_katsura"} then return GroebnerBasis(I);
    elif case_id eq "class_group" then return ClassGroup(O);
    elif case_id in {"galois_group","galois_group_small"} then return GaloisGroup(pf);
    elif case_id eq "modsym_charpoly" then return CharacteristicPolynomial(HeckeOperator(M,2));
    elif case_id eq "newforms" then return NewformDecomposition(M);
    elif case_id eq "hecke_matrix" then
        // (sign +1: the cuspidal part has S_2's dimension; built in the timer,
        // as ours builds its newspace data in each call)
        return HeckeOperator(CuspidalSubspace(ModularSymbols(389,2,+1)),n);
    elif case_id eq "hecke_matrix_prebuilt" then return HeckeOperator(M,n);
    elif case_id eq "ec_aplist" then return [<p,TraceOfFrobenius(ChangeRing(E,GF(p)))>:p in ps];
    end if;
    error "unknown case";
end function;

function Sig(case_id, n, answer)
    if case_id in {"bigint_mul","bigint_gcd"} then
        return IntegerToString(Ilog2(answer)+1) cat ":" cat IntegerToString(answer mod HMOD);
    elif case_id in {"poly_z_mul","poly_z_gcd","poly_fp_mul","poly_fp_gcd"} then
        return IntegerToString(Degree(answer)) cat ":" cat IntegerToString(SeqHash(Coefficients(answer)));
    elif case_id in {"poly_z_factor","poly_z_factor_product","poly_fp_factor","poly_z_factor_dense","poly_fp_factor_dense"} then
        items := [<Degree(z[1]),z[2],SeqHash(Coefficients(z[1]))>:z in answer]; Sort(~items);
        flat := &cat [[z[1],z[2],z[3]]:z in items];
        return IntegerToString(#items) cat ":" cat IntegerToString(SeqHash(flat));
    elif case_id in {"mat_z_det","mat_z_rank","mat_fp_det","mat_fp31_det","mat_fp_rank","mat_fp31_rank","mat_q_det","mat_q_rank","mat_z_rank_wide","mat_z_rank_def","mat_z_rank_def_p","mat_q_rank_wide","mat_q_rank_def","mat_q_rank_def_p"} then
        return Sprint(answer);
    elif case_id in {"mat_z_charpoly","mat_fp_charpoly","mat_fp31_charpoly","mat_q_charpoly"} then
        return IntegerToString(Degree(answer)) cat ":" cat IntegerToString(SeqHash(Coefficients(answer)));
    elif case_id in {"mat_z_smith","mat_z_smith_hard"} then
        return IntegerToString(n) cat ":" cat IntegerToString(SeqHash([Abs(answer[i,i]):i in [1..n]]));
    elif case_id in {"mat_z_elementary_divisors","mat_z_elementary_divisors_hard"} then
        // (the nonzero divisors only: padded with zeros to n, as the others)
        d := [Integers()| Abs(z) : z in answer] cat [Integers()| 0 : i in [1..n-#answer]];
        return IntegerToString(n) cat ":" cat IntegerToString(SeqHash(d));
    elif case_id in {"mat_z_hnf","mat_fp_solve","mat_fp31_solve","mat_q_solve"} then
        return IntegerToString(n) cat ":" cat IntegerToString(SeqHash(Eltseq(answer)));
    elif case_id in {"groebner_cyclic","groebner_katsura"} then
        ds:=[TotalDegree(f):f in answer]; Sort(~ds); return IntegerToString(#answer) cat ":" cat IntegerToString(SeqHash(ds));
    elif case_id eq "class_group" then
        inv:=[Integers()!z:z in Invariants(answer)]; Sort(~inv); return IntegerToString(#answer) cat ":" cat Join([IntegerToString(z):z in inv],",");
    elif case_id in {"galois_group","galois_group_small"} then return IntegerToString(#answer);
    elif case_id eq "modsym_charpoly" then return IntegerToString(Degree(answer)) cat ":" cat IntegerToString(SeqHash(Coefficients(answer)));
    elif case_id in {"hecke_matrix","hecke_matrix_prebuilt"} then
        g := ChangeRing(CharacteristicPolynomial(answer), Integers());
        return IntegerToString(Degree(g)) cat ":" cat IntegerToString(SeqHash(Coefficients(g)));
    elif case_id eq "newforms" then ds:=[Dimension(B):B in answer]; Sort(~ds); return IntegerToString(#ds) cat ":" cat Join([IntegerToString(d):d in ds],",");
    elif case_id eq "ec_aplist" then return IntegerToString(#answer) cat ":" cat IntegerToString(SeqHash([z[1]*1000+z[2]:z in answer]));
    end if;
    error "unknown case";
end function;

// The combined signature of the K variants' signatures (common.py's
// combined_signature): K and the hash of their bytes joined by ";".
function Combined(sigs)
    c := sigs[1];
    for i in [2..#sigs] do c := c cat ";" cat sigs[i]; end for;
    return IntegerToString(#sigs) cat ":" cat IntegerToString(SeqHash([StringToCode(c[i]) : i in [1..#c]]));
end function;

// k repetitions cycling through the variants (variant idx mod K for the
// idx-th, idx counting across calls): the total time of the operations
// alone (fresh: each on a newly built input).
procedure RunK(case_id, n, Ss, k, fresh, ~idx, ~el)
    el := 0.0;
    for r in [1..k] do
        v := idx mod K;
        idx +:= 1;
        T := fresh select Build(case_id, n, v) else Ss[v+1];
        t := Realtime();
        answer := DoOp(case_id, T);
        el +:= Realtime(t);
    end for;
end procedure;

// Protocol 5 (common.py): the timer's granularity, and batch j's seeded
// starting variant.  Magma's Realtime ticks too coarsely for per-op timing
// (about 10 ms), so this reference is always batched.
function Granularity()
    // (the step between two consecutive ticks: wait for one tick, then time
    // the next; bounded, in case the clock never moves)
    t0 := Realtime(); i := 0;
    repeat t1 := Realtime(); i +:= 1; until t1 gt t0 or i ge 10^7;
    i := 0;
    repeat t2 := Realtime(); i +:= 1; until t2 gt t1 or i ge 10^7;
    d := t2 - t1;
    return d gt 0 select d else 1.0;
end function;

function Offset(seed, j, k)
    return (seed*1000003 + j*7919) mod k;
end function;

if mode eq "inputs" then
    hs := [];
    for v in [0..K-1] do
        S, ops := Build(case_id, n, v);
        Append(~hs, SeqHash(ops));
    end for;
    printf "INPUTS|%o\n", SeqHash(hs);
elif mode eq "once" then
    S, ops := Build(case_id, n, 0);
    t := Realtime();
    answer := DoOp(case_id, S);
    seconds := Realtime(t);
    printf "RESULT|%.9o|%o\n", seconds, Sig(case_id, n, answer);
elif mode in {"time", "time-fresh"} then
    fresh := mode eq "time-fresh";
    Ss := [* *]; sigs := []; warm := 0.0;
    for v in [0..K-1] do
        S, ops := Build(case_id, n, v);
        t := Realtime();
        answer := DoOp(case_id, S);
        warm +:= Realtime(t);
        Append(~sigs, Sig(case_id, n, answer));
        if not fresh then Append(~Ss, S); end if;
    end for;
    idx := 0; el := 0.0;
    per := warm/K;
    if per ge 0.2 then
        k := 1; el := per;
    else
        k := per gt 0 select Max(1, Floor(0.24/per)+1) else K;
        RunK(case_id, n, Ss, k, fresh, ~idx, ~el);
    end if;
    while el lt 0.2 and k lt 2^24 do
        if el le 0 then k := 2*k; else k := Max(2*k, Min(16*k, Floor(k*0.24/el)+1)); end if;
        RunK(case_id, n, Ss, k, fresh, ~idx, ~el);
    end while;
    count := el/k le 2.0 select 5 else 3;
    env := GetEnv("BENCH_SEED");
    seed := env eq "" select 0 else StringToInteger(env);
    samples := []; offsets := [];
    for j in [0..count-1] do
        idx := Offset(seed, j, K);
        Append(~offsets, idx);
        RunK(case_id, n, Ss, k, fresh, ~idx, ~el);
        Append(~samples, el/k);
    end for;
    g := Granularity();
    printf "TIMING|{\"granularity\":%o,\"threshold\":%o,\"seed\":%o,\"k\":%o,\"mode\":\"batched\",\"reps\":%o,\"batches\":[%o],\"offsets\":[%o]}\n",
        Sprintf("%.12o", g), Sprintf("%.12o", Max(0.001, 1000*g)), seed, K, k,
        Join([Sprintf("%.12o", x) : x in samples], ","), Join([IntegerToString(o) : o in offsets], ",");
    Sort(~samples);
    printf "TIME|%.9o|%o|%.9o|%.9o|%o|%o\n", samples[(count div 2)+1], Combined(sigs), samples[1], samples[count], k, count;
else
    error "unknown mode";
end if;
quit;
