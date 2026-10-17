"""Time zones from TZif data (RFC 8536) and POSIX TZ strings, for time's
localtime and mktime as CPython on glibc gives them.

The format is RFC 8536's and POSIX's. What glibc does around it (which zone
a TZ value names, the years a TZ string's rules cover, mktime's choice in a
skipped or repeated hour and for an isdst the time does not have) was found
by comparison with CPython 3.14 on glibc 2.39: no glibc source was read.
Anything outside what was compared raises ZoneUnsupported, naming it.

This module runs under CPython too (the comparison harness imports it), and
zoneinfo is to read TZif data through parse_tzif and Zone.
"""

# ------------------------------------------------------------------ errors


class ZoneUnsupported(Exception):
    """A zone (file or TZ string) that is not read here: why."""


# ------------------------------------------------------------------ calendar


def _days(y, m, d):
    """Days since 1970-01-01 of a proleptic Gregorian date."""
    y -= m <= 2
    era = y // 400
    yoe = y - era * 400
    doy = (153 * (m + (-3 if m > 2 else 9)) + 2) // 5 + d - 1
    return era * 146097 + yoe * 365 + yoe // 4 - yoe // 100 + doy - 719468


def _year_of(days):
    z = days + 719468
    era = z // 146097
    doe = z - era * 146097
    yoe = (doe - doe // 1460 + doe // 36524 - doe // 146096) // 365
    doy = doe - (365 * yoe + yoe // 4 - yoe // 100)
    mp = (5 * doy + 2) // 153
    return yoe + era * 400 + (mp >= 10)


def _leap(y):
    return y % 4 == 0 and (y % 100 != 0 or y % 400 == 0)


_MONTH_DAYS = (31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31)

# ------------------------------------------------------------------ TZif

# (bounds checked from the header, before anything is allocated: real zone
# files have at most a few thousand transitions, a dozen types and a few
# dozen abbreviation bytes)
MAX_FILE = 1 << 20
MAX_TIMES = 1 << 16
MAX_TYPES = 256
MAX_CHARS = 1 << 10
MAX_FOOTER = 1 << 10


def _u32(b, i):
    return (b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]


def _s32(b, i):
    v = _u32(b, i)
    return v - (1 << 32) if v >= 1 << 31 else v


def _s64(b, i):
    v = (_u32(b, i) << 32) | _u32(b, i + 4)
    return v - (1 << 64) if v >= 1 << 63 else v


def _header(data, at):
    if len(data) < at + 44 or bytes(data[at:at + 4]) != b"TZif":
        raise ZoneUnsupported("not a TZif file")
    version = data[at + 4]
    if version not in (0, 0x32, 0x33, 0x34):
        raise ZoneUnsupported("a TZif version %r not read here" % chr(version))
    isutcnt, isstdcnt, leapcnt, timecnt, typecnt, charcnt = (_u32(data, at + 20 + 4 * k) for k in range(6))
    if timecnt > MAX_TIMES or typecnt > MAX_TYPES or charcnt > MAX_CHARS:
        raise ZoneUnsupported("a TZif file with more transitions, types or abbreviation bytes than any zone has")
    if typecnt == 0 or charcnt == 0:
        raise ZoneUnsupported("a TZif file with no time types")
    if leapcnt:
        raise ZoneUnsupported("a TZif file with leap seconds (a right/ zone)")
    if isutcnt not in (0, typecnt) or isstdcnt not in (0, typecnt):
        raise ZoneUnsupported("a malformed TZif file (its indicator counts)")
    return version, isutcnt, isstdcnt, timecnt, typecnt, charcnt


def parse_tzif(data):
    """A Zone from the bytes of a TZif file (RFC 8536, versions 1 to 4): the
    64-bit data and footer of version 2 and later, else version 1's."""
    if len(data) > MAX_FILE:
        raise ZoneUnsupported("a TZif file larger than any zone's")
    version, isutcnt, isstdcnt, timecnt, typecnt, charcnt = _header(data, 0)
    size1 = 44 + timecnt * 5 + typecnt * 6 + charcnt + isstdcnt + isutcnt
    at, tsize = 44, 4
    if version >= 0x32:
        if len(data) < size1:
            raise ZoneUnsupported("a truncated TZif file")
        version, isutcnt, isstdcnt, timecnt, typecnt, charcnt = _header(data, size1)
        at, tsize = size1 + 44, 8
    end = at + timecnt * (tsize + 1) + typecnt * 6 + charcnt + isstdcnt + isutcnt
    if len(data) < end:
        raise ZoneUnsupported("a truncated TZif file")
    read = _s64 if tsize == 8 else _s32
    times = [read(data, at + tsize * k) for k in range(timecnt)]
    at += tsize * timecnt
    index = list(data[at:at + timecnt])
    at += timecnt
    raw = []
    for k in range(typecnt):
        raw.append((_s32(data, at), data[at + 4], data[at + 5]))
        at += 6
    chars = bytes(data[at:at + charcnt])
    for k in range(1, timecnt):
        if times[k] <= times[k - 1]:
            raise ZoneUnsupported("a malformed TZif file (its transitions are not in order)")
    if any(i >= typecnt for i in index):
        raise ZoneUnsupported("a malformed TZif file (a transition's type)")
    types = []
    for utoff, isdst, ai in raw:
        if isdst > 1 or ai >= charcnt or utoff == -(1 << 31):
            raise ZoneUnsupported("a malformed TZif file (a time type)")
        z = chars.find(b"\0", ai)
        if z < 0:
            raise ZoneUnsupported("a malformed TZif file (an abbreviation)")
        try:
            abbr = chars[ai:z].decode("ascii")
        except UnicodeDecodeError:
            raise ZoneUnsupported("a TZif file with a non-ASCII abbreviation") from None
        types.append((utoff, isdst, abbr))
    rule = None
    if version >= 0x32:
        at = end
        if len(data) < at + 2 or data[at] != 0x0A:
            raise ZoneUnsupported("a malformed TZif file (its footer)")
        nl = bytes(data[at + 1:at + 2 + MAX_FOOTER]).find(b"\n")
        if nl < 0:
            raise ZoneUnsupported("a malformed TZif file (its footer)")
        footer = bytes(data[at + 1:at + 1 + nl])
        if footer:
            try:
                text = footer.decode("ascii")
            except UnicodeDecodeError:
                raise ZoneUnsupported("a malformed TZif file (its footer)") from None
            rule = parse_posix(text)
    return Zone(times, index, types, rule, from_1970=False)


# ------------------------------------------------------------------ POSIX TZ strings


def _name(s, i):
    """A std or dst name at s[i:]: (name, next index), or None."""
    if i < len(s) and s[i] == "<":
        j = s.find(">", i + 1)
        if j < 0:
            return None
        name = s[i + 1:j]
        if len(name) < 3 or not all(c.isalnum() or c in "+-" for c in name):
            return None
        return name, j + 1
    j = i
    while j < len(s) and ("A" <= s[j] <= "Z" or "a" <= s[j] <= "z"):
        j += 1
    if j - i < 3:
        return None
    return s[i:j], j


def _number(s, i, limit):
    j = i
    while j < len(s) and "0" <= s[j] <= "9":
        j += 1
    if j == i or j - i > 9:
        return None
    return int(s[i:j]), j


def _hms(s, i, hours_max, clamp):
    """[+-]hh[:mm[:ss]] at s[i:]: (signed seconds, next index), or None.
    With clamp, each part is cut to glibc's 24, 59 and 59 (as seen); else
    a part past hours_max, 59 or 59 is refused."""
    sign = 1
    if i < len(s) and s[i] in "+-":
        sign = -1 if s[i] == "-" else 1
        i += 1
    r = _number(s, i, 0)
    if r is None:
        return None
    h, i = r
    m = sec = 0
    if i < len(s) and s[i] == ":":
        r = _number(s, i + 1, 0)
        if r is None:
            return None
        m, i = r
        if i < len(s) and s[i] == ":":
            r = _number(s, i + 1, 0)
            if r is None:
                return None
            sec, i = r
    if clamp:
        h, m, sec = min(h, 24), min(m, 59), min(sec, 59)
    elif h > hours_max or m > 59 or sec > 59:
        raise ZoneUnsupported("a TZ rule time out of range")
    return sign * (h * 3600 + m * 60 + sec), i


def _date_rule(s, i):
    """Jn, n or Mm.w.d with an optional /time, at s[i:]."""
    if i < len(s) and s[i] == "J":
        r = _number(s, i + 1, 0)
        if r is None or not 1 <= r[0] <= 365:
            raise ZoneUnsupported("a TZ rule's Julian day out of range or missing")
        rule, i = ("J", r[0]), r[1]
    elif i < len(s) and s[i] == "M":
        parts = []
        j = i + 1
        for k in range(3):
            r = _number(s, j, 0)
            if r is None:
                raise ZoneUnsupported("a TZ rule's Mm.w.d incomplete")
            parts.append(r[0])
            j = r[1]
            if k < 2:
                if j >= len(s) or s[j] != ".":
                    raise ZoneUnsupported("a TZ rule's Mm.w.d incomplete")
                j += 1
        m, w, d = parts
        if not (1 <= m <= 12 and 1 <= w <= 5 and 0 <= d <= 6):
            raise ZoneUnsupported("a TZ rule's Mm.w.d out of range")
        rule, i = ("M", m, w, d), j
    else:
        r = _number(s, i, 0)
        if r is None or not 0 <= r[0] <= 365:
            raise ZoneUnsupported("a TZ rule's day out of range or missing")
        rule, i = ("n", r[0]), r[1]
    t = 7200
    if i < len(s) and s[i] == "/":
        r = _hms(s, i + 1, 167, False)
        if r is None:
            raise ZoneUnsupported("a TZ rule's time missing")
        t, i = r
    return rule + (t,), i


def parse_posix(s):
    """The rule of a POSIX TZ string (a TZif footer, or a TZ value naming no
    file): std offset [dst [offset] ,start[/time],end[/time]]. A DST name
    without both rules (glibc's default rules come from a posixrules file)
    and anything malformed raise ZoneUnsupported."""
    r = _name(s, 0)
    if r is None:
        raise ZoneUnsupported("not a TZ rule (its standard time name)")
    std, i = r
    r = _hms(s, i, 24, True)
    if r is None:
        raise ZoneUnsupported("not a TZ rule (its standard time offset)")
    off, i = r
    if i == len(s):
        return Rule(std, -off, None, None, None, None)
    r = _name(s, i)
    if r is None:
        raise ZoneUnsupported("a malformed TZ rule (after its standard time)")
    dst, i = r
    doff = off - 3600
    if i < len(s) and s[i] != ",":
        r = _hms(s, i, 24, True)
        if r is None:
            raise ZoneUnsupported("a malformed TZ rule (its daylight-saving offset)")
        doff, i = r
    if i == len(s) or s[i] != ",":
        raise ZoneUnsupported("a TZ rule with daylight saving but without both of its rules")
    start, i = _date_rule(s, i + 1)
    if i == len(s) or s[i] != ",":
        raise ZoneUnsupported("a TZ rule with daylight saving but without both of its rules")
    end, i = _date_rule(s, i + 1)
    if i != len(s):
        raise ZoneUnsupported("a malformed TZ rule (text after its rules)")
    return Rule(std, -off, dst, -doff, start, end)


def _rule_day(rule, y):
    """Days since 1970-01-01 of a rule's date in year y."""
    if rule[0] == "J":
        n = rule[1]
        return _days(y, 1, 1) + n - 1 + (1 if _leap(y) and n >= 60 else 0)
    if rule[0] == "n":
        return _days(y, 1, 1) + rule[1]
    _, m, w, d = rule[:4]
    first = _days(y, m, 1)
    day = (d - (first + 4)) % 7  # (1970-01-01 was a Thursday, weekday 4)
    day += 7 * (w - 1)
    dim = _MONTH_DAYS[m - 1] + (1 if m == 2 and _leap(y) else 0)
    while day >= dim:
        day -= 7
    return first + day


class Rule:
    """A POSIX TZ rule: standard time, and daylight saving between two
    yearly changes (each at a local time: the start in standard time, the
    end in daylight-saving time)."""

    def __init__(self, std, std_off, dst, dst_off, start, end):
        self.std, self.std_off, self.dst, self.dst_off, self.start, self.end = std, std_off, dst, dst_off, start, end

    def changes(self, y):
        """(start, end) in UTC seconds in year y."""
        s = _rule_day(self.start, y) * 86400 + self.start[-1] - self.std_off
        e = _rule_day(self.end, y) * 86400 + self.end[-1] - self.dst_off
        return s, e

    def find(self, t):
        """(utoff, isdst, abbr) at UTC second t: by the two changes of t's
        UTC year alone (a change the rules put in the year before or after
        does not count), as glibc decides (as seen). Before 1970 glibc puts
        t before both changes: daylight saving all year where the year's
        end comes before its start, none where it comes after."""
        if self.dst is None:
            return self.std_off, 0, self.std
        s, e = self.changes(_year_of(t // 86400))
        if s == e:
            raise ZoneUnsupported("a TZ rule whose daylight saving starts and ends at the same instant")
        if t < 0:
            dst = s > e
        elif s < e:
            dst = s <= t < e
        else:
            dst = not e <= t < s
        if dst:
            return self.dst_off, 1, self.dst
        return self.std_off, 0, self.std


# ------------------------------------------------------------------ zones


class Zone:
    """A zone: transitions (UTC seconds, in order), each to a time type
    (utoff, isdst, abbr); before the first one, type 0 (RFC 8536); after the
    last, the footer's rule if there is one. A zone made from a TZ string
    alone has only the rule; glibc applies it from 1970 on, an earlier
    instant getting 1970-01-01's state (as seen)."""

    def __init__(self, times, index, types, rule, from_1970, names=None):
        self.times, self.index, self.types, self.rule, self.from_1970 = times, index, types, rule, from_1970
        # (glibc's tzname for a zone made from a TZ value alone: constant)
        self.names = names

    @classmethod
    def from_rule(cls, rule):
        names = [rule.std, rule.dst if rule.dst is not None else rule.std]
        return cls([], [], [], rule, True, names)

    def names_after(self, t, state):
        """glibc's tzname (the names strftime's %Z gives a time tuple with no
        zone: [isdst 0, isdst 1]) after a local time computed at UTC second
        t, from state, the names before (as seen): the found type's name for
        its isdst, and for the other isdst the next later transition's type
        of that isdst (before the first transition: the type array's first
        of that isdst), else the found type's own; after the last
        transition, the footer's [std, dst] ([std, std] without daylight
        saving)."""
        if self.names is not None:
            return list(self.names)
        if state is None:
            state = [None, None]
        times = self.times
        if times and t >= times[-1] and self.rule is not None:
            r = self.rule
            return [r.std, r.dst if r.dst is not None else r.std]
        if not times and self.rule is not None:
            r = self.rule
            return [r.std, r.dst if r.dst is not None else r.std]
        if not times or t < times[0]:
            typ, i = self.types[0], -1
        else:
            lo, hi = 0, len(times)
            while hi - lo > 1:
                mid = (lo + hi) // 2
                if times[mid] <= t:
                    lo = mid
                else:
                    hi = mid
            i = lo
            typ = self.types[self.index[i]]
        new = list(state)
        new[typ[1]] = typ[2]
        other = 1 - typ[1]
        found = None
        if i < 0:
            for tt in self.types:
                if tt[1] == other:
                    found = tt[2]
                    break
        else:
            for j in range(i + 1, len(times)):
                tt = self.types[self.index[j]]
                if tt[1] == other:
                    found = tt[2]
                    break
        new[other] = typ[2] if found is None else found
        return new

    def find(self, t):
        """(utoff, isdst, abbr) at UTC second t."""
        times = self.times
        if times and t >= times[0]:
            lo, hi = 0, len(times)
            while hi - lo > 1:
                mid = (lo + hi) // 2
                if times[mid] <= t:
                    lo = mid
                else:
                    hi = mid
            if lo == len(times) - 1 and self.rule is not None:
                return self.rule.find(t)
            return self.types[self.index[lo]]
        if times or self.rule is None:
            return self.types[0]
        return self.rule.find(t)


# ------------------------------------------------------------------ mktime

# (mktime's search for a time with the asked isdst, as seen: from the
# time found, 601200 s (a week less an hour) at a time, earlier first, then
# later, up to 381 steps each way)
PROBE_STEP = 601200
PROBE_STEPS = 381


def mktime(zone, w, isdst, last):
    """(t, offset) for the wall clock w (local fields as if UTC seconds) and
    the asked isdst, as mktime gives them on glibc (as seen); last is the
    offset the previous call used (0 at first), which decides a repeated
    hour asked with isdst -1, and the offset returned is the next call's."""
    want = -1 if isdst < 0 else (1 if isdst > 0 else 0)
    t = w - last
    seen = []
    while True:
        off = zone.find(t)[0]
        t2 = w - off
        if t2 == t:
            break
        if t2 in seen:
            # (a skipped hour: the offsets on either side each send w to the
            # other side, and the steps go round between two points. Sides
            # of different isdst: -1 takes the isdst 0 side's offset, 0 and 1
            # the side asked for. Sides of the same isdst s: asking for s is
            # an error (EOVERFLOW, OverflowError in CPython); anything else
            # takes the first point the steps came back to, as seen)
            a, b = zone.find(t), zone.find(t2)
            if a[1] != b[1]:
                pick = a if a[1] == (0 if want < 0 else want) else b
                return w - pick[0], pick[0]
            if want == a[1]:
                raise OverflowError("mktime argument out of range")
            return t2, w - t2
        if len(seen) > 8:
            raise ZoneUnsupported("mktime found no consistent offset")
        seen.append(t)
        t = t2
    found = zone.find(t)
    if want < 0 or found[1] == want:
        return t, found[0]
    for k in range(1, PROBE_STEPS + 1):
        for p in (t - k * PROBE_STEP, t + k * PROBE_STEP):
            other = zone.find(p)
            if other[1] == want:
                return w - other[0], other[0]
    off = found[0] + (3600 if want else -3600)
    return w - off, off


# ------------------------------------------------------------------ TZ values

DEFAULT_TZDIR = "/usr/share/zoneinfo"
DEFAULT_ZONE = "/etc/localtime"
MAX_PATH = 4096


def utc_zone(abbr="UTC"):
    return Zone([], [], [(0, 0, abbr)], None, False, [abbr, abbr])


def _fallback(name):
    """glibc's reading of a TZ value that names no zone file (as seen): a
    standard time name of 3 or more letters (else ""), its offset (else
    0, and nothing after it read), and anything after the offset as a TZ
    rule (refused if malformed)."""
    r = _name(name, 0)
    if r is None:
        return utc_zone("")
    std, i = r
    r = _hms(name, i, 24, True)
    if r is None:
        # (a name alone: glibc's tzname then has no daylight-saving name)
        return Zone([], [], [(0, 0, std)], None, False, [std, ""])
    if r[1] == len(name):
        return Zone([], [], [(-r[0], 0, std)], None, False, [std, std])
    return Zone.from_rule(parse_posix(name))


def resolve(tz, tzdir, read):
    """The zone glibc uses for the TZ value tz (None: unset) and TZDIR
    tzdir (None or "": the default), reading files with read(path), which
    returns the bytes, or None where the file cannot be read (missing, not
    permitted, a directory), and raises where reading is refused outright
    (a sandbox): glibc's fallback is for the former only."""
    if tz is None:
        data = read(DEFAULT_ZONE)
        if data is None:
            raise ZoneUnsupported("no zone: TZ is not set and %s cannot be read" % DEFAULT_ZONE)
        if bytes(data[:4]) != b"TZif":
            raise ZoneUnsupported("%s is not a TZif file" % DEFAULT_ZONE)
        return parse_tzif(data)
    name = tz[1:] if tz.startswith(":") else tz
    if name == "":
        return utc_zone()
    path = name if name.startswith("/") else (tzdir or DEFAULT_TZDIR) + "/" + name
    if len(path) > MAX_PATH or "\0" in path:
        raise ZoneUnsupported("a TZ value too long, or with a NUL character")
    data = read(path)
    if data is not None and bytes(data[:4]) == b"TZif":
        return parse_tzif(data)
    return _fallback(name)
