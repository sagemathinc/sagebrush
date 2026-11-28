# The scikit-learn oracle

The comparison tests' expected outputs come from scikit-learn 1.9.1 under CPython, run in a venv (`$VENV` below; `tests/oracle-env.txt` lists the interpreter and packages it must report). Only `tests/gen-oracle.sh`, `tests/gen-data.py` and `tests/gen-names.py` run it; Sagebrush itself never does.

**Environment:** `tests/oracle-env.txt` records the interpreter and the packages that matter (numpy, pandas, scikit-learn, scipy, joblib, threadpoolctl). `gen-oracle.sh` refuses to write anything when the venv reports anything else.

**How the programs run:** `python -I -W ignore`, with `PYTHONHASHSEED=0` and `COLUMNS`/`LINES` unset. Only stdout is recorded: warnings go to stderr, which the comparison doesn't read.
