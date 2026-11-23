// Integer literals as Magma 2.18-5 reads them (a session: each error is reported and the input goes on).
// Hexadecimal, a lower-case x and digits of either case:
print 0x1f;
print 0x1F, 0xABCdef, 0x00ff, 0x0;
print -0x10, 0x5 + 1, Type(0x5);
print 0xffffffffffffffffffffffffffffffff;
print 0x1e5;
x := 0x5;
print x;
print [0x1..3];
// any ONE digit before the x, which is ignored
print 1x5, 2x5, 9x5, 7xA, 1x10, 1xff, 9xff;
// digits and an x that aren't one: "Invalid hexadecimal integer", at the x
print 0x;
print 0xg;
print 0x 5;
print 0x_5;
print 00x5;
print 10x5;
print 2x;
print 1x;
print 01x5;
print 11x5;
// a hexadecimal literal followed by a letter, or an upper-case X: bad syntax there
print 0x1g;
print 0x5x5;
print 3x1g;
print 0X5;
// leading zeros
print 007, 0010, -000, 00;
print "end";
