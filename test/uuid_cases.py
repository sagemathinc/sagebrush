# CPython's uuid.py (lib/uuid.py, unchanged) on pyjs: each line printed here
# is compared with CPython's (test/uuid.test.ts).  Random and time-based
# UUIDs are checked by their properties, never by value.
import uuid, pickle, copy


def show(f):
    try:
        print(f())
    except Exception as e:
        print(type(e).__name__ + ":", e)


u = uuid.UUID("12345678-1234-5678-1234-567812345678")
print(u, repr(u), u.hex, u.int, u.version, u.variant, u.urn, u.is_safe)
print(u.fields, u.time_low, u.time_mid, u.time_hi_version, u.clock_seq_hi_variant, u.clock_seq_low, u.node, u.time, u.clock_seq)
print(u.bytes, u.bytes_le)
for s in ("{12345678-1234-5678-1234-567812345678}", "urn:uuid:12345678-1234-5678-1234-567812345678",
          "12345678123456781234567812345678", "12345678-1234-5678-1234-567812345678".upper()):
    print(uuid.UUID(s) == u, uuid.UUID(s))
print(uuid.UUID(bytes=u.bytes) == u, uuid.UUID(bytes_le=u.bytes_le) == u, uuid.UUID(fields=u.fields) == u, uuid.UUID(int=u.int) == u)
print(uuid.UUID(int=5), uuid.UUID(int=(1 << 128) - 1), uuid.UUID("12345678-1234-5678-1234-567812345678", version=4))
print(uuid.UUID(int=0, is_safe=uuid.SafeUUID.safe).is_safe, list(uuid.SafeUUID), uuid.SafeUUID.unsafe.value)
print(uuid.NIL, uuid.MAX, uuid.NIL.variant, uuid.MAX.variant, uuid.NIL.version, uuid.MAX.version)
print(uuid.NAMESPACE_DNS, uuid.NAMESPACE_URL, uuid.NAMESPACE_OID, uuid.NAMESPACE_X500)
print(uuid.RESERVED_NCS, uuid.RFC_4122, uuid.RESERVED_MICROSOFT, uuid.RESERVED_FUTURE)

# name-based: uuid3 (MD5) and uuid5 (SHA-1), over hashlib
for ns in (uuid.NAMESPACE_DNS, uuid.NAMESPACE_URL, uuid.NAMESPACE_OID, uuid.NAMESPACE_X500, u):
    for name in ("python.org", "", "x" * 200, "ünïcode ✓", b"bytes name"):
        print(uuid.uuid3(ns, name), uuid.uuid5(ns, name))

# uuid8 with explicit parts is deterministic
print(uuid.uuid8(1, 2, 3), uuid.uuid8(0, 0, 0), uuid.uuid8((1 << 48) - 1, (1 << 12) - 1, (1 << 62) - 1))

# comparisons, hashing, pickling, copying
a, b = uuid.UUID(int=1), uuid.UUID(int=2)
print(a < b, a <= b, a == uuid.UUID(int=1), a != b, sorted([b, a]), hash(a) == hash(uuid.UUID(int=1)), int(b), str(a))
print(pickle.loads(pickle.dumps(u)) == u, copy.copy(u) is u or copy.copy(u) == u, copy.deepcopy(u) == u)
print(u == "12345678-1234-5678-1234-567812345678", {u: 1}[uuid.UUID(str(u))])

# random and time-based: properties only
for make, version in ((uuid.uuid1, 1), (uuid.uuid4, 4), (uuid.uuid6, 6), (uuid.uuid7, 7)):
    xs = [make() for _ in range(50)]
    print(version, all(x.version == version and x.variant == uuid.RFC_4122 for x in xs), len(set(xs)) == 50)
v7 = [uuid.uuid7() for _ in range(200)]
print("uuid7 monotonic", v7 == sorted(v7))
v6 = [uuid.uuid6() for _ in range(200)]
print("uuid6 monotonic", v6 == sorted(v6))
print(isinstance(uuid.getnode(), int), 0 <= uuid.getnode() < (1 << 48), uuid.getnode() == uuid.getnode())
print(uuid.uuid1(node=0x123456789abc, clock_seq=0x1234).node == 0x123456789abc, uuid.uuid1(clock_seq=0x1234).clock_seq == 0x1234)
print(uuid.uuid8().version, uuid.uuid8().variant)

# errors
show(lambda: uuid.UUID("not-a-uuid"))
show(lambda: uuid.UUID("12345678-1234-5678-1234-56781234567"))
show(lambda: uuid.UUID())
show(lambda: uuid.UUID(hex=u.hex, int=1))
show(lambda: uuid.UUID(bytes=b"short"))
show(lambda: uuid.UUID(bytes_le=b"x" * 17))
show(lambda: uuid.UUID(fields=(1, 2, 3)))
show(lambda: uuid.UUID(fields=(1 << 32, 0, 0, 0, 0, 0)))
show(lambda: uuid.UUID(int=-1))
show(lambda: uuid.UUID(int=1 << 128))
show(lambda: uuid.UUID(int=0, version=9))
show(lambda: setattr(u, "hex", "x"))
show(lambda: u < 5)
# (uuid3(ns, 5)'s TypeError comes from bytes + int, whose message is a
# separate runtime follow-up: "can't concat int to bytes")
