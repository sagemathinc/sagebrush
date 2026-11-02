# test_floor_ceil_exact: recorded deviations from Sage 10.9
test_floor_ceil_exact.out is SageMath 10.9's output (VM2, ~/sage-conda; oracle input d7c9aa4f…, output c30b5eb3…) minus the line of the statement below, which was dropped; every remaining line is Sage's, verbatim.
- S26: `ceiling(sqrt(3))`. Sage 10.9: `NameError: name 'ceiling' is not defined` (Sage has no `ceiling`). Sagebrush already had `ceiling` as an alias of `ceil` before this change and keeps it (it now returns the Integer 2, as `ceil` does); removing a working name is not this PR's business.
