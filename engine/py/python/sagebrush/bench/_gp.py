"""PARI/GP as a competitor: one running gp process (so its start-up is not
timed), used as a black box through its documented language only.

The executable is $SAGEBRUSH_BENCH_GP, or gp on the PATH."""

import os
import shutil

from ._proc import LineProcess, ProcError
from ._timing import ONCE, TARGET, Timing

# The timing procedure of _timing.sample, in GP: getabstime() is in ms.
_SBTIME = (
    "sbtime(f,reps)=my(t,r,n=1,s,u);"
    "t=getabstime();r=f();t=getabstime()-t;"
    f"if(t>={int(ONCE * 1000)},return([[t],1,r]));"
    f"while(t<{int(TARGET * 1000)},"
    f"n=if(t==0,10*n,max(n+1,ceil(n*{1.2 * TARGET * 1000}/t)));"
    "t=getabstime();for(i=1,n,r=f());t=getabstime()-t);"
    "s=vector(reps);"
    "for(j=1,reps,u=getabstime();for(i=1,n,r=f());s[j]=(getabstime()-u)/n);"
    "[s,n,r]"
)


class GpError(ProcError):
    pass


class Gp:
    name = "pari"
    short = "pari"
    ours = False

    def __init__(self):
        self.path = os.environ.get("SAGEBRUSH_BENCH_GP") or shutil.which("gp")
        self.proc = None
        self._version = None

    def available(self):
        return self.path is not None and os.access(self.path, os.X_OK)

    def _send(self, lines, timeout):
        """Run GP lines (one statement each); return the lines they print."""
        if self.proc is None or self.proc.proc is None:
            self.proc = LineProcess(
                [self.path, "-q", "-f", "-D", "parisizemax=8000000000", "-D", "breakloop=0",
                 "-D", "nbthreads=1"], "SBEND")
            self.proc.request(_SBTIME + '\nprint("SBEND")\n', 60)
        for line in lines:
            assert "\n" not in line
        return self.proc.request("\n".join(lines) + '\nprint("SBEND")\n', timeout)

    def version(self):
        if self._version is None:
            out = self._send(['v=version();print("SBV ",v[1],".",v[2],".",v[3])'], 60)
            v = [line[4:] for line in out if line.startswith("SBV ")]
            self._version = "PARI/GP " + v[0] if v else "?"
        return self._version

    def time(self, setup, call, answer, repeat, timeout):
        """Time the GP expression `call` (after the statements `setup`); its
        last value r is printed by the GP expression `answer` (in r) as one
        line. The Timing's answer is that line."""
        lines = list(setup) + [
            f"iferr(sbr=sbtime(()->{call},{int(repeat)});"
            f'print("SBT ",strjoin(apply(x->Str(x*1.),sbr[1])," ")," ",sbr[2]);'
            f'r=sbr[3];print("SBA ",{answer}),'
            f'E,print("SBERR ",E))'
        ]
        out = self._send(lines, timeout)
        times = calls = ans = None
        for line in out:
            if line.startswith("SBERR "):
                raise GpError(line[6:])
            if line.startswith("SBT "):
                *ts, n = line[4:].split()
                times, calls = [float(t) / 1000 for t in ts], int(n)
            elif line.startswith("SBA "):
                ans = line[4:]
        if times is None or ans is None:
            raise GpError("no result: " + " | ".join(out)[-500:])
        return Timing(times, calls, ans)

    def close(self):
        if self.proc is not None:
            self.proc.close()
