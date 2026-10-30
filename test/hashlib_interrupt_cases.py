# pyjs only (it reaches into lib/hashlib.py): an exception or interrupt in
# the middle of update() leaves the hash object as it was, and it goes on
# hashing correctly (H345-A4).  test/hashlib.test.ts checks the digests
# against CPython's hashlib for the data that was actually added.
import hashlib

for name in ("md5", "sha1", "sha224", "sha256", "sha384", "sha512"):
    entry = hashlib._ALGORITHMS[name]
    compress = entry[1]
    h = hashlib.new(name, b"prefix bytes, " * 3)
    before = (h.hexdigest(), h.copy().hexdigest())
    calls = [0]

    def failing(state, block):
        calls[0] += 1
        if calls[0] == 2:
            raise KeyboardInterrupt
        return compress(state, block)

    hashlib._ALGORITHMS[name] = (entry[0], failing) + entry[2:]
    try:
        h.update(b"x" * 1000)
        print(name, "no interrupt?")
    except KeyboardInterrupt:
        pass
    finally:
        hashlib._ALGORITHMS[name] = entry
    after = (h.hexdigest(), h.copy().hexdigest())
    print(name, "unchanged", before == after, calls[0])
    h.update(b"then more")
    print(name, h.hexdigest())
