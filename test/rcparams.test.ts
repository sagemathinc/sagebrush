// matplotlib's rcParams: one object for matplotlib and pyplot, with every key
// matplotlib 3.11.1 has (lib/matplotlib/_rckeys.py) at its default, and
// matplotlib's errors for any other key.  Expected values are matplotlib
// 3.11.1's, run on the same programs.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

const run = (program: string) => execFileSync(process.execPath, [__dirname + "/../src/cli.js", "-c", program], { encoding: "utf8" });

test("rcParams: one object, matplotlib's keys and defaults, its KeyErrors; rc, rcdefaults, rc_context", () => {
  const out = run(`
import matplotlib as mpl
import matplotlib.pyplot as plt
rc = mpl.rcParams
def t(label, f):
    try:
        print(label, repr(f()))
    except Exception as e:
        print(label, type(e).__name__, str(e))
t("same", lambda: plt.rcParams is mpl.rcParams)
t("type", lambda: (type(rc).__name__, isinstance(rc, dict), len(rc)))
t("get bad", lambda: rc["nosuch.key"])
t("set bad", lambda: rc.__setitem__("nosuch.key", 1))
t("update bad", lambda: rc.update({"nosuch.key": 1}))
t(".get bad", lambda: rc.get("nosuch.key", 5))
t("in bad", lambda: "nosuch.key" in rc)
t("defaults", lambda: (rc["font.size"], rc["legend.frameon"], rc["grid.color"], rc["axes.titlesize"], rc["figure.figsize"]))
t("rc", lambda: (plt.rc("lines", lw=3), rc["lines.linewidth"])[1])
t("rc bad", lambda: plt.rc("lines", nosuch=3))
t("rc group bad", lambda: plt.rc("nosuchgroup", size=3))
t("mpl.rc", lambda: (mpl.rc("font", size=12), rc["font.size"])[1])
t("rcdefaults", lambda: (mpl.rcdefaults(), rc["font.size"], rc["lines.linewidth"])[1:])
try:
    with mpl.rc_context({"font.size": 20}):
        print("in ctx", rc["font.size"])
        raise ValueError
except ValueError:
    pass
t("after ctx exc", lambda: rc["font.size"])
t("ctx bad", lambda: mpl.rc_context({"nosuch.key": 1}).__enter__())
t("find_all", lambda: sorted(rc.find_all("^grid\\\\.").keys())[:4])
t("copy", lambda: type(rc.copy()).__name__)
t("pop", lambda: rc.pop("font.size"))
t("pop default", lambda: rc.pop("nosuch.key", 5))
t("popitem", lambda: rc.popitem())
t("clear", lambda: (rc.clear(), len(rc), rc["font.size"])[1:])
t("default type", lambda: type(mpl.rcParamsDefault).__name__)
c = rc["axes.prop_cycle"]
t("cycle", lambda: (len(c), sorted(c.keys), c.by_key()["color"][0] == (0.12156862745098039, 0.4666666666666667, 0.7058823529411765)))
t("cycle iter", lambda: next(iter(c))["color"] == c.by_key()["color"][0])
t("cycler()", lambda: mpl.cycler(color=["r", "b"]))
t("cycler other", lambda: mpl.cycler(linestyle=["-"]))
`);
  assert.deepEqual(out.trim().split("\n"), [
    "same True",
    "type ('RcParams', True, 339)",
    "get bad KeyError 'nosuch.key'",
    "set bad KeyError \"'nosuch.key' is not a valid value for rcParam.\"",
    "update bad KeyError \"'nosuch.key' is not a valid value for rcParam.\"",
    ".get bad 5",
    "in bad False",
    "defaults (10.0, True, '#b0b0b0', 'large', [6.4, 4.8])",
    "rc 3.0",
    "rc bad KeyError 'Unrecognized key \"lines.nosuch\" for group \"lines\" and name \"nosuch\"'",
    "rc group bad KeyError 'Unrecognized key \"nosuchgroup.size\" for group \"nosuchgroup\" and name \"size\"'",
    "mpl.rc 12.0",
    "rcdefaults (10.0, 1.5)",
    "in ctx 20.0",
    "after ctx exc 10.0",
    "ctx bad KeyError \"'nosuch.key' is not a valid value for rcParam.\"",
    "find_all ['grid.alpha', 'grid.color', 'grid.linestyle', 'grid.linewidth']",
    "copy 'RcParams'",
    "pop KeyError ",
    "pop default 5",
    "popitem KeyError ",
    "clear (339, 10.0)",
    "default type 'RcParams'",
    "cycle (10, ['color'], True)",
    "cycle iter True",
    "cycler() cycler('color', ['r', 'b'])",
    "cycler other NotImplementedError cycler('linestyle', ...): Sagebrush cycles colours only ('color')",
  ]);
});
