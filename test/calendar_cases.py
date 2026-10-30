# CPython's own calendar.py and locale.py (lib/, unchanged) on pyjs: each
# line printed here is compared with CPython's (test/calendar.test.ts).
# First the C locale, so CPython's output doesn't depend on the host's
# (pyjs has no C library locale: locale.py's own emulation, the C locale).
import locale
print(locale.setlocale(locale.LC_ALL, "C"), locale.getlocale())

import calendar, datetime


def show(f):
    try:
        print(f())
    except Exception as e:
        print(type(e).__name__ + ":", e)


print(calendar.month(2026, 10))
print(calendar.month(2024, 2, w=3, l=2))
print(calendar.calendar(2026))
print(calendar.calendar(1900, w=2, l=1, c=4, m=4))
calendar.prmonth(2000, 2)
calendar.prcal(2023, m=6)
print(calendar.isleap(2024), calendar.isleap(1900), calendar.isleap(2000), calendar.leapdays(1900, 2026), calendar.leapdays(2026, 1900))
print(calendar.weekday(2026, 10, 30), calendar.weekday(1, 1, 1), calendar.weekday(9999, 12, 31), calendar.monthrange(2026, 2), calendar.monthrange(2024, 2))
print(calendar.monthcalendar(2026, 10))
print(calendar.weekheader(2), calendar.weekheader(3), calendar.weekheader(9))
print(calendar.timegm((2026, 10, 30, 12, 0, 0)), calendar.timegm((1970, 1, 1, 0, 0, 0, 3, 1, 0)), calendar.timegm(datetime.datetime(2000, 2, 29, 23, 59, 59).timetuple()))
print(list(calendar.day_name), list(calendar.day_abbr), list(calendar.month_name), list(calendar.month_abbr))
print(len(calendar.month_name), calendar.month_name[-1], calendar.month_abbr[1:3], calendar.day_name[-1])
print(calendar.Month.OCTOBER, repr(calendar.Month(2)), calendar.Day.FRIDAY, repr(calendar.Day(0)), calendar.MONDAY, calendar.JANUARY, int(calendar.SUNDAY))
print(list(calendar.Month)[:3], list(calendar.Day)[-2:])

c = calendar.Calendar(firstweekday=6)
print(c.getfirstweekday(), list(c.iterweekdays()))
print(list(c.itermonthdays(2026, 10)))
print(list(c.itermonthdays2(2026, 10))[:9])
print(list(c.itermonthdays3(2026, 10))[:3], list(c.itermonthdays4(2026, 10))[-2:])
print(list(c.itermonthdates(2026, 2))[:3], list(c.itermonthdates(2026, 2))[-1])
print(c.monthdatescalendar(2026, 10)[0], c.monthdays2calendar(2026, 10)[-1])
print(len(c.yeardatescalendar(2026)), len(c.yeardatescalendar(2026, width=4)), c.yeardays2calendar(2026)[0][0][0])
print(c.yeardayscalendar(2026, 2)[0][1][0])
c.firstweekday = 2
print(c.firstweekday, c.monthdayscalendar(2026, 10)[0])

t = calendar.TextCalendar(calendar.SUNDAY)
print(t.formatmonth(2026, 10))
print(t.formatyear(2026, 2, 1, 6, 3))
print(repr(t.formatweekday(3, 5)), repr(t.formatweekheader(2)), repr(t.formatmonthname(2026, 10, 20)), repr(t.formatmonthname(2026, 10, 20, False)))
print(repr(t.formatweek(t.monthdays2calendar(2026, 10)[1], 3)), repr(t.formatday(0, 0, 2)), repr(t.formatday(7, 0, 2)))
t.prmonth(2026, 12)
t.pryear(2027, w=2, l=1, c=6, m=3)

h = calendar.HTMLCalendar(calendar.MONDAY)
print(h.formatmonth(2026, 10))
print(h.formatmonth(2026, 10, withyear=False))
print(h.formatyear(2026, width=4))
print(h.formatyearpage(2026, width=3, css="cal.css", encoding="utf-8")[:400])
print(h.cssclasses, h.cssclass_noday, h.cssclass_month, h.formatweekday(6), h.formatday(0, 3), h.formatday(5, 3))

class MyHTML(calendar.HTMLCalendar):
    cssclasses = ["a", "b", "c", "d", "e", "f", "g"]
    cssclass_month = "m"

print(MyHTML().formatmonth(2026, 2))

print(calendar.LocaleTextCalendar(locale="C").formatmonth(2026, 2))
print(calendar.LocaleHTMLCalendar(locale="C").formatmonthname(2026, 2))
print(calendar.LocaleTextCalendar(calendar.SUNDAY, "C").formatweekheader(3))

calendar.setfirstweekday(calendar.SUNDAY)
print(calendar.firstweekday(), calendar.month(2026, 10))
calendar.setfirstweekday(calendar.MONDAY)
print(calendar.firstweekday())

