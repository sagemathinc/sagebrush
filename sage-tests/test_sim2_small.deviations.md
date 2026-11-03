# test_sim2_small: recorded deviations from Sage 10.9

Checked against real Sage 10.9 on VM2 on Nov 2 2026: the oracle run of this file plus two statements (input cd26a3c4, output a2bac3a4; frozen in /scratch/sage2-notes/small/oracle2). 18 of the 21 lines are Sage's output. The 3 below are ours:

- S11, S12, S13: `NumberField([x^2-2, x^2-3], ...)`. Sage builds a relative number field (a tower, "Number Field in a0 with defining polynomial x^2 - 2 over its base field"). Sagebrush has absolute fields only and refuses with a NotImplementedError that points to the absolute field, defined by the minimal polynomial of a primitive element (`(sqrt(2) + sqrt(3)).minpoly()`, S01). This replaces the TypeError the simulated agents met.

Not tested: the oracle's S02, `(sqrt(2) + sqrt(3)).minimal_polynomial()` (an AttributeError in Sage too; its message names Sage's class path), and S09, `QQ(3/2).minpoly()` (x - 3/2 in Sage; Sagebrush's rationals have no minpoly yet).
