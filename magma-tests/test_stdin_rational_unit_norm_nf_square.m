// IsUnit and Norm of rationals (Q!2 too: its field's rules), IsSquare in quadratic fields
Q := Rationals();
qs := [Q!(a/b) : b in [1..7], a in [-10..10]];
print [IsUnit(x) : x in qs] eq [x ne 0 : x in qs];
print [Norm(x) : x in qs] eq qs, [Trace(x) : x in qs] eq qs;
print [IsUnit(Q!x) : x in [0, 1, 2, -3, 1/2, -3/5]], [IsUnit(x) : x in [0, 1, -1, 2, -3]];
print [Norm(Q!x) : x in [0, 1, 2, -3, 1/2, -3/5]], [Norm(x) : x in [0, 1, 2, -3]];
print Type(Norm(-3)), Type(Norm(Q!2)), Type(Q!2);
for d in [-7, -3, -1, 2, 3, 5, 7, 13] do
  K<w> := QuadraticField(d);
  out := [];
  for u in [-2..2] do for v in [-2..2] do
    s, r := IsSquare((u + v*w)^2);
    Append(~out, s and r^2 eq (u + v*w)^2);
  end for; end for;
  print d, &and out, #out;
end for;
K<a> := QuadraticField(2);
for y in [a^2, (a+1)^2, K!0, K!1, K!4, K!2, (1-a)^2, (-2+a)^2, K!9, K!(9/4)] do
  s, r := IsSquare(y); print s, r;
end for;
print IsSquare(a), IsSquare(K!3), IsSquare(1 + a);
s, r := IsSquare(a); print s, assigned r;
s, r := IsSquare(2); print s, assigned r;
s, r := IsSquare(Q!(2/3)); print s, assigned r;
s, r := IsSquare(9); print s, r;
L<b> := QuadraticField(-7);
for y in [(b-1)^2, L!(-7), L!(9/4), (2*b+3)^2] do
  s, r := IsSquare(y); print s, r;
end for;
M<c> := QuadraticField(5);
s, r := IsSquare(((1+c)/2)^2); print s, r;
