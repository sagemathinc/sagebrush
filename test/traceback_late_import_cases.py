# traceback imported in the handler, after the exception was caught (the
# commonest use), and a generator re-raising after another function resumed
# it (compared with CPython 3.14 by test/sortedcontainers-blockers.test.ts)


def work():
    return {}["missing"]


try:
    work()
except Exception:
    import traceback
    print(traceback.format_exc(), end="")


def caught():
    try:
        1 / 0
    except ZeroDivisionError as e:
        return e


old = caught()
try:
    raise ValueError("later") from old
except ValueError:
    import traceback
    print(traceback.format_exc(), end="")


def generator():
    try:
        1 / 0
    except ZeroDivisionError:
        yield "pause"
        raise


def prime(g):
    return next(g)


def resume(g):
    try:
        next(g)
    except ZeroDivisionError:
        return traceback.format_exc()


g = generator()
print(prime(g))
print(resume(g), end="")


# re-raised from a helper the handler calls, and re-raised twice
def helper():
    raise


def handler():
    try:
        int("z")
    except ValueError:
        helper()


try:
    handler()
except ValueError:
    print(traceback.format_exc(), end="")


def twice():
    try:
        try:
            [].pop()
        except IndexError:
            raise
    except IndexError:
        raise


try:
    twice()
except IndexError:
    print(traceback.format_exc(), end="")
try:
    try:
        raise OSError("x")
    finally:
        print("finally")
except OSError:
    print(traceback.format_exc(), end="")
