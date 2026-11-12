// Long operator chains (33 or more operators are translated flat in Sagebrush): each operand evaluated once,
// left to right; and/or skip the rest; an error at its own operator, and nothing after it evaluated.
f := function(k) printf "%o ", k; return k; end function;
t := function(b, k) printf "%o ", k; return b; end function;
// 32 and 33 operators, the same sum
a := f(1) + f(2) + f(3) + f(4) + f(5) + f(6) + f(7) + f(8) +
  f(9) + f(10) + f(11) + f(12) + f(13) + f(14) + f(15) + f(16) +
  f(17) + f(18) + f(19) + f(20) + f(21) + f(22) + f(23) + f(24) +
  f(25) + f(26) + f(27) + f(28) + f(29) + f(30) + f(31) + f(32) +
  f(33);
print ""; print a;
b := f(1) + f(2) + f(3) + f(4) + f(5) + f(6) + f(7) + f(8) +
  f(9) + f(10) + f(11) + f(12) + f(13) + f(14) + f(15) + f(16) +
  f(17) + f(18) + f(19) + f(20) + f(21) + f(22) + f(23) + f(24) +
  f(25) + f(26) + f(27) + f(28) + f(29) + f(30) + f(31) + f(32) +
  f(33) + f(34);
print ""; print b;
// + and - mixed, 40 terms
c := f(1) + f(2) - f(3) + f(4) + f(5) - f(6) + f(7) + f(8)
   - f(9) + f(10) + f(11) - f(12) + f(13) + f(14) - f(15) + f(16)
   + f(17) - f(18) + f(19) + f(20) - f(21) + f(22) + f(23) - f(24)
   + f(25) + f(26) - f(27) + f(28) + f(29) - f(30) + f(31) + f(32)
   - f(33) + f(34) + f(35) - f(36) + f(37) + f(38) - f(39) + f(40)
  ;
print ""; print c;
// * div mod in one chain
d := 1000 * 7 div 3 mod 1000 * 11 div 2 * 7 div 3 mod 1000 * 11 div 2
   * 7 div 3 mod 1000 * 11 div 2 * 7 div 3 mod 1000 * 11 div 2
   * 7 div 3 mod 1000 * 11 div 2 * 7 div 3 mod 1000 * 11 div 2
   * 7 div 3 mod 1000 * 11 div 2 * 7 div 3 mod 1000 * 11 div 2
  ;
print d;
// join
S := {1} join {2} join {3} join {4} join {5} join {6} join {7} join {8} join
  {9} join {10} join {11} join {12} join {13} join {14} join {15} join {16} join
  {17} join {18} join {19} join {20} join {21} join {22} join {23} join {24} join
  {25} join {26} join {27} join {28} join {29} join {30} join {31} join {32} join
  {33} join {34} join {35};
print S;
// meet
T := {1..40} meet {2..40} meet {3..40} meet {4..40} meet {5..40} meet {6..40} meet {7..40} meet {8..40} meet
  {9..40} meet {10..40} meet {11..40} meet {12..40} meet {13..40} meet {14..40} meet {15..40} meet {16..40} meet
  {17..40} meet {18..40} meet {19..40} meet {20..40} meet {21..40} meet {22..40} meet {23..40} meet {24..40} meet
  {25..40} meet {26..40} meet {27..40} meet {28..40} meet {29..40} meet {30..40} meet {31..40} meet {32..40} meet
  {33..40} meet {34..40} meet {35..40};
print T;
// cat
U := [1] cat [2] cat [3] cat [4] cat [5] cat [6] cat [7] cat [8] cat
  [9] cat [10] cat [11] cat [12] cat [13] cat [14] cat [15] cat [16] cat
  [17] cat [18] cat [19] cat [20] cat [21] cat [22] cat [23] cat [24] cat
  [25] cat [26] cat [27] cat [28] cat [29] cat [30] cat [31] cat [32] cat
  [33] cat [34] cat [35];
