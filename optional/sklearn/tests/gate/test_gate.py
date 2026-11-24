# The whole acceptance gate (the design's M1 list): every classifier on iris, wine, breast cancer and digits and every
# regressor on wine, breast cancer and digits, with seeds 0, 1 and 42 and on a perturbed input; 4,548 trees,
# each compared in full. Outside CI (it takes minutes): tests/gate/run.sh runs it and compares it with test_gate.out,
# scikit-learn 1.9.1's own output (recorded by run.sh --record in the pinned oracle environment).
import sys

sys.path.insert(0, "..")  # (tests/, for _cases and _gate: run.sh runs this from tests/gate)

from _gate import run  # noqa: E402

run(["iris", "wine", "cancer", "digits"], ["wine", "cancer", "digits"], (0, 1, 42))
