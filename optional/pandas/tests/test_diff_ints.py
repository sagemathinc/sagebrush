# Series.diff of integer columns as pandas 3.1 computes them: an int8 or int16 column's differences exact, in
# float32; an int32, int64 or unsigned one's subtracted in its own dtype, wrapping (a uint8 0 after 1 is 255), then
# float64; positive, negative and zero periods; float columns in their own dtype. Exact values printed as hex too.
import pandas as pd
from _cases import case

data = {"uint8": [1, 0, 2, 2, 255, 3], "uint16": [1, 0, 2, 65535, 3, 3], "uint32": [1, 0, 2, 4294967295, 3, 0],
        "int8": [100, -100, 100, 1, -128, 127], "int16": [30000, -30000, 1, 32767, -32768, 0],
        "int32": [2147483647, -2147483648, 0, 5, -5, 1], "int64": [1, 0, -2, 2 ** 52, -(2 ** 52), 7],
        "float32": [1.5, 0.25, -2.0, 3.0, 1e30, -1e30], "float64": [1.5, 0.25, -2.0, 1e308, -1e308, 0.0]}
for dt, v in data.items():
    s = pd.Series(v).astype(dt)
    for p in (1, 2, -1, -2, 0, 5, 6, -6):
        case(f"{dt} diff({p})", lambda: s.diff(p))
        case(f"{dt} diff({p}).hex", lambda: [float(x).hex() if x == x else "nan" for x in s.diff(p).tolist()])
df = pd.DataFrame({"u": pd.Series([1, 0, 2]).astype("uint8"), "i": pd.Series([5, -5, 0]).astype("int8"), "f": [0.5, 0.25, 1.0]})
case("frame diff", lambda: df.diff())
case("frame diff dtypes", lambda: df.diff().dtypes)
case("frame diff(-1)", lambda: df.diff(-1))
# int64 differences past 2**53: exact, wrapped as the 64-bit subtraction wraps, then the float64 nearest
for v in ([-(2 ** 53), 1], [1, -(2 ** 53)], [2 ** 53, -1], [-1, 2 ** 53], [-(2 ** 53), 2 ** 53], [2 ** 52, -(2 ** 52) - 1, 3]):
    for p in (1, -1):
        case(f"int64 {v} diff({p}).hex", lambda: [float(x).hex() if x == x else "nan" for x in pd.Series(v).diff(p).tolist()])
for p in (10 ** 20, -(10 ** 20), 2 ** 63, -(2 ** 63)):
    case(f"diff({p})", lambda: pd.Series([1, 2]).diff(p))
