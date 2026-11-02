# test_matrix_sr: recorded deviations from Sage 10.9

None. All 94 lines of test_matrix_sr.out are Sage's output: the counted VM2 oracle run of this exact file (/scratch/sage2-notes/kernel/oracle/out6, oracle.out be4b0a38; input 8e5999c3), on Nov 1 2026.

Fixed by lane 4b-2 (Sage's division-free characteristic polynomial, with det for n >= 4 and the adjugate from it; now Sage's): lines 13 (the 4x4 det), 78 (the 3x3 adjugate), 80 (the 4x4 adjugate) and 81 (the 5x5 adjugate), the 4 lines approved by @sagebrush on Nov 1 as pending 4b-2.

Fixed after the oracle (now Sage's, (c)): line 10's expansion (the first column, Sage's formula), line 82 (the 0 x 0 adjugate is a TypeError), and lines 93-94 (the zero test's trig_reduce proof stage, astra3's A3 ruling).

Fixed by lane 4p (the print order of sums and products, P-SPEC v2; now Sage's): lines 9, 10, 14, 33, 34, 36, 38, 39, 40 and 43, which were the 10 print-order lines of the Nov 1 approvals.
