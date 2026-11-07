# shutil, and the os calls it needs (P3b-2; test/shutil.test.ts on the CLI's file system, web/test-shutil-worker.mjs on
# the browser worker's): every line as CPython 3.14 prints it, run in a fresh folder
import os, stat, shutil, errno
from pathlib import Path

# descriptors: open, write, lseek, read, fstat, close
fd = os.open("f.bin", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
print(fd > 2, os.write(fd, b"hello "), os.write(fd, memoryview(b"world")), os.fstat(fd).st_size, stat.S_ISREG(os.fstat(fd).st_mode))
os.close(fd)
fd = os.open("f.bin", os.O_RDWR)
print(os.read(fd, 5), os.lseek(fd, 0, os.SEEK_CUR), os.lseek(fd, -5, os.SEEK_END), os.read(fd, 100), os.read(fd, 10), os.lseek(fd, 1, os.SEEK_SET))
print(os.write(fd, b"E"), os.lseek(fd, 0, os.SEEK_SET), os.read(fd, 11))
os.close(fd)
fd = os.open("f.bin", os.O_WRONLY | os.O_APPEND)
os.lseek(fd, 0, os.SEEK_SET); os.write(fd, b"!"); os.close(fd)
fd = os.open("f.bin", os.O_WRONLY | os.O_TRUNC); print(os.fstat(fd).st_size); os.write(fd, b"new"); os.close(fd)
print(open("f.bin", "rb").read())
fd = os.open("g.bin", os.O_WRONLY | os.O_CREAT | os.O_TRUNC); os.write(fd, b"g"); os.close(fd)
for bad in [lambda: os.open("f.bin", os.O_WRONLY | os.O_CREAT | os.O_EXCL), lambda: os.open("nope.bin", os.O_RDONLY), lambda: os.close(fd), lambda: os.read(fd, 1), lambda: os.write(fd, b"x"), lambda: os.lseek(fd, 0, 0), lambda: os.fstat(fd), lambda: os.write(1, "s"), lambda: os.read(0, -1)]:
    try:
        bad(); print("no error")
    except (OSError, TypeError, ValueError) as e:
        print(type(e).__name__, getattr(e, "errno", None), e)
ro = os.open("f.bin", os.O_RDONLY); wo = os.open("g.bin", os.O_WRONLY)
for bad in [lambda: os.write(ro, b"x"), lambda: os.read(wo, 1)]:
    try:
        bad(); print("no error")
    except OSError as e:
        print(type(e).__name__, e.errno, e.strerror)
os.close(ro); os.close(wo)
print(open("f.bin", "rb").read(), open("g.bin", "rb").read())
# the converters' limits (a C int, read's ssize_t, lseek's C long): OverflowError beyond, MemoryError for a count no
# bytes object can hold; nothing made, the descriptor's position unchanged
fd = os.open("f.bin", os.O_RDWR)
for bad in [lambda: os.open("h.bin", 2**32 + os.O_CREAT + os.O_WRONLY), lambda: os.open("h.bin", 2**31), lambda: os.open("h.bin", os.O_RDONLY, 2**32), lambda: os.close(2**31), lambda: os.close(2**64), lambda: os.read(2**40, 1), lambda: os.read(fd, 2**63), lambda: os.read(fd, 2**62), lambda: os.lseek(fd, 2**63, os.SEEK_SET), lambda: os.lseek(fd, -2**63 - 1, os.SEEK_SET), lambda: os.lseek(fd, 0, 2**31), lambda: os.write(2**32, b"x"), lambda: os.fstat(-2**31 - 1), lambda: os.chmod("f.bin", 2**32)]:
    try:
        bad(); print("no error")
    except (OSError, OverflowError, MemoryError) as e:
        print(type(e).__name__, getattr(e, "errno", None), e)
print(os.path.exists("h.bin"), os.lseek(fd, 0, os.SEEK_CUR), os.read(fd, 2**24), os.lseek(fd, 0, os.SEEK_CUR))
# more than one argument wrong: CPython's order (every converter in signature order, then the checks, then the
# descriptor at the call)
for bad in [lambda: os.read(-1, -1), lambda: os.write(-1, 1), lambda: os.read(-(2**40), 2**63), lambda: os.lseek(-1, 2**63, 2**40), lambda: os.read(-1, 2**62), lambda: os.read(-1, 2**63), lambda: os.lseek(-1, 0, 2**31), lambda: os.write(-1, "s"), lambda: os.fstat(-(2**40)), lambda: os.get_terminal_size(-(2**40))]:
    try:
        bad(); print("no error")
    except (OSError, OverflowError, MemoryError, TypeError) as e:
        print(type(e).__name__, getattr(e, "errno", None), e)
# descriptors: only 0, 1 and 2 are the standard streams; a negative one, or one not open, is EBADF
for bad in [lambda: os.write(-1, b"X"), lambda: os.read(-1, 1), lambda: os.close(-1), lambda: os.lseek(-1, 0, os.SEEK_SET), lambda: os.fstat(-1), lambda: os.write(-2**31, b"X"), lambda: os.read(-7, 0), lambda: os.write(77, b"X"), lambda: os.read(77, 1), lambda: os.close(77), lambda: os.lseek(77, 0, os.SEEK_SET), lambda: os.get_terminal_size(-1), lambda: os.get_terminal_size(77)]:
    try:
        bad(); print("no error")
    except OSError as e:
        print(type(e).__name__, e.errno, e.strerror)
os.close(fd)

# chmod, utime, access
os.chmod("f.bin", 0o640); print(oct(stat.S_IMODE(os.stat("f.bin").st_mode)), stat.S_ISREG(os.stat("f.bin").st_mode))
os.utime("f.bin", (1_000_000_000, 1_500_000_000.25)); st = os.stat("f.bin")
print(st.st_atime, st.st_mtime, int(st.st_mtime))
os.utime("f.bin", ns=(2_000_000_000_000_000_000, 1_700_000_000_123_000_000)); print(os.stat("f.bin").st_mtime_ns // 1_000_000, int(os.stat("f.bin").st_atime))
os.utime("f.bin"); print(abs(os.stat("f.bin").st_mtime - __import__("time").time()) < 60)
for bad in [lambda: os.utime("f.bin", (1, 2), ns=(1, 2)), lambda: os.utime("f.bin", (1,)), lambda: os.utime("f.bin", ns=(1,)), lambda: os.utime("nope.bin"), lambda: os.chmod("nope.bin", 0o600)]:
    try:
        bad(); print("no error")
    except (OSError, TypeError, ValueError) as e:
        print(type(e).__name__, e)
os.chmod("f.bin", 0o200); print(os.access("f.bin", os.F_OK), os.access("f.bin", os.R_OK), os.access("f.bin", os.W_OK), os.access("f.bin", os.X_OK), os.access("nope", os.F_OK))
os.chmod("f.bin", 0o644)
print(os.stat in os.supports_follow_symlinks, os.utime in os.supports_follow_symlinks, os.access in os.supports_follow_symlinks)

# Path.touch: os.utime then os.open (O_CREAT), #820's L-touch
Path("t.txt").touch(); Path("t.txt").touch(); print(Path("t.txt").exists(), Path("t.txt").stat().st_size)
try:
    Path("t.txt").touch(exist_ok=False)
except FileExistsError as e:
    print("FileExistsError", e.errno)
Path("t.txt").chmod(0o600); print(oct(stat.S_IMODE(Path("t.txt").stat().st_mode)))

# shutil
os.makedirs("src/sub/deep", exist_ok=True)
Path("src/a.txt").write_text("alpha\n"); Path("src/b.py").write_text("b = 2\n"); Path("src/sub/c.txt").write_text("c\n"); Path("src/sub/deep/d.txt").write_text("d\n")
os.chmod("src/a.txt", 0o600); os.utime("src/a.txt", (1_600_000_000, 1_600_000_000))
print(shutil.copyfile("src/a.txt", "c1.txt"), open("c1.txt").read(), oct(stat.S_IMODE(os.stat("c1.txt").st_mode)))
print(shutil.copy("src/a.txt", "c2.txt"), oct(stat.S_IMODE(os.stat("c2.txt").st_mode)), int(os.stat("c2.txt").st_mtime) != 1_600_000_000)
print(shutil.copy2("src/a.txt", "c3.txt"), oct(stat.S_IMODE(os.stat("c3.txt").st_mode)), int(os.stat("c3.txt").st_mtime))
os.makedirs("into", exist_ok=True); print(shutil.copy("src/b.py", "into"), sorted(os.listdir("into")))
shutil.copymode("src/a.txt", "into/b.py"); shutil.copystat("src/a.txt", "c1.txt"); print(oct(stat.S_IMODE(os.stat("into/b.py").st_mode)), int(os.stat("c1.txt").st_mtime))
print(shutil.copytree("src", "tree"), sorted(str(p.relative_to("tree")) for p in Path("tree").rglob("*")), int(os.stat("tree/a.txt").st_mtime))
print(shutil.copytree("src", "tree2", ignore=shutil.ignore_patterns("*.py", "deep")), sorted(str(p.relative_to("tree2")) for p in Path("tree2").rglob("*")))
print(shutil.copytree("src", "tree2", dirs_exist_ok=True), sorted(os.listdir("tree2")))
for bad in [lambda: shutil.copytree("src", "tree"), lambda: shutil.copyfile("src/a.txt", "src/a.txt"), lambda: shutil.copyfile("nope", "x"), lambda: shutil.copy("src", "x")]:
    try:
        bad(); print("no error")
    except (OSError, shutil.Error) as e:
        print(type(e).__name__, e)
print(shutil.move("c1.txt", "moved.txt"), os.path.exists("c1.txt"), open("moved.txt").read())
print(shutil.move("moved.txt", "into"), sorted(os.listdir("into")))
print(shutil.move("tree2", "tree3"), os.path.exists("tree2"), sorted(os.listdir("tree3")))
shutil.rmtree("tree3"); print(os.path.exists("tree3"))
seen = []; shutil.rmtree("nope", onexc=lambda f, p, e: seen.append((f.__name__, os.path.basename(p), type(e).__name__))); print(seen)
shutil.rmtree("nope", ignore_errors=True)
try:
    shutil.rmtree("tree/a.txt")
except NotADirectoryError as e:
    print("NotADirectoryError", e.errno)

# which, get_terminal_size, the rest
os.makedirs("bin", exist_ok=True); Path("bin/tool").write_text("#!/bin/sh\n"); os.chmod("bin/tool", 0o755); Path("bin/data").write_text("x")
os.environ["PATH"] = os.path.abspath("bin")
print(os.path.basename(shutil.which("tool")), shutil.which("data"), shutil.which("nope"), os.path.basename(shutil.which("tool", path="bin")))
os.environ.pop("COLUMNS", None); os.environ.pop("LINES", None)
os.environ["COLUMNS"] = "100"; os.environ["LINES"] = "30"; print(shutil.get_terminal_size((80, 24)))
print(os.terminal_size((1, 2)), os.terminal_size((1, 2)).columns, type(os.terminal_size((1, 2))).__name__)
try:
    os.terminal_size((1,))
except TypeError as e:
    print("TypeError", e)
import posix
print(posix.stat is os.stat, posix.open is os.open, posix.error is OSError, hasattr(posix, "_fcopyfile"), hasattr(shutil, "chown"))
print(shutil.COPY_BUFSIZE > 0, issubclass(shutil.SameFileError, shutil.Error), issubclass(shutil.SpecialFileError, OSError))