show(lambda: calendar.setfirstweekday(7))
show(lambda: calendar.month(2026, 13))
show(lambda: calendar.monthrange(2026, 0))
show(lambda: calendar.weekday(2026, 2, 30))
show(lambda: calendar.Calendar().monthdayscalendar(2026, 13))
show(lambda: list(calendar.Calendar().itermonthdates(9999, 12))[-1])
show(lambda: list(calendar.Calendar().itermonthdates(1, 1))[0])
show(lambda: calendar.timegm((2026, 2, 30, 0, 0, 0)))
print(issubclass(calendar.IllegalMonthError, ValueError), issubclass(calendar.IllegalWeekdayError, ValueError))
print(calendar.IllegalMonthError(13), calendar.IllegalWeekdayError(9))

# locale.py's C locale: the functions that don't depend on the host
print(locale.localeconv()["decimal_point"], repr(locale.localeconv()["thousands_sep"]), locale.localeconv()["grouping"], sorted(locale.localeconv()))
print(locale.format_string("%.2f", 1234567.891, grouping=True), locale.format_string("%d items", 1234567, grouping=True), locale.format_string("%s|%5.1f", ("x", 2.25)))
print(locale.str(3.14), locale.atof("1234.5"), locale.atoi("42"), locale.delocalize("1,234.5"), locale.localize("1234.5"))
print(locale.strcoll("a", "b"), locale.strxfrm("abc"), locale.CHAR_MAX)
print(locale.normalize("en_US"), locale.normalize("de_DE.utf8"), locale.normalize("C"), locale.normalize("ja_jp.eucjp"))
print(locale._parse_localename("en_US.UTF-8"), locale._parse_localename("C"))
show(lambda: locale.currency(5.5))
show(lambda: locale.setlocale(locale.LC_ALL, "xx_YY"))
show(lambda: locale.setlocale(99, "C"))
print(locale.setlocale(locale.LC_NUMERIC), locale.getlocale(locale.LC_NUMERIC))
show(lambda: locale.getlocale(locale.LC_ALL))
import encodings, encodings.aliases
print(encodings.normalize_encoding("UTF-8"), encodings.normalize_encoding("  latin  1 "), encodings.aliases.aliases["utf8"], encodings.aliases.aliases["latin1"], len(encodings.aliases.aliases) > 300)
import _locale
for args in [(6,), (99,), (99, "C"), (6, "POSIX"), (6, "xx"), (6, 5), ("6", "C"), (2, None)]:
    show(lambda: _locale.setlocale(*args))
show(lambda: _locale.strcoll(1, "a"))
show(lambda: _locale.strxfrm(b"x"))
print(_locale.strcoll("b", "a"), _locale.strcoll("a", "a"), repr(_locale.strxfrm("abc")), _locale.Error, issubclass(locale.Error, Exception), locale.Error is _locale.Error)
print(sorted(n for n in dir(_locale) if n.startswith("LC_")), [getattr(_locale, n) for n in sorted(n for n in dir(_locale) if n.startswith("LC_"))])
with calendar.different_locale("C"):
    print(locale.setlocale(locale.LC_TIME))

# _locale reads a str subclass by its characters, never its hooks (CAL-A1);
# a NUL is CPython's ValueError (CAL-A2); a category is a C int (CAL-A3)
class S(str):
    def __eq__(s, o): return True
    def __ne__(s, o): return False
    def __lt__(s, o): return True
    def __gt__(s, o): return True
    def __le__(s, o): return True
    def __ge__(s, o): return True
    def __str__(s): return "C"
    def __contains__(s, x): return False
    __hash__ = str.__hash__

show(lambda: _locale.strcoll(S("z"), "a"))
show(lambda: _locale.strcoll("a", S("z")))
show(lambda: _locale.strcoll(S("a"), S("a")))
show(lambda: (lambda r: (r, type(r) is str))(_locale.strxfrm(S("ab"))))
show(lambda: _locale.setlocale(locale.LC_ALL, S("not-a-locale")))
show(lambda: _locale.setlocale(locale.LC_ALL, S("C")))
show(lambda: _locale.setlocale(locale.LC_ALL, S("C\0")))
show(lambda: locale.setlocale(locale.LC_ALL, S("xx")))
for f in (lambda: _locale.strcoll("a\0", "b"), lambda: _locale.strcoll("a", "b\0"), lambda: _locale.strxfrm("a\0b"),
          lambda: _locale.setlocale(locale.LC_ALL, "C\0"), lambda: _locale.setlocale(locale.LC_ALL, "\0"), lambda: locale.strxfrm("\0")):
    show(f)
class I:
    def __index__(self): return 2
for c in (1 << 80, -(1 << 80), 2**31, 2**31 - 1, -2**31, -2**31 - 1, -1, 7, 12, 13, True, I(), 6.0, "6"):
    show(lambda: _locale.setlocale(c))
    show(lambda: _locale.setlocale(c, "C"))
print(locale.setlocale(locale.LC_ALL))
