# strftime as glibc 2.39 writes it in the C locale, compared with CPython 3.14
# under TZ=UTC by test/stdlib-time-datetime.test.ts: every flag (and two
# combinations), width and E/O modifier with every letter and a few other
# characters, over dates at the calendar's edges (years 0, 1, -1, -5000,
# 10000, ISO-week boundaries), each line printed with ascii().
import time, zlib
dates = [(2020,1,2,3,4,5,3,2,0), (1999,12,31,23,59,59,4,365,0), (2021,1,3,12,0,0,6,3,0), (2004,12,27,0,0,0,0,362,0),
         (1,1,1,0,0,0,0,1,0), (0,1,1,13,5,9,5,1,0), (-1,12,31,12,0,0,4,366,0), (10000,6,15,7,8,9,3,167,0), (-5000,3,1,11,0,0,2,60,0),
         (2008,12,29,0,0,0,0,364,0), (2010,1,3,0,0,0,6,3,0), (2026,10,17,15,30,0,5,290,1), (2026,10,17,0,0,0,5,290,-1)]
letters = [chr(c) for c in range(ord('a'), ord('z')+1)] + [chr(c) for c in range(ord('A'), ord('Z')+1)] + ["%", "+", ":", "1", "é"]
for d in dates:
    lines = []
    for flag in ["", "_", "-", "0", "^", "#", "^#", "-0"]:
        for width in ["", "1", "4", "12"]:
            for mod in ["", "E", "O"]:
                for c in letters:
                    f = "%" + flag + width + mod + c
                    try: r = time.strftime(f, d)
                    except Exception as e: r = "!" + type(e).__name__ + ":" + str(e)
                    lines.append(f + "=" + ascii(r))
    print(d, zlib.crc32("\n".join(lines).encode()))
    for l in lines: print(" ", l)
