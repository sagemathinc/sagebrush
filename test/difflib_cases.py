# difflib (P3b-1; test/difflib.test.ts): every line as CPython 3.14 prints it
import difflib, hashlib
from difflib import SequenceMatcher, Differ, HtmlDiff

s = SequenceMatcher(None, "abxcd", "abcd")
print(s.ratio(), s.quick_ratio(), s.real_quick_ratio(), s.get_matching_blocks(), s.get_opcodes(), s.find_longest_match())
s = SequenceMatcher(lambda c: c == " ", "private Thread currentThread;", "private volatile Thread currentThread;")
print(round(s.ratio(), 6), s.get_matching_blocks()[:3], list(s.get_grouped_opcodes(1)))
s.set_seqs("qabxcd", "abycdf"); print(s.get_opcodes(), s.ratio())
long_a = ["x"] * 300 + ["a", "b"]; long_b = ["x"] * 299 + ["a", "c", "b"]
print(SequenceMatcher(None, long_a, long_b).ratio(), SequenceMatcher(None, long_a, long_b, autojunk=False).ratio(), len(SequenceMatcher(None, long_a, long_b).bjunk), len(SequenceMatcher(None, long_a, long_b).bpopular))
a = "one\ntwo\nthree\nfour\nfive\nsix\nseven\n".splitlines(keepends=True)
b = "zero\none\ntree\nfour\nfive\nsix\nsevens\neight\n".splitlines(keepends=True)
print("".join(difflib.unified_diff(a, b, "a.txt", "b.txt", "2026-01-01", "2026-01-02")), end="")
print("".join(difflib.unified_diff(a, b, n=0)), end="")
print(list(difflib.unified_diff(["x"], ["y"], lineterm="")))
print("".join(difflib.context_diff(a, b, "a", "b")), end="")
d = list(difflib.ndiff(a, b)); print("".join(d), end="")
print("".join(difflib.restore(d, 1)) == "".join(a), "".join(difflib.restore(d, 2)) == "".join(b))
print("".join(difflib.ndiff(["the quick brown fox\n"], ["the quack brown fax\n"])), end="")
print("".join(Differ().compare(["abc\n", "  tab\n"], ["abd\n", "\ttab\n"])), end="")
print(difflib.get_close_matches("appel", ["ape", "apple", "peach", "puppy"]), difflib.get_close_matches("wheel", ["while", "wheat", "steel", "help"], n=2, cutoff=0.5))
print(difflib.get_close_matches("x", []), difflib.IS_LINE_JUNK("  #  \n"), difflib.IS_LINE_JUNK("x\n"), difflib.IS_CHARACTER_JUNK(" "), difflib.IS_CHARACTER_JUNK("x"))
print(list(difflib.diff_bytes(difflib.unified_diff, [b"a\n", b"b\n"], [b"a\n", b"c\n"], b"x", b"y")))
h = HtmlDiff(wrapcolumn=20)
print(hashlib.sha256(h.make_file(a, b, "from", "to").encode()).hexdigest(), hashlib.sha256(h.make_table(a, b, context=True, numlines=1).encode()).hexdigest())
print(len(HtmlDiff(tabsize=4).make_table(["\tx\n"], ["\ty\n"])))
for bad in [lambda: difflib.get_close_matches("x", ["y"], n=0), lambda: difflib.get_close_matches("x", ["y"], cutoff=2), lambda: list(difflib.unified_diff([b"x"], ["y"])), lambda: list(difflib.diff_bytes(difflib.unified_diff, ["x"], [b"y"]))]:
    try:
        bad(); print("no error")
    except (TypeError, ValueError) as e:
        print(type(e).__name__, e)
print(SequenceMatcher(None, [1, 2, 3], (1, 2, 4)).get_opcodes(), difflib.Match(1, 2, 3), SequenceMatcher[int])
