# #956's repro: str() of an int of TBITS bits after KEEP live ints of BBITS bits fill part of the heap.
# Run under node --max-old-space-size=MiB; expected: the conversion completes, or is refused with MemoryError
# before it allocates and the session goes on; never the host's own out-of-memory abort. With a fourth argument,
# BITS: the ballast is let go and an int of BITS bits converted (test/admit-heap.test.ts: the session's reuse).
import sys

sys.set_int_max_str_digits(0)
tbits, bbits, keep = int(sys.argv[1]), int(sys.argv[2]), int(sys.argv[3])
target = (1 << tbits) - 1
ballast = []
for i in range(keep):
    ballast.append((1 << bbits) - 1 - i)
print("ballast:", keep, "ints of", bbits, "bits; converting an int of", tbits, "bits", flush=True)
try:
    s = str(target)
    print("converted:", len(s), "digits", flush=True)
except MemoryError as e:
    print("MemoryError:", str(e).strip().splitlines()[0][:200], flush=True)
print("session still usable:", sum(range(10)), flush=True)
if sys.argv[4:]:
    ballast.clear()
    print("after clearing:", len(str((1 << int(sys.argv[4])) - 1)), "digits", flush=True)
