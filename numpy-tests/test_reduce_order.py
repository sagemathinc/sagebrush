import numpy as np

# sum and mean of non-C-contiguous arrays add in NumPy's own order (its iterator: axes by
# stride, never flipped, adjacent axes merged, an 8192-element buffer for runs that aren't
# one stride), so they agree with NumPy to the last bit; data spread over 80 binary orders
# of magnitude, so a different order shows


def data(n, seed):
    i = np.arange(n)
    return ((i * 7919 + seed) % 1009 - 504) * 2.0 ** ((i * 31 + seed) % 81 - 40)


def show(*xs):
    print(" ".join(np.asarray(x).astype(np.float64).ravel()[:6].tobytes().hex()[:96] + "/" + str(np.asarray(x).shape) for x in xs))


# the issue's repro: a transposed view, along each axis and in full
A = np.random.RandomState(0).standard_normal((300, 20))
At = A.T
print(At.sum(axis=1)[0].hex(), np.array_equal(At.sum(axis=1), np.ascontiguousarray(At).sum(axis=1)))
show(At.sum(axis=0), At.sum(axis=1), At.mean(axis=-1), At.sum(), At.mean())

for shape in [(300, 20), (20, 300), (130, 17), (9, 33, 17), (5, 6, 7, 8)]:
    n = int(np.prod(shape))
    base = data(n, len(shape)).reshape(shape)
    base32 = base.astype(np.float32)
    basec = base + 1j * data(n, 9).reshape(shape)

    def views(b):
        return {
            "T": b.T,
            "F": np.asfortranarray(b),
            "step": b[tuple(slice(None, None, 2) for _ in shape)],
            "neg": b[tuple(slice(None, None, -1 if i % 2 == 0 else 1) for i in range(len(shape)))],
            "neg-all": b[tuple(slice(None, None, -1) for _ in shape)],
            "perm": b.transpose(tuple(range(1, len(shape))) + (0,)),
        }
    for (name, a), a32, ac in zip(views(base).items(), views(base32).values(), views(basec).values()):
        nd = a.ndim
        axes = [None] + list(range(nd)) + [(0, nd - 1)] + ([(0, 1), (1, 2)] if nd >= 3 else [])
        print(shape, name)
        show(*[a.sum(axis=ax) for ax in axes])
        show(*[a.mean(axis=ax) for ax in axes])
        show(*[a32.sum(axis=ax) for ax in axes])
        show(*[ac.sum(axis=ax).real for ax in axes], *[ac.sum(axis=ax).imag for ax in axes])
        show(a.sum(axis=-1, keepdims=True), a32.mean(axis=0), ac.mean().imag)

# past the 8192-element buffer: a run that isn't one stride is summed in buffer-sized parts
for shape, sl in [((130, 300), (slice(None), slice(None, None, -1))), ((33, 9, 33), (slice(None), slice(None), slice(None, None, -1))),
                  ((400, 750), (slice(None), slice(None, None, 3))), ((300, 330), (slice(None, None, -1), slice(None, None, -1))),
                  ((60, 300), (slice(None, None, -1), slice(None)))]:
    a = data(int(np.prod(shape)), 3).reshape(shape)[sl]
    a32 = data(int(np.prod(shape)), 3).reshape(shape).astype(np.float32)[sl]
    show(a.sum(), a.mean(), a.sum(axis=0), a.sum(axis=-1), a32.sum(), a32.sum(axis=0))

# the iterator's cost ties: a 4096-element run beside a dim that must be buffered takes the larger core
# (8192-element parts); and reduced dims above the core accumulate with the innermost of them fastest
t = data(3 * 4096, 4).reshape(3, 4096)[:, ::-1]
show(t.sum(), t.mean(), data(5 * 4096, 2).reshape(5, 4096)[::-1, ::-1].sum())
for shape, sl, perm in [((2, 32), (slice(None, None, -1), slice(None, None, 2)), (0, 1)), ((3, 16), (slice(None, None, 2), slice(None, None, 2)), (0, 1)),
                       ((3, 8), (slice(None, None, 2), slice(None)), (0, 1)), ((4, 3, 4096), (slice(None, None, -1), slice(None, None, -1), slice(None)), (2, 1, 0))]:
    for seed in range(4):
        v = data(int(np.prod(shape)), seed).reshape(shape)[sl].transpose(perm)
        show(v.sum())
f = np.asfortranarray(data(6 * 9 * 10 * 7, 8).reshape(6, 9, 10, 7))[:, ::2, ::3, ::2]
show(f.sum(axis=(1, 2, 3)), f.sum(axis=(1, 3)), f.sum(axis=(2, 3)), f.mean(axis=(1, 2)))

# complex: NumPy's complex pairwise sum, whose blocks are half the real sum's (C order too)
for n in (3, 4, 5, 9, 16, 17, 63, 64, 65, 100, 129, 600, 5000):
    z = data(n, 5) + 1j * data(n, 6)
    print(n, z.sum().real.hex(), z.sum().imag.hex(), float(z.astype(np.complex64).sum().real).hex(), z.mean().imag.hex())
z = (data(600, 5) + 1j * data(600, 6)).reshape(20, 30)
show(z.T.sum().real, z.T.sum().imag, z.T.sum(axis=1).real, z.T.mean(axis=0).imag, z.sum(axis=1).imag, z[:, ::-2].sum(axis=0).real)
