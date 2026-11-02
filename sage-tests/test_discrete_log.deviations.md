# test_discrete_log: recorded deviations from Sage 10.9
test_discrete_log.out is SageMath 10.9's output (VM2, ~/sage-conda; oracle input b5c5aa0a…, output 574c090f…) minus the line of the statement below, which was dropped; every remaining line is Sage's, verbatim.
- S26: `type(discrete_log(Mod(5, p), g))`. Sage: `<class 'sage.rings.integer.Integer'>`. Ours: `<class 'int'>`. The same tracked follow-up as test_pcimc_quickwins S03/S08/S16/S49/S59: in Sagebrush, Sage's integers are Python ints with Integer's methods dispatched on them; the values agree, the type name does not.
