# test_ec_torsion_subgroup: recorded deviations from Sage 10.9

None. Every line of test_ec_torsion_subgroup.out is Sage's output: the oracle run on VM2 (SageMath 10.9) of this exact file, on Nov 2 2026 (input cc90cbdc, output e61e4367; frozen in /scratch/sage2-notes/torsion/oracle2).

The generators are PARI's choice (elltors), re-implemented from the rules PARI states. Their choice and the order of T.points() were also checked against Sage for every curve of conductor < 1000 in Cremona's tables with nontrivial torsion: 3438 curves, 0 differences (/scratch/sage2-notes/torsion/dump2, rule2.py and rule4.py). This file's last 38 lines are 3 of those curves per torsion structure.
