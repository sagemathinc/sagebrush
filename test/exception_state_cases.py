# The exception being handled (sys.exception(), sys.exc_info()) and the
# __context__ an exception gets when raised, against CPython: per-frame state
# for generators and coroutines, finally clauses, with-statement exits,
# except-clause matching, and contextlib's exit stacks.
import sys
import contextlib


def state(label):
    e = sys.exception()
    t, v, tb = sys.exc_info()
    print(label, None if e is None else repr(e), None if t is None else t.__name__, v is e)


def chain(e):
    out = []
    while e is not None and len(out) < 10:
        out.append(repr(e))
        e = e.__context__
    return out


# --- generators keep their handled exception while paused
def gen(tag):
    try:
        raise ValueError(tag)
    except ValueError:
        state(tag + " enter")
        yield 1
        state(tag + " resume")
        yield 2
        state(tag + " finish")
    state(tag + " after handler")
    yield 3


a, b, c = gen("A"), gen("B"), gen("C")
next(a)
state("caller after A")
next(b)
next(c)
state("caller after B, C")
next(b)
next(a)
state("caller after resumes")
c.close()
state("after C closed")
next(a)
state("after A left its handler")
b.close()
a.close()
state("after all closed")

# a generator sees its caller's exception when it handles none itself, and a
# paused one keeps its own over its next caller's
def plain():
    state("plain gen")
    yield
    state("plain gen resumed")
    yield


p = plain()
next(p)
try:
    raise KeyError("caller")
except KeyError:
    next(p)
    g = gen("D")
    next(g)
    state("caller's own after D paused")
    next(g)
    state("caller's own again")
g.close()

# a generator resumed from inside a handler, and an exception thrown in
def catcher():
    while True:
        try:
            yield
        except Exception as e:
            state("catcher got " + repr(e))
            yield "handled"
            state("catcher after handled")


k = catcher()
next(k)
print(k.throw(ValueError("thrown")))
state("after throw")
try:
    raise OSError("outer")
except OSError:
    next(k)
    state("outer handler after resume")
print(k.throw(TypeError("second")))
k.close()
state("after catcher closed")


# yield from inside a handler: the delegate's and delegator's states nest
def inner():
    try:
        raise LookupError("inner")
    except LookupError:
        yield "i1"
        state("inner resumed")


def outer():
    try:
        raise ArithmeticError("outer")
    except ArithmeticError:
        yield from inner()
        state("outer after delegate")
        yield "o1"


o = outer()
print(next(o))
state("after outer paused")
print(next(o))
state("after outer paused again")
o.close()
state("after outer closed")


# --- a contextmanager whose setup handles an exception before it yields
@contextlib.contextmanager
def cm():
    try:
        raise ValueError("setup")
    except ValueError:
        state("cm before yield")
        yield
        state("cm after yield")


with cm():
    state("with body")
state("after cm")


@contextlib.contextmanager
def cm_catches():
    try:
        yield
    except ZeroDivisionError:
        state("cm caught")


with cm_catches():
    1 / 0
state("after cm_catches")


# --- coroutines keep theirs across await
class Pause:
    def __await__(self):
        yield "pause"


async def coro(tag):
    try:
        raise ValueError(tag)
    except ValueError:
        state(tag + " enter")
        await Pause()
        state(tag + " resume")
        await Pause()


async def awaiter():
    try:
        raise KeyError("awaiter")
    except KeyError:
        await coro("nested")
        state("awaiter after nested")


ca, cb = coro("coro A"), coro("coro B")
ca.send(None)
cb.send(None)
state("caller after coros")
ca.send(None)
ca.close()
state("after coro A closed")
cb.send(None)
cb.close()
w = awaiter()
w.send(None)
state("caller after awaiter paused")
w.send(None)
try:
    w.send(None)
except StopIteration:
    state("awaiter done")


# --- finally clauses: the exception passing through, if any
def pending_finally():
    try:
        raise LookupError("pending")
    finally:
        state("pending finally")


def normal_finally():
    try:
        pass
    finally:
        state("normal finally")


def return_finally():
    try:
        return 1
    finally:
        state("return finally")


try:
    pending_finally()
except LookupError:
    state("caught after finally")
normal_finally()
return_finally()
try:
    raise ValueError("outer for finally")
except ValueError:
    try:
        pending_finally()
    except LookupError:
        state("nested caught")
    normal_finally()
    return_finally()
    state("outer restored")


def swallow():
    try:
        raise ValueError("swallowed")
    finally:
        return "finally returned"


print(swallow())
state("after swallow")

for i in range(3):
    try:
        try:
            raise KeyError(i)
        finally:
            state("loop finally %d" % i)
            if i == 1:
                break
    except KeyError:
        state("loop caught %d" % i)
state("after loop")

try:
    try:
        raise KeyError("first")
    finally:
        raise ValueError("from finally")
except ValueError as e:
    print("finally raise", chain(e))

try:
    try:
        raise KeyError("first")
    finally:
        {}["missing"]
except KeyError as e:
    print("finally runtime error", chain(e))


def gen_finally():
    try:
        raise ValueError("gen pending")
    finally:
        state("gen finally before yield")
        yield
        state("gen finally after yield")


gf = gen_finally()
next(gf)
state("caller with gen in finally")
try:
    next(gf)
except ValueError as e:
    state("caught gen pending")


# --- except clauses: matching sees the exception
def which():
    state("matching")
    return ValueError


def not_it():
    state("not it")
    return KeyError


try:
    raise ValueError("matched")
except not_it():
    pass
except which():
    state("in handler")

try:
    try:
        raise ValueError("unmatched")
    except not_it():
        pass
except ValueError:
    state("outer got unmatched")


