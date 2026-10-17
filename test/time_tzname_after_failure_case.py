# glibc's tzname after a failed mktime (a skipped hour between times of the
# same isdst, asked for that isdst: Lord_Howe 1981-03-01 00:15) is not matched
# in Sagebrush: strftime's %Z of a tuple with no zone then refuses, until a
# local time sets it again (test/stdlib-time-datetime.test.ts).
import time
try:
    time.mktime((1981, 3, 1, 0, 15, 0, 0, 1, 0))
except OverflowError as e:
    print("mktime", type(e).__name__, e)
for label in ("right after", "after localtime"):
    try:
        print(label, time.strftime("%Z", (2020, 1, 1, 0, 0, 0, 0, 1, 0)), time.strftime("%Z", (2020, 1, 1, 0, 0, 0, 0, 1, 1)))
    except NotImplementedError as e:
        print(label, "raises NotImplementedError", str(e)[:60])
    time.localtime(0)
