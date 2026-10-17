# datetime's types named as CPython's C ones, in messages and in pickles
# (sage2); compared with CPython by test/core-semantics.test.ts
import datetime, pickle
print(datetime.date.__module__, datetime.date.__qualname__, repr(datetime.date(2020, 1, 2)), datetime.timezone.utc)
for o in (datetime.date(2020, 1, 1), datetime.timedelta()):
    try: o.nope
    except AttributeError as e: print(e)
for x in (datetime.date(2020, 1, 2), datetime.timedelta(days=1, seconds=5), datetime.datetime(2020, 1, 2, 3, 4, 5, 6), datetime.timezone.utc, datetime.time(1, 2)):
    for p in (2, 4):
        print(p, pickle.dumps(x, p).hex())
print(type(datetime.date(2020,1,1) - datetime.date(2019,1,1)).__module__)
