// a range of integers only: integral endpoints taken as integers, others refused
r1 := [1/3 .. 4];
r2 := [2 .. 9/2];
r3 := [1 .. 5 by 1/3];
r4 := {1/3 .. 4};
r5 := [2.5 .. 6];
[2.0 .. 5]; [2 .. 5.0]; [2 .. 10/2]; [2 .. 9 by 3/1]; {2 .. 10/2}; [4/2 .. 5];
r6 := [1 .. 6 by 0];
r7 := {1 .. 6 by 0};
T := [4, 5, 6, 7]; T[1/3 .. 2];
T[1 .. 3.0]; T[2/2 .. 2];
"end";
// a universe is checked before the range itself
u1 := [Rationals() | 1/3 .. 4];
u2 := [Rationals() | 1 .. 4 by 0];
u3 := {Rationals() | 1/3 .. 4};
u4 := [RealField(30) | 1 .. 4 by 1/2];
u5 := {RealField(30) | 1 .. 4 by 0};
"end2";
