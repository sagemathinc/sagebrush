# test_pcimc_quickwins3: recorded deviations from Sage 10.9

Checked against real Sage 10.9 on VM2 on Nov 2 2026: the oracle run of this file plus two statements (input 62553096, output e4249a40; frozen in /scratch/sage2-notes/qw3/oracle2). S37-S47 (daybreak3's B1/B2: zero-row and size-mismatched ZZ matrices with GF(q) vectors, a GF(q) vector times a rational) come from two more VM2 runs, frozen in /scratch/sage2-notes/qw3/oracle3 and oracle4. 42 of the 45 lines of test_pcimc_quickwins3.out are Sage's output. The 3 below are ours:

- S04, S05 and S26: a Python `int` (`int(3)`) to the power of an element of Z/nZ. Sage raises `TypeError: Argument 'self' has incorrect type (expected sage.rings.finite_rings.integer_mod.IntegerMod_int, got int)`. Sagebrush's Sage-mode integers are Python ints, so `int(3)` and `3` are the same object here: both give Sage's Integer result (`3^GF(2)(1)` is 3, S01), and S26 is `[2, 3]`.

Not tested: the oracle's S12 (`x^GF(5)(3)`: `x` was undefined in the oracle's script) and S30 (`vector(ZZ, GF(3)^2([1, 2]))`: Sage's preparser reads `GF(3)^2(...)` as a call on an integer).
