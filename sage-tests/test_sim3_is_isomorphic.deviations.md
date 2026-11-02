# test_sim3_is_isomorphic: recorded deviations from Sage 10.9

None. Every line of test_sim3_is_isomorphic.out is Sage's output: the oracle run on VM2 (SageMath 10.9) of this file with two more statements, on Nov 2 2026 (input 7035f8d5, output 2b84f1ae; frozen in /scratch/sage2-notes/sim3/oracle1).

Not tested: the oracle's S01, the simulated agent's own case (the Galois group of x^5 - x - 1 against SymmetricGroup(5)). Sage 10.9 overflowed PARI's 1 GB stack computing that Galois group on VM2. S04 checks the same group, TransitiveGroup(5, 5) = S5. Also not tested: S06, DihedralGroup(4) against QuaternionGroup(), which Sagebrush doesn't have.
