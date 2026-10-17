# time and datetime under a TZ given in some form (astra's CORR-DCB-1): run
# under each form; where glibc and JavaScript's Date read it alike, as
# CPython; otherwise every local time refuses, naming TZ, and the rest works.
import time, datetime as D

def show(label, f):
    try:
        print(label, '->', repr(f()))
    except Exception as e:
        print(label, 'raises', type(e).__name__, str(e))

for n in [0, 1584237600, 1604214000]:
    show('localtime %d' % n, lambda: (tuple(time.localtime(n))[:8], time.localtime(n).tm_gmtoff))
    show('ctime %d' % n, lambda: time.ctime(n))
    show('fromtimestamp %d' % n, lambda: str(D.datetime.fromtimestamp(n)))
    show('date.fromtimestamp %d' % n, lambda: D.date.fromtimestamp(n))
    show('gmtime %d' % n, lambda: time.gmtime(n))
    show('aware %d' % n, lambda: D.datetime.fromtimestamp(n, D.timezone.utc))
show('timezone', lambda: time.timezone)
show('altzone', lambda: time.altzone)
show('daylight', lambda: time.daylight)
show('mktime', lambda: time.mktime((2020, 6, 1, 12, 0, 0, 0, 1, -1)))
show('timestamp', lambda: D.datetime(2020, 6, 1, 12).timestamp())
show('strftime %Y', lambda: time.strftime('%Y', (2020, 6, 1, 12, 0, 0, 0, 1, -1)))
show('now type', lambda: type(D.datetime.now()).__name__)
show('now utc type', lambda: type(D.datetime.now(D.timezone.utc)).__name__)
show('localtime type', lambda: type(time.localtime()).__name__)
show('asctime tuple', lambda: time.asctime((2020, 6, 1, 12, 0, 0, 0, 1, -1)))
