# CPython's own enum.py (lib/enum.py, unchanged) on pyjs: each line printed
# here is compared with CPython's (test/enum.test.ts).
import enum, pickle, copy, types
from enum import Enum, IntEnum, StrEnum, Flag, IntFlag, auto, unique, verify, member, nonmember


def show(f):
    try:
        print(f())
    except Exception as e:
        print(type(e).__name__ + ":", e)


class Color(Enum):
    RED = 1
    GREEN = 2
    BLUE = 3
    CRIMSON = 1  # an alias


print(list(Color), len(Color), Color.CRIMSON is Color.RED)
print(Color.RED, repr(Color.RED), str(Color.GREEN), format(Color.BLUE), f"{Color.BLUE}")
print(Color(2), Color["BLUE"], Color.RED.name, Color.RED.value, Color.RED._value_)
print(list(Color.__members__), Color.__members__["CRIMSON"])
print(type(Color.__members__).__name__, isinstance(Color.__members__, types.MappingProxyType))
print(Color.RED in Color, 1 in Color, 9 in Color, Color.RED == 1, Color.RED != Color.GREEN)
print(hash(Color.RED) == hash(Color.RED), sorted(Color, key=lambda c: c.value))
print(isinstance(Color.RED, Color), type(Color.RED), type(Color), Color.__name__, Color.__qualname__)
print([m.name for m in reversed(Color)], dir(Color.RED)[:8])
print(Color.RED.__class__.__mro__)
show(lambda: Color(7))
show(lambda: Color["PURPLE"])
show(lambda: setattr(Color, "RED", 5))
show(lambda: delattr(Color, "RED"))
show(lambda: Color.RED < Color.GREEN)
show(lambda: setattr(Color.RED, "name", "X"))
print(copy.copy(Color.RED) is Color.RED, copy.deepcopy(Color.GREEN) is Color.GREEN)
print({Color.RED: "r", Color.BLUE: "b"}[Color.CRIMSON])


class Planet(Enum):
    MERCURY = (3.303e23, 2.4397e6)
    EARTH = (5.976e24, 6.37814e6)

    def __init__(self, mass, radius):
        self.mass = mass
        self.radius = radius

    @property
    def gravity(self):
        return 6.673e-11 * self.mass / (self.radius * self.radius)


print(Planet.EARTH.value, Planet.EARTH.mass, round(Planet.EARTH.gravity, 4), Planet((3.303e23, 2.4397e6)))


class Auto(Enum):
    A = auto()
    B = auto()
    C = 10
    D = auto()


print(list(Auto), [a.value for a in Auto])


class Lower(Enum):
    @staticmethod
    def _generate_next_value_(name, start, count, last_values):
        return name.lower()

    X = auto()
    Y = auto()


print(list(Lower), Lower("y"))


class Shape(Enum):
    SQUARE = 2
    CIRCLE = 3

    @classmethod
    def _missing_(cls, value):
        if value == "sq":
            return cls.SQUARE
        return None

    def describe(self):
        return f"{self.name} has {self.value} parts"

    def __str__(self):
        return "shape:" + self.name


print(Shape("sq"), Shape.CIRCLE.describe(), str(Shape.SQUARE), repr(Shape.SQUARE))
show(lambda: Shape("tri"))


class Num(IntEnum):
    ONE = 1
    TWO = 2


print(Num.ONE + 1, Num.TWO * 3, Num.ONE < Num.TWO, Num.TWO == 2, int(Num.TWO), str(Num.ONE), repr(Num.ONE))
print(format(Num.TWO), f"{Num.TWO:>4}|", sorted([Num.TWO, Num.ONE]), [0, 10, 20][Num.TWO], Num(1) is Num.ONE)
print(isinstance(Num.ONE, int), Num.__mro__)


class S(StrEnum):
    A = auto()
    B = "bee"


print(S.A, repr(S.B), S.A == "a", S.B.upper(), "x" + S.B, f"{S.B}", len(S.B), S.B.value)
show(lambda: type("Bad", (StrEnum,), {"X": 1}))


