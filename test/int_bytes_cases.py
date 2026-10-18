# int.from_bytes and int.to_bytes as CPython 3.14's: their checks, in
# their order, and the values; compared line by line with CPython
# (test/int-bytes.test.ts)
class J(int):
    pass


class I:
    def __index__(self):
        return 3


class B:
    def __bytes__(self):
        return b'\x01\x02'


class BadB:
    def __bytes__(self):
        return 'no'


def show(f):
    try:
        r = f()
        return type(r).__name__ + ' ' + repr(r)
    except Exception as e:
        return type(e).__name__ + ': ' + str(e)


cases = [
    ('fb basic', lambda: int.from_bytes(b'\x01\x02', 'big')), ('fb little', lambda: int.from_bytes(b'\x01\x02', 'little')),
    ('fb default', lambda: int.from_bytes(b'\x01\x02')), ('fb signed', lambda: int.from_bytes(b'\xff\xfe', 'big', signed=True)),
    ('fb signed little', lambda: int.from_bytes(b'\xfe\xff', 'little', signed=True)), ('fb empty', lambda: int.from_bytes(b'')),
    ('fb empty signed', lambda: int.from_bytes(b'', signed=True)), ('fb list', lambda: int.from_bytes([1, 2, 3])),
    ('fb list 300', lambda: int.from_bytes([1, 300])), ('fb list -1', lambda: int.from_bytes([-1])), ('fb list float', lambda: int.from_bytes([1.0])),
    ('fb list I', lambda: int.from_bytes([I()])), ('fb str', lambda: int.from_bytes('ab')), ('fb int', lambda: int.from_bytes(5)),
    ('fb bytearray', lambda: int.from_bytes(bytearray(b'\x07\x08'))), ('fb memoryview', lambda: int.from_bytes(memoryview(b'\x07\x08'))),
    ('fb __bytes__', lambda: int.from_bytes(B())), ('fb bad __bytes__', lambda: int.from_bytes(BadB())), ('fb gen', lambda: int.from_bytes(x for x in [1, 2])),
    ('fb byteorder bad', lambda: int.from_bytes(b'\x01', 'middle')), ('fb byteorder int', lambda: int.from_bytes(b'\x01', 5)),
    ('fb kw', lambda: int.from_bytes(bytes=b'\x01', byteorder='little')), ('fb subclass', lambda: J.from_bytes(b'\x05')),
    ('fb bool', lambda: bool.from_bytes(b'\x00')), ('fb signed truthy', lambda: int.from_bytes(b'\x80', signed='x')),
    ('tb basic', lambda: (258).to_bytes(2, 'big')), ('tb default', lambda: (5).to_bytes()), ('tb little', lambda: (258).to_bytes(3, 'little')),
    ('tb overflow', lambda: (256).to_bytes(1)), ('tb neg unsigned', lambda: (-1).to_bytes(1)), ('tb neg signed', lambda: (-1).to_bytes(2, signed=True)),
    ('tb signed overflow', lambda: (128).to_bytes(1, signed=True)), ('tb signed min', lambda: (-128).to_bytes(1, signed=True)),
    ('tb signed -129', lambda: (-129).to_bytes(1, signed=True)), ('tb zero len', lambda: (0).to_bytes(0)), ('tb zero len 1', lambda: (1).to_bytes(0)),
    ('tb zero len signed', lambda: (0).to_bytes(0, signed=True)), ('tb neg len', lambda: (1).to_bytes(-1)), ('tb len I', lambda: (1).to_bytes(I())),
    ('tb len float', lambda: (1).to_bytes(2.0)), ('tb byteorder bad', lambda: (1).to_bytes(1, 'x')), ('tb kw', lambda: (1).to_bytes(length=2, byteorder='little')),
    ('tb big len', lambda: len((1).to_bytes(1000))), ('tb J', lambda: J(5).to_bytes(2)), ('tb bool', lambda: True.to_bytes(1)),
    ('tb len 2**64', lambda: (1).to_bytes(2**64)),
]
for label, f in cases:
    print(label, show(f))
x = 3**100000
print(int.from_bytes(x.to_bytes((x.bit_length() + 7) // 8, 'little'), 'little') == x, int.from_bytes((-x).to_bytes((x.bit_length() + 8) // 8, 'big', signed=True), 'big', signed=True) == -x)


# round trips at many sizes, both byte orders, signed and not
for bits in [0, 1, 7, 8, 9, 63, 64, 65, 1000, 4096, 100003]:
    for v in [2**bits - 1, 2**bits, -(2**bits), -(2**bits) - 1, 3**(bits // 2 + 1)]:
        for order in ['big', 'little']:
            for signed in [False, True]:
                if v < 0 and not signed:
                    continue
                n = (v.bit_length() + (8 if signed else 7)) // 8
                b = v.to_bytes(n, order, signed=signed)
                w = int.from_bytes(b, order, signed=signed)
                assert w == v, (bits, v, order, signed)
                assert v.to_bytes(n + 3, order, signed=signed) == (b + (b'\xff' if v < 0 else b'\x00') * 3 if order == 'little' else (b'\xff' if v < 0 else b'\x00') * 3 + b)
print('round trips ok')
print(int.from_bytes(bytes(range(256)) * 40, 'little') % 1000003, (7**5000).to_bytes(1755, 'big')[:8], (7**5000).to_bytes(1755, 'little')[-8:])
print(int.from_bytes(bytearray(b'\x00\x01') * 3000) % 99991, int.from_bytes([255] * 5000, signed=True), int.from_bytes(iter([1, 2, 3]), 'little'))