# --- with statements: __exit__ sees the body's exception
class Observe:
    def __init__(self, suppress=False, fail=None):
        self.suppress, self.fail = suppress, fail

    def __enter__(self):
        return self

    def __exit__(self, typ, value, tb):
        state("exit")
        print("exit identity", sys.exception() is value)
        if self.fail:
            raise self.fail
        return self.suppress


with Observe():
    pass
try:
    with Observe():
        raise ValueError("body")
except ValueError:
    state("after with")
with Observe(suppress=True):
    raise ValueError("suppressed")
state("after suppressed")
try:
    with Observe(fail=RuntimeError("exit failed")):
        raise ValueError("body2")
except RuntimeError as e:
    print("exit raise", chain(e))
try:
    with Observe(), Observe(fail=KeyError("inner exit")):
        raise ValueError("two managers")
except KeyError as e:
    print("two managers", chain(e))
try:
    raise OSError("outer with")
except OSError:
    with Observe(suppress=True):
        raise ValueError("inside handler")
    state("handler after with")


# --- __context__ when raised
def raiser():
    raise KeyError("called")


try:
    raise ValueError("handled")
except ValueError:
    try:
        raiser()
    except KeyError as e:
        print("called from handler", chain(e))
    try:
        [][1]
    except IndexError as e:
        print("runtime error in handler", chain(e))
    try:
        raise TypeError("cause") from None
    except TypeError as e:
        print("from None", chain(e), e.__suppress_context__)

saved = None
try:
    raise KeyError("saved")
except KeyError as e:
    saved = e
try:
    raise ValueError("new handler")
except ValueError:
    try:
        raise saved
    except KeyError as e:
        print("reraised saved", chain(e))

# a cycle back to the raised exception is cut
try:
    try:
        raise ValueError("a")
    except ValueError as va:
        try:
            raise KeyError("b")
        except KeyError as kb:
            try:
                raise va
            except ValueError as again:
                print("cycle cut", chain(again), chain(kb))
except Exception:
    pass


def bare():
    raise


try:
    raise ValueError("for bare raise")
except ValueError:
    try:
        bare()
    except ValueError as e:
        print("bare raise in callee", repr(e))
try:
    bare()
except RuntimeError as e:
    print("bare raise outside", e)


# --- contextlib's exit stacks keep the whole chain
def fail(typ, message):
    raise typ(message)


try:
    with contextlib.ExitStack() as s:
        s.callback(fail, IndexError, "first registered")
        s.callback(fail, KeyError, "last registered")
        raise ValueError("body")
except BaseException as e:
    print("ExitStack body", chain(e))

try:
    with contextlib.ExitStack() as s:
        s.callback(fail, IndexError, "first registered")
        s.callback(fail, KeyError, "last registered")
except BaseException as e:
    print("ExitStack no body error", chain(e))

try:
    raise ValueError("original")
except ValueError:
    s = contextlib.ExitStack()
    s.callback(fail, RuntimeError, "first")
    s.callback(fail, RuntimeError, "second")
    try:
        s.__exit__(*sys.exc_info())
    except RuntimeError as e:
        print("ExitStack from handler", chain(e))
    s = contextlib.ExitStack()
    s.callback(fail, IndexError, "first")
    s.callback(fail, KeyError, "second")
    try:
        s.close()
    except IndexError as e:
        print("ExitStack.close in handler", chain(e))


def reset(typ, value, tb):
    print("suppressing", chain(value))
    return True


try:
    with contextlib.ExitStack() as s:
        s.callback(fail, IndexError, "after suppress")
        s.push(reset)
        s.callback(fail, KeyError, "before suppress")
        raise ValueError("body before suppress")
except BaseException as e:
    print("after suppression", chain(e))

with contextlib.ExitStack() as s:
    s.push(reset)
    s.callback(fail, KeyError, "suppressed callback")
print("suppressed callback done")

try:
    with contextlib.ExitStack() as s:
        s.callback(fail, IndexError, "outer cb")
        with contextlib.ExitStack() as t:
            t.callback(fail, KeyError, "inner cb")
            raise ValueError("nested stacks")
except BaseException as e:
    print("nested stacks", chain(e))

try:
    with contextlib.ExitStack() as s:
        s.enter_context(Observe(fail=KeyError("cm exit")))
        s.callback(fail, IndexError, "cb")
        raise ValueError("cm body")
except BaseException as e:
    print("enter_context", chain(e))


async def afail(typ, message):
    raise typ(message)


async def areset(typ, value, tb):
    print("async suppressing", chain(value))
    return True


async def amain():
    try:
        async with contextlib.AsyncExitStack() as s:
            s.push_async_callback(afail, IndexError, "first async")
            s.push_async_callback(afail, KeyError, "second async")
            s.callback(fail, TypeError, "sync")
            raise ValueError("async body")
    except BaseException as e:
        print("AsyncExitStack body", chain(e))
    try:
        raise ValueError("async original")
    except ValueError:
        s = contextlib.AsyncExitStack()
        s.push_async_callback(afail, RuntimeError, "first")
        s.push_async_callback(afail, RuntimeError, "second")
        try:
            await s.__aexit__(*sys.exc_info())
        except RuntimeError as e:
            print("AsyncExitStack from handler", chain(e))
    try:
        async with contextlib.AsyncExitStack() as s:
            s.push_async_callback(afail, IndexError, "after async suppress")
            s.push_async_exit(areset)
            s.push_async_callback(afail, KeyError, "before async suppress")
            raise ValueError("async body before suppress")
    except BaseException as e:
        print("async after suppression", chain(e))
    state("amain end")


m = amain()
try:
    m.send(None)
except StopIteration:
    state("amain done")
state("end")