class Perm(Flag):
    R = 4
    W = 2
    X = 1
    RW = 6


print(Perm.R | Perm.W, repr(Perm.R | Perm.X), Perm.RW, list(Perm), list(Perm.RW), Perm(0), bool(Perm(0)))
print(Perm.R in Perm.RW, Perm.X in Perm.RW, ~Perm.R, Perm.RW & Perm.W, Perm.RW ^ Perm.R, Perm(7), len(Perm(7)))
print(Perm(7).name, Perm(0).name, (Perm.R | Perm.W) is Perm.RW, Perm._boundary_, list(Perm.__members__))


class IP(IntFlag):
    R = 4
    W = 2
    X = 1


print(IP.R | IP.W, repr(IP(7)), int(IP.R | IP.X), IP.R | 8, repr(IP(9)), IP.R + 1, ~IP.R, IP(0), list(IP(5)))


class Strict(Flag, boundary=enum.STRICT):
    A = 1
    B = 2


show(lambda: Strict(4))
print(Strict(3))


class Keep(Flag, boundary=enum.KEEP):
    A = 1
    B = 2


print(repr(Keep(5)), Keep(5).value)


class Conform(Flag, boundary=enum.CONFORM):
    A = 1
    B = 2


print(repr(Conform(7)))


def make_dup():
    @unique
    class Dup(Enum):
        A = 1
        B = 1
    return Dup


show(make_dup)


def make_verify():
    @verify(enum.CONTINUOUS)
    class Gap(Enum):
        A = 1
        C = 3
    return Gap


show(make_verify)


class WithMember(Enum):
    A = 1
    helper = nonmember(5)

    @member
    def f():
        return 3


print(list(WithMember.__members__), WithMember.f.value(), WithMember.helper)

# (module= given: pyjs has no sys._getframemodulename, so without it the
# functional API names the module '<unknown>', as CPython does where it is missing)
Animal = Enum("Animal", "ANT BEE CAT", module=__name__)
print(list(Animal), Animal.BEE.value, Animal.__module__ == __name__, pickle.loads(pickle.dumps(Animal.CAT)) is Animal.CAT)
Pairs = Enum("Pairs", [("X", 10), ("Y", 20)])
print(list(Pairs), Pairs(20))
Mapped = IntEnum("Mapped", {"P": 5, "Q": 6})
print(Mapped.Q + 1, repr(Mapped.P))
Started = Enum("Started", "A B", start=10)
print([s.value for s in Started])

show(lambda: type("Sub", (Color,), {}))


class Base(Enum):
    def hello(self):
        return "hello " + self.name


class Derived(Base):
    Z = 1


print(Derived.Z.hello())


class Ordered(Enum):
    def __lt__(self, other):
        return self.value < other.value

    LOW = 1
    HIGH = 2


print(sorted([Ordered.HIGH, Ordered.LOW]))
print(pickle.loads(pickle.dumps(Color.GREEN)) is Color.GREEN, pickle.loads(pickle.dumps(Perm.RW)) is Perm.RW)
print(enum.EnumType is enum.EnumMeta, type(Color) is enum.EnumType, issubclass(IntFlag, Flag))
print(Color.RED.__reduce_ex__(4))
print([e.name for e in enum.FlagBoundary], enum.show_flag_values(13))
print(types.DynamicClassAttribute.__module__, Enum.__dict__["name"].__class__.__name__)


class Ext(float, enum.ReprEnum):
    A = 1.5


print(str(Ext.A), repr(Ext.A), Ext.A * 2, format(Ext.A, ".2f"))
show(lambda: type("NoData", (enum.ReprEnum,), {"A": 1}))


@enum.global_enum
class G(IntEnum):
    G1 = 1
    G2 = 2


print(repr(G.G1), str(G.G2), G1 if "G1" in globals() else "no G1")
show(lambda: Enum("E", "A A"))
show(lambda: type("Bad2", (Enum,), {"_sunder_": 1}))
print(enum.Enum.__members__ if hasattr(enum.Enum, "__members__") else None, bool(Color), bool(Num))
