"""Drive `sagebrush --sage -q` in a pty: set state, start a bounded long
computation, send Ctrl-C, then check whether earlier state is usable.
Everything is bounded by deadlines; the child is killed at the end."""
import os, pty, sys, time, select, signal

exe = sys.argv[1]
MODE = sys.argv[3]  # ctrlc | sigint
LOOPN = sys.argv[4]  # e.g. 2*10^7
WAIT = float(sys.argv[5])
log = open(sys.argv[2], "w")
pid, fd = pty.fork()
if pid == 0:
    os.execv(exe, [exe, "--sage", "-q"])

def read_for(sec):
    out = b""
    end = time.time() + sec
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.1)
        if r:
            try:
                chunk = os.read(fd, 65536)
            except OSError:
                break
            if not chunk:
                break
            out += chunk
    s = out.decode(errors="replace")
    log.write(s); log.flush()
    return s

def send(line):
    log.write(f"\n[[SEND {line!r} at {time.strftime('%H:%M:%S')}]]\n")
    os.write(fd, line.encode() + b"\r")

read_for(4)
send("P = matrix(QQ, [[1/2,1/4,1/4,0],[1/5,1/2,1/10,1/5],[0,0,1,0],[0,0,0,1]]); keep = P^5; print('SET', keep[0,0])")
read_for(4)
# bounded: ~1e9 iterations, far longer than our 3s wait, but finite
send("import time; s = 0; i = -1; T0 = time.time()")
send(f"for i in range({LOOPN}): s += i")
send("")
read_for(3)
t0 = time.time()
if MODE == "ctrlc":
    log.write("\n[[SEND Ctrl-C (\\x03) to pty]]\n"); os.write(fd, b"\x03")
else:
    log.write(f"\n[[os.kill({pid}, SIGINT)]]\n"); os.kill(pid, signal.SIGINT)
after = read_for(WAIT)
log.write(f"\n[[{time.time()-t0:.2f}s after Ctrl-C]]\n")
send("print('AFTER', keep[0,0], P.nrows(), 'i=', i, 'elapsed=', round(time.time()-T0,1))")
res = read_for(WAIT)
send("print('NEWCALC', (identity_matrix(QQ,2) - P[0:2,0:2]).inverse())")
res2 = read_for(5)
alive = True
try:
    wp, status = os.waitpid(pid, os.WNOHANG)
    alive = wp == 0
except ChildProcessError:
    alive = False
log.write(f"\n[[child alive before cleanup: {alive}]]\n")
if alive:
    os.kill(pid, signal.SIGKILL)
    os.waitpid(pid, 0)
summary = {
    "mode": MODE, "loop": LOOPN, "seconds_to_prompt_or_wait": round(time.time()-t0,1), "keyboardinterrupt_shown": "KeyboardInterrupt" in after,
    "state_kept": "AFTER 1/10 4" in res,
    "new_calc_ok": "NEWCALC" in res2 and "5/2" in res2,
    "child_alive_after": alive,
}
log.write("\nSUMMARY " + repr(summary) + "\n")
print(summary)
