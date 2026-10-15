// Maps: map< A -> B | ... >, pmap< ... >, hom< ... > with a rule.
// Read on stdin (a session), so that the errors don't stop it.
sq := map< Integers() -> Integers() | n :-> n^2 - n >;
sq;
sq(6), 7 @ sq, Type(sq);
Domain(sq);
Codomain(sq);
half := map< Integers() -> Rationals() | n :-> n / 4 >;
half(10);
both := sq * half;
both;
both(5);
[ sq(i) : i in [0..5] ];
sq({ 1, 2, 3 });
// with an inverse rule
shift := map< Integers() -> Integers() | a :-> a + 10, b :-> b - 10 >;
shift;
shift(1), 21 @@ shift, Inverse(shift)(30);
Inverse(shift);
Inverse(Inverse(shift));
Inverse(shift * shift);
(shift * shift)(0);
hom< Integers() -> Integers() | t :-> 7*t >(3);
// given by a graph: pairs or arrows
Dom := { 1, 2, 3 };
Cod := { 5, 6 };
g := map< Dom -> Cod | [ <1, 5>, <3, 6>, <2, 5> ] >;
g;
g(3), 2 @ g;
Image(g);
a := map< Dom -> Cod | [ 2 -> 6, 1 -> 6, 3 -> 5 ] >;
a;
a(1);
p := pmap< Dom -> Cod | [ <2, 6> ] >;
p;
p(2);
// structures named by the variables that hold them
Z := Integers();
map< Z -> Z | z :-> -z >;
map< { 4, 5 } -> Z | [ <4, 0>, <5, 1> ] >;
// graphs that don't fit
map< Dom -> Cod | [ <1, 5>, <2, 6> ] >;
map< Dom -> Cod | [ <1, 5>, <2, 9>, <3, 5> ] >;
// graphs: at most one image per element; a map's covers a finite domain
map< Dom -> Cod | [ <1, 5>, <1, 6>, <2, 5>, <3, 6> ] >;
pmap< Dom -> Cod | [ <2, 5>, <2, 6> ] >;
map< [1..4] -> Z | [ <1, 0>, <2, 0>, <3, 0> ] >;
map< [1..3] -> Z | [ <1, 0>, <2, 0>, <3, 1> ] >(3);
map< Z -> Z | [ <1, 2> ] >;
// a rule takes the values its variables have when the map is made
c := 2;
plus := map< Z -> Z | n :-> n + c, m :-> m - c >;
L := [1, 2];
len := map< Z -> Z | n :-> n + #L >;
c := 100; L := [1, 2, 3, 4, 5];
plus(1), 9 @@ plus, len(0);
lst := map< Z -> Z | n :-> &+[ j : j in [1..n] | IsOdd(j) ] + c >;
lst(5);
ex := map< Z -> Z | n :-> #[ e : e in L | e gt n ] >;
ex(2);
// preimages: in the codomain, back in the domain, through compositions
dbl := map< Z -> Z | n :-> 2*n, m :-> m div 2 >;
10 @@ dbl;
(1/2) @@ dbl;
hlf := map< Z -> Z | n :-> n, m :-> m / 2 >;
4 @@ hlf;
3 @@ hlf;
inc := map< Z -> Z | n :-> n + 1, m :-> m - 1 >;
7 @@ (inc * inc), Inverse(inc * inc)(7);
3 @@ g;
// free variables are found by scope: a comprehension's or a func's own
// variables shadow, the outer ones are still captured
jj := 10;
sh := map< Z -> Z | n :-> jj + &+[ jj : jj in [1..n] ] >;
jj := 20;
sh(2);
fu := map< Z -> Z | n :-> (func<jj | jj + 1>)(n) >;
fu(3);
kk := 5;
sc := map< Z -> Z | n :-> #[ kk : kk in [1..n] | kk gt 1 ] + kk, m :-> m - kk >;
kk := 50;
sc(4), 9 @@ sc;
mm := 3;
ns := map< Z -> Z | n :-> map< Z -> Z | t :-> t + mm >(n) * mm >;
mm := 30;
ns(2);
fn := func< q | q * mm >;
vf := map< Z -> Z | n :-> fn(n) >;
fn := func< q | q >;
vf(2);
// assigned: the snapshot says whether a variable was assigned when the map was made
as1 := map< Z -> Z | n :-> assigned va select 1 else 0 >;
va := 9;
as1(1);
as2 := map< Z -> Z | n :-> assigned vb select vb else n >;
as2(5);
vb := 100;
as2(5);
RF := recformat< a, b >;
vr := rec< RF | a := 1 >;
as3 := map< Z -> Z | n :-> assigned vr`b select 1 else 2 >;
vr := rec< RF | a := 1, b := 2 >;
as3(0);
as4 := map< Z -> Z | n :-> n, m :-> assigned vd select m + vd else m >;
vd := 4;
3 @@ as4;
// a rule inside a rule: an outer snapshot that was unassigned stays so
nz1 := map< Z -> Z | x :-> map< Z -> Z | y :-> assigned vq select 1 else 0 >(x) >;
nz2 := map< Z -> Z | x :-> map< Z -> Z | y :-> assigned vq select vq + y else y >(x) >;
nz3 := map< Z -> Z | x :-> map< Z -> Z | y :-> map< Z -> Z | w :-> assigned vq select 7 else w >(y) >(x) >;
vq := 9;
nz1(0), nz2(3), nz3(4);
vs := 2;
nz4 := map< Z -> Z | x :-> map< Z -> Z | y :-> vs * y + x >(x + 1) >;
vs := 50;
nz4(3);
// assigned of a free name: the rule's own local, so false even with a value
va := 3;
fa := map< Z -> Z | y :-> assigned va select va + y else -y >;
fa(2);
fb := map< Z -> Z | b :-> map< Z -> Z | y :-> assigned b select 1 else 2 >(b) >;
fb(1);
fp := map< Z -> Z | y :-> (assigned y select 10 else 0) + #[ c : c in [1..y] | assigned c ] >;
fp(4);
// read first, then assigned: rejected before it runs
fc := map< Z -> Z | y :-> va + (assigned va select 1 else 0) >;
fc(1);
// the inverse rule is a scope of its own
fd := map< Z -> Z | y :-> va + y, x :-> assigned va select 1 else 0 >;
3 @@ fd;
fd(1);
vk := 1;
fe := map< Z -> Z | y :-> assigned vk select 1 else 0 >;
delete vk;
fe(0);
// assigned r``e: the record is read first, so an `assigned r` inside the
// computed field name comes after the import and is rejected
GF2 := recformat< p, q >;
rg := rec< GF2 | p := 5 >;
fg := map< Z -> Z | y :-> assigned rg``(assigned rg select "p" else "q") >;
fh := map< Z -> Z | y :-> assigned rg``(y gt 0 select "p" else "q") select 1 else 2 >;
fh(1), fh(-1);