print U;
V := "a" cat "b" cat "c" cat "d" cat "e" cat "f" cat "g" cat "h" cat
  "i" cat "j" cat "k" cat "l" cat "m" cat "n" cat "o" cat "p" cat
  "q" cat "r" cat "s" cat "t" cat "u" cat "v" cat "w" cat "x" cat
  "y" cat "z" cat "a" cat "b" cat "c" cat "d" cat "e" cat "f" cat
  "g" cat "h" cat "i";
print V;
// and: the first false ends it
g := t(true, 1) and t(true, 2) and t(true, 3) and t(true, 4) and t(true, 5) and t(true, 6) and
  t(true, 7) and t(true, 8) and t(true, 9) and t(false, 10) and t(true, 11) and t(true, 12) and
  t(true, 13) and t(true, 14) and t(true, 15) and t(true, 16) and t(true, 17) and t(true, 18) and
  t(true, 19) and t(true, 20) and t(true, 21) and t(true, 22) and t(true, 23) and t(true, 24) and
  t(true, 25) and t(true, 26) and t(true, 27) and t(true, 28) and t(true, 29) and t(true, 30) and
  t(true, 31) and t(true, 32) and t(true, 33) and t(true, 34) and t(true, 35) and t(true, 36) and
  t(true, 37) and t(true, 38) and t(true, 39) and t(true, 40);
print ""; print g;
// or: the first true ends it
h := t(false, 1) or t(false, 2) or t(false, 3) or t(false, 4) or t(false, 5) or t(false, 6) or
  t(false, 7) or t(false, 8) or t(false, 9) or t(false, 10) or t(false, 11) or t(true, 12) or
  t(false, 13) or t(false, 14) or t(false, 15) or t(false, 16) or t(false, 17) or t(false, 18) or
  t(false, 19) or t(false, 20) or t(false, 21) or t(false, 22) or t(false, 23) or t(false, 24) or
  t(false, 25) or t(false, 26) or t(false, 27) or t(false, 28) or t(false, 29) or t(false, 30) or
  t(false, 31) or t(false, 32) or t(false, 33) or t(false, 34) or t(false, 35) or t(false, 36) or
  t(false, 37) or t(false, 38) or t(false, 39) or t(false, 40);
print ""; print h;
// xor
x := t(false, 1) xor t(false, 2) xor t(false, 3) xor t(true, 4) xor t(false, 5) xor t(false, 6) xor
  t(false, 7) xor t(true, 8) xor t(false, 9) xor t(false, 10) xor t(false, 11) xor t(true, 12) xor
  t(false, 13) xor t(false, 14) xor t(false, 15) xor t(true, 16) xor t(false, 17) xor t(false, 18) xor
  t(false, 19) xor t(true, 20) xor t(false, 21) xor t(false, 22) xor t(false, 23) xor t(true, 24) xor
  t(false, 25) xor t(false, 26) xor t(false, 27) xor t(true, 28) xor t(false, 29) xor t(false, 30) xor
  t(false, 31) xor t(true, 32) xor t(false, 33) xor t(false, 34) xor t(false, 35) xor t(true, 36) xor
  t(false, 37) xor t(false, 38) xor t(false, 39) xor t(true, 40);
print ""; print x;
// a long chain inside an operand of another
y := f(1) + (f(100) + f(101) + f(102) + f(103) + f(104) + f(105) + f(106) + f(107) +
  f(108) + f(109) + f(110) + f(111) + f(112) + f(113) + f(114) + f(115) +
  f(116) + f(117) + f(118) + f(119) + f(120) + f(121) + f(122) + f(123) +
  f(124) + f(125) + f(126) + f(127) + f(128) + f(129) + f(130) + f(131) +
  f(132) + f(133) + f(134) + f(135) + f(136) + f(137) + f(138) + f(139)) * 2 +
  f(2) + f(3) + f(4) + f(5) + f(6) + f(7) + f(8) + f(9) +
  f(10) + f(11) + f(12) + f(13) + f(14) + f(15) + f(16) + f(17) +
  f(18) + f(19) + f(20) + f(21) + f(22) + f(23) + f(24) + f(25) +
  f(26) + f(27) + f(28) + f(29) + f(30) + f(31) + f(32) + f(33) +
  f(34) + f(35) + f(36) + f(37);
print ""; print y;
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
