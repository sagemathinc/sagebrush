# The acceptance gate's CI subset: seed 0 and a perturbed input, on iris and wine (the regressors on wine). The
# whole gate (four datasets, seeds 0, 1 and 42) runs outside CI: tests/gate/run.sh. The cases are in _gate.py.
from _gate import run

run(["iris", "wine"], ["wine"], (0,))
