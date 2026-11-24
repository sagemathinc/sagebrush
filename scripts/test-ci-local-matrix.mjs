// ci: checks.6 order=32
// scripts/ci-local.py's matrices and CI's choice idiom: an `include:` that is the changes job's whole list expands to
// exactly the combinations scripts/ci-paths.mjs gives CI on a full run, one per object; any other include, and an
// exclude, is refused; `X == 'v' && A || B` gives GitHub's value in a timeout and an env value, and anything else
// there is refused.  The functions are ci-paths.mjs's and ci-local.py's own (no PyYAML needed): this runs them.
//   node scripts/test-ci-local-matrix.mjs
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const paths = spawnSync("node", [join(root, "scripts", "ci-paths.mjs")], {
  cwd: root,
  encoding: "utf8",
  env: { ...process.env, GITHUB_EVENT_NAME: "workflow_dispatch", CI_LONG: "", GITHUB_OUTPUT: "" },
});
const line = paths.stdout.split("\n").find((l) => l.startsWith("web_matrix="));
if (paths.status !== 0 || !line) {
  console.log(`FAIL scripts/ci-paths.mjs: exit ${paths.status}, web_matrix ${line ? "found" : "missing"}`);
  process.exit(1);
}
const expected = line.slice("web_matrix=".length);

const controls = String.raw`
import ast, itertools, json, os, re, subprocess, sys
root, expected = sys.argv[1], json.loads(sys.argv[2])
src = open(os.path.join(root, "scripts", "ci-local.py")).read()
names = {"matrix_of", "changes_output", "values_of", "choice", "job_minutes", "substitute", "Unsupported"}
tree = ast.parse(src)
body = [n for n in tree.body if (isinstance(n, (ast.FunctionDef, ast.ClassDef)) and n.name in names)
        or (isinstance(n, ast.Assign) and getattr(n.targets[0], "id", "") in ("CHOICE", "CI_CONTEXT"))]
g = {"itertools": itertools, "json": json, "os": os, "re": re, "subprocess": subprocess, "ROOT": root, "LONG": False}
exec(compile(ast.Module(body=body, type_ignores=[]), "ci-local", "exec"), g)
U = g["Unsupported"]
rows = []
def row(name, ok, detail=""):
    rows.append(f"{'ok  ' if ok else 'FAIL'} {name}{': ' + str(detail) if detail else ''}")
def refused(f):
    try:
        f()
        return False
    except U:
        return True

inc = "$" + "{{ fromJSON(needs.changes.outputs.web_matrix) }}"
got = g["matrix_of"]({"strategy": {"matrix": {"include": inc}}})
row("the changes job's include is its full-run list, one combination per object", got == expected and len(got) > 0, got)
row("a literal include is refused", refused(lambda: g["matrix_of"]({"strategy": {"matrix": {"include": [{"a": 1}]}}})))
row("an include beside other keys is refused", refused(lambda: g["matrix_of"]({"strategy": {"matrix": {"k": [1, 2], "include": inc}}})))
row("an exclude is refused", refused(lambda: g["matrix_of"]({"strategy": {"matrix": {"k": [1, 2], "exclude": [{"k": 1}]}}})))
row("a key's list still expands", g["matrix_of"]({"strategy": {"matrix": {"k": [1, 2]}}}) == [{"k": 1}, {"k": 2}])

e = lambda x: "$" + "{{ " + x + " }}"
t = lambda x: {"timeout-minutes": e(x)}
row("timeout: the notebook job's 45", g["job_minutes"](t("matrix.name == 'notebook' && 45 || 30"), {"name": "notebook"}) == 45)
row("timeout: another job's 30", g["job_minutes"](t("matrix.name == 'notebook' && 45 || 30"), {"name": "board"}) == 30)
row("timeout: a changes output's choice (long, false on a full run)", g["job_minutes"](t("needs.changes.outputs.long == 'true' && 40 || 20"), {}) == 20)
row("timeout: a number, and the default 360", g["job_minutes"]({"timeout-minutes": 15}, {}) == 15 and g["job_minutes"]({}, {}) == 360)
row("timeout: another expression is refused", refused(lambda: g["job_minutes"](t("github.event_name == 'push' && 5 || 6"), {})))
row("timeout: a matrix key the job doesn't have is refused", refused(lambda: g["job_minutes"](t("matrix.nope == 'x' && 5 || 6"), {"name": "a"})))
ctx = lambda m: {"matrix": m, "temp": "", "sha": ""}
latex = e("matrix.name == 'latex' && 'test' || ''")
row("env: the latex job's 'test'", g["substitute"](latex, ctx({"name": "latex"}), lenient=True) == "test")
row("env: another job's ''", g["substitute"](latex, ctx({"name": "board"}), lenient=True) == "")
row("!=, and GitHub's falsy 0 and '' give B", g["substitute"](e("matrix.k != 'x' && 0 || 7"), ctx({"k": "y"})) == "7"
    and g["substitute"](e("matrix.k == 'x' && '' || 'b'"), ctx({"k": "x"})) == "b"
    and g["substitute"](e("matrix.k == 'x' && '0' || 'b'"), ctx({"k": "x"})) == "0")
print("\n".join(rows))
sys.exit(0 if all(r.startswith("ok") for r in rows) else 1)
`;
const r = spawnSync("python3", ["-I", "-c", controls, root, expected], { encoding: "utf8" });
process.stdout.write(r.stdout);
process.stderr.write(r.stderr);
const rows = r.stdout.split("\n").filter((l) => /^(ok|FAIL)/.test(l));
if (r.status !== 0 || rows.length !== 14) {
  console.log(`FAIL ci-local matrix controls: exit ${r.status}, ${rows.length} of 14 rows`);
  process.exit(1);
}
console.log("all passed");
