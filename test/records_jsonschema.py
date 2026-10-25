# Cross-checks lib/sagebrush/records.py's validator against the jsonschema
# package (a reference implementation), on every case of
# test/records_cases.py: both accept, or both refuse.  Exit status 3 when
# jsonschema is not installed (the test skips).
import contextlib
import io
import os
import runpy
import sys

try:
    import jsonschema
except ImportError:
    sys.exit(3)

here = os.path.dirname(os.path.abspath(__file__))
with contextlib.redirect_stdout(io.StringIO()):
    g = runpy.run_path(os.path.join(here, "records_cases.py"))
R, change = g["R"], g["change"]
for s in R.SCHEMAS.values():
    jsonschema.Draft202012Validator.check_schema(s)
records = [g[n] for n in ("estimate", "running", "untracked", "partial", "outcome", "complete", "error", "checkpoint")]
records += [change(r, path, value) for _, r, path, value in g["cases"]]
n = 0
for r in records:
    kind = r["schema"][len("sagebrush."):-2]
    ref = jsonschema.Draft202012Validator(R.SCHEMAS[kind]).is_valid(r)
    try:
        R.validate(r)
        ours = True
    except ValueError:
        ours = False
    if ours != ref:
        print("disagree:", r)
        sys.exit(1)
    n += 1
print("agree: %d cases" % n)
