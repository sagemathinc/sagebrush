# pathlib on a file system (P3a; test/pathlib.test.ts on the CLI's, web/test-pathlib-worker.mjs on the browser worker's):
# every line as CPython 3.14 prints it, run in a fresh folder
import os, sys, fnmatch, glob, stat, errno
from pathlib import Path, PurePath, PurePosixPath, PureWindowsPath

# pure paths
p = PurePosixPath("/usr/local/lib/python3.14/site.tar.gz")
print(p.name, p.stem, p.suffix, p.suffixes, p.parent, list(map(str, p.parents))[:3], p.parts, p.anchor)
print(p.with_suffix(".bz2"), p.with_name("x.py"), p.with_stem("s"), p.relative_to("/usr"), p.is_relative_to("/opt"))
print(PurePosixPath("a") / "b" / "../c", PurePosixPath("a//b/./c"), PurePosixPath("/a").joinpath("b", "c"), repr(PurePosixPath("x/y")))
print(p.match("*.gz"), p.full_match("/usr/**/*.gz"), PurePosixPath("a/b") == PurePosixPath("a//b"), sorted([PurePosixPath("b"), PurePosixPath("a")]))
w = PureWindowsPath("C:/Users/X/file.TXT")
print(w, w.drive, w.root, w.parts, w.suffix, w.as_posix(), w.is_absolute(), PureWindowsPath("c:/a") == PureWindowsPath("C:/A"))
print(PurePath("a", "b"), type(PurePath("a")).__name__, os.fspath(PurePosixPath("q/r")), bytes(PurePosixPath("q")))
print(PurePosixPath("a/b").is_absolute(), PurePosixPath("..").name, PurePosixPath("").name == "")

# a tree of files
os.makedirs("t/sub/deep", exist_ok=True)
base = Path("t")
print((base / "a.txt").write_text("hello\nworld\n"), (base / "b.py").write_text("x = 1\n"), (base / "sub" / "c.txt").write_text("é"))
print((base / "data.bin").write_bytes(bytes(range(5))), (base / "data.bin").read_bytes())
print(repr((base / "a.txt").read_text()), (base / "sub" / "c.txt").read_text(encoding="utf-8"), (base / "a.txt").read_text().splitlines())
print((base / "a.txt").exists(), (base / "nope").exists(), base.is_dir(), (base / "a.txt").is_file(), (base / "sub").is_file(), (base / "nope").is_dir())
print(sorted(x.name for x in base.iterdir()))
print(sorted(str(x) for x in base.glob("*.txt")), sorted(str(x) for x in base.rglob("*.txt")), sorted(str(x) for x in base.glob("**/*.py")))
print(sorted(str(x) for x in base.glob("sub/*")), sorted(str(x) for x in base.glob("*/")), list(base.glob("zz*")))
(base / "new" / "x").mkdir(parents=True)
print((base / "new" / "x").is_dir())
try:
    (base / "new").mkdir()
except FileExistsError as e:
    print("FileExistsError", e.errno, e.strerror)
(base / "new").mkdir(exist_ok=True)
try:
    (base / "q" / "r").mkdir()
except FileNotFoundError as e:
    print("FileNotFoundError", e.errno)
st = (base / "a.txt").stat()
print(st.st_size, stat.S_ISREG(st.st_mode), stat.S_ISDIR(base.stat().st_mode), type(st).__name__, len(st), isinstance(st.st_mtime_ns, int))
print(Path("t/a.txt").resolve() == Path.cwd() / "t" / "a.txt", Path("t/../t/a.txt").resolve().name, Path("t").absolute().is_absolute())
print(Path.cwd() == Path(os.getcwd()), Path("t/a.txt").samefile("t/./a.txt"))
# (inode numbers: two files never share one; a folder keeps its own through a rename)
print(Path("t/a.txt").samefile("t/data.bin"), os.stat("t/a.txt").st_ino != os.stat("t/data.bin").st_ino, os.stat("t/sub/c.txt").st_ino != os.stat("t/b.py").st_ino)
os.mkdir("t/mv")
ino = os.stat("t/mv").st_ino
os.rename("t/mv", "t/mv2")
print(os.stat("t/mv2").st_ino == ino, os.stat("t/mv2").st_ino != os.stat("t").st_ino, Path("t/mv2").samefile("t/sub"))
os.rmdir("t/mv2")
(base / "b.py").rename(base / "b2.py")
print(sorted(x.name for x in base.iterdir()))
(base / "b2.py").replace(base / "b3.py")
(base / "b3.py").unlink()
(base / "gone").unlink(missing_ok=True)
(base / "new" / "x").rmdir()
print(sorted(x.name for x in base.iterdir()), (base / "new").exists())
with (base / "a.txt").open() as f:
    print(f.readline().strip())
with (base / "a.txt").open("a") as f:
    f.write("more\n")
print((base / "a.txt").read_text().count("\n"))
try:
    Path("t/missing.txt").read_text()
except FileNotFoundError as e:
    print("FileNotFoundError", e.errno, e.strerror, e.filename)
print(Path("t/a.txt").with_suffix(".md").name, str(Path("t", "sub")))
print(sorted(str(p.relative_to("t")) for p in Path("t").rglob("*")))
print([(d.relative_to("t").as_posix() if d != Path("t") else ".", sorted(ds), sorted(fs)) for d, ds, fs in sorted(Path("t").walk())])
# glob, fnmatch, os
print(sorted(glob.glob("t/*.txt")), sorted(glob.glob("t/**/*.txt", recursive=True)), glob.escape("a[b]*"))
print(fnmatch.fnmatch("x.TXT", "*.txt"), fnmatch.fnmatchcase("x.TXT", "*.txt"), fnmatch.filter(["a.py", "b.c", "c.py"], "*.py"), fnmatch.translate("*.py"))
print(sorted(e.name for e in os.scandir("t")), sorted((e.name, e.is_dir(), e.is_file()) for e in os.scandir("t")))
with os.scandir("t") as it:
    print(sorted(repr(e) for e in it))
print(sorted((os.path.relpath(r), sorted(d), sorted(f)) for r, d, f in os.walk("t")))
print(isinstance(Path("x"), os.PathLike), issubclass(PurePosixPath, os.PathLike), errno.ENOENT, errno.errorcode[errno.EEXIST], os.fsencode(Path("ab")))
print(stat.filemode(0o100644), stat.S_IMODE(0o100755), stat.S_ISLNK(os.lstat("t/a.txt").st_mode))
