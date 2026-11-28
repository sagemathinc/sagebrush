import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// scipy.stats' forms Sagebrush doesn't compute are refused, never answered with another computation (the Codex audit
// R02b): spearmanr of two 2-d samples, which SciPy answers with the matrix of the variables' correlations, once
// flattened both into one correlation.  1-d samples, the control, still give SciPy's correlation (scipy-tests compare
// those values).
const py = (code: string) => execFileSync(process.execPath, [__dirname + "/../src/cli.js", "-c", code], { encoding: "utf8" });

test("spearmanr of two 2-d samples is refused, not two samples flattened; 1-d samples still answer", () => {
  const got = py(`
import numpy as np
from scipy import stats
a = np.array([[1, 3], [2, 2], [3, 1]])
b = np.array([[3, 1], [2, 2], [1, 3]])
for x, y in ((a, b), (a, b[:, 0]), (a[:, 0], b)):
    try:
        print(stats.spearmanr(x, y))
    except NotImplementedError as e:
        print("NotImplementedError", e)
r = stats.spearmanr(a[:, 0], b[:, 0])
print(float(r.statistic), float(r.pvalue))
`);
  const refused = "NotImplementedError scipy.stats.spearmanr: 2-d samples (a matrix of the variables' correlations) are not supported in Sagebrush (give two 1-d samples)";
  assert.equal(got, `${refused}\n${refused}\n${refused}\n-1.0 0.0\n`);
});
