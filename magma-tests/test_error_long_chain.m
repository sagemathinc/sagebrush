// Long operator chains (17 or more operators are translated flat in Sagebrush): each operand evaluated once,
// left to right; and/or skip the rest; an error at its own operator, and nothing after it evaluated.
f := function(k) printf "%o ", k; return k; end function;
t := function(b, k) printf "%o ", k; return b; end function;
// 16 and 17 operators, the same sum
a := f(1) + f(2) + f(3) + f(4) + f(5) + f(6) + f(7) + f(8) + f(9) + f(10) + f(11) + f(12) + f(13) + f(14) + f(15) + f(16) + f(17); print ""; print a;
b := f(1) + f(2) + f(3) + f(4) + f(5) + f(6) + f(7) + f(8) + f(9) + f(10) + f(11) + f(12) + f(13) + f(14) + f(15) + f(16) + f(17) + f(18); print ""; print b;
// + and - mixed, 30 terms
c := f(1) + f(2) - f(3) + f(4) + f(5) - f(6) + f(7) + f(8) - f(9) + f(10) + f(11) - f(12) + f(13) + f(14) - f(15) + f(16) + f(17) - f(18) + f(19) + f(20) - f(21) + f(22) + f(23) - f(24) + f(25) + f(26) - f(27) + f(28) + f(29) - f(30); print ""; print c;
// * div mod in one chain
d := 1000 * 7 div 3 mod 1000 * 11 div 2 * 7 div 3 mod 1000 * 11 div 2 * 7 div 3 mod 1000 * 11 div 2 * 7 div 3 mod 1000 * 11 div 2; print d;
// join diff sdiff meet
S := {1} join {2} join {3} join {4} join {5} join {6} join {7} join {8} join {9} join {10} join {11} join {12} join {13} join {14} join {15} join {16} join {17} join {18}; print S;
T := {1..20} meet {2..20} meet {3..20} meet {4..20} meet {5..20} meet {6..20} meet {7..20} meet {8..20} meet {9..20} meet {10..20} meet {11..20} meet {12..20} meet {13..20} meet {14..20} meet {15..20} meet {16..20} meet {17..20} meet {18..20}; print T;
// cat
U := [1] cat [2] cat [3] cat [4] cat [5] cat [6] cat [7] cat [8] cat [9] cat [10] cat [11] cat [12] cat [13] cat [14] cat [15] cat [16] cat [17] cat [18]; print U;
V := "a" cat "b" cat "c" cat "d" cat "e" cat "f" cat "g" cat "h" cat "i" cat "j" cat "k" cat "l" cat "m" cat "n" cat "o" cat "p" cat "q" cat "r"; print V;
// and: the first false ends it
g := t(true, 1) and t(true, 2) and t(true, 3) and t(true, 4) and t(true, 5) and t(true, 6) and t(true, 7) and t(true, 8) and t(true, 9) and t(false, 10) and t(true, 11) and t(true, 12) and t(true, 13) and t(true, 14) and t(true, 15) and t(true, 16) and t(true, 17) and t(true, 18) and t(true, 19) and t(true, 20); print ""; print g;
// or: the first true ends it
h := t(false, 1) or t(false, 2) or t(false, 3) or t(false, 4) or t(false, 5) or t(false, 6) or t(false, 7) or t(false, 8) or t(false, 9) or t(false, 10) or t(false, 11) or t(true, 12) or t(false, 13) or t(false, 14) or t(false, 15) or t(false, 16) or t(false, 17) or t(false, 18) or t(false, 19) or t(false, 20); print ""; print h;
// xor
x := t(false, 1) xor t(false, 2) xor t(false, 3) xor t(true, 4) xor t(false, 5) xor t(false, 6) xor t(false, 7) xor t(true, 8) xor t(false, 9) xor t(false, 10) xor t(false, 11) xor t(true, 12) xor t(false, 13) xor t(false, 14) xor t(false, 15) xor t(true, 16) xor t(false, 17) xor t(false, 18) xor t(false, 19) xor t(true, 20); print ""; print x;
// a long chain inside an operand of another
y := f(1) + (f(100) + f(101) + f(102) + f(103) + f(104) + f(105) + f(106) + f(107) + f(108) + f(109) + f(110) + f(111) + f(112) + f(113) + f(114) + f(115) + f(116) + f(117) + f(118) + f(119)) * 2 + f(2) + f(3) + f(4) + f(5) + f(6) + f(7) + f(8) + f(9) + f(10) + f(11) + f(12) + f(13) + f(14) + f(15) + f(16) + f(17) + f(18) + f(19); print ""; print y;
// the 30th operator of 40 fails: nothing after it is evaluated, and the file stops
z := f(1) + f(2) + f(3) + f(4) + f(5) +
  f(6) + f(7) + f(8) + f(9) + f(10) +
  f(11) + f(12) + f(13) + f(14) + f(15) +
  f(16) + f(17) + f(18) + f(19) + f(20) +
  f(21) + f(22) + f(23) + f(24) + f(25) +
  f(26) + f(27) + f(28) + f(29) + f(30) +
  "s" + f(31) + f(32) + f(33) + f(34) +
  f(35) + f(36) + f(37) + f(38) + f(39) +
  f(40);
print "not reached";
