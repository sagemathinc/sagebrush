# logging (CPython 3.14's own Lib/logging/__init__.py) and atexit, printed for comparison with CPython line for line
# (test/stdlib-logging.test.ts). Everything logged goes to stdout here, so the comparison sees it.
import io
import sys
sys.stderr = sys.stdout
import atexit
import logging

# the module's functions, before any configuration: the last-resort handler, WARNING and above, the message alone
logging.debug("not shown")
logging.info("not shown either")
logging.warning("a warning %s", "with an argument")
logging.error("an error %d%%", 42)
logging.critical("critical")
print(logging.getLevelName(logging.WARNING), logging.getLevelName(25), logging.getLevelName("ERROR"), logging.root.level)

# loggers: names, the hierarchy, levels, propagation
a = logging.getLogger("app")
ab = logging.getLogger("app.part")
print(ab.parent is a, a.parent is logging.root, logging.getLogger("app") is a, ab.name)
print(a.getEffectiveLevel(), ab.isEnabledFor(logging.INFO))
a.setLevel(logging.DEBUG)
print(ab.getEffectiveLevel(), ab.isEnabledFor(logging.DEBUG))

buf = io.StringIO()
h = logging.StreamHandler(buf)
h.setFormatter(logging.Formatter("%(name)s|%(levelname)s|%(message)s"))
a.addHandler(h)
ab.debug("from the child %s", [1, 2])
ab.info("again")
a.propagate = False
ab.warning("not to root")
print(repr(buf.getvalue()))

# formatter styles and fields
for fmt, style in (("{levelname}:{name}:{message}", "{"), ("$levelname/$message", "$"), ("%(levelno)d %(message)s", "%")):
    s = io.StringIO()
    hh = logging.StreamHandler(s)
    hh.setFormatter(logging.Formatter(fmt, style=style))
    lg = logging.getLogger("styles." + style)
    lg.propagate = False
    lg.addHandler(hh)
    lg.error("styled")
    print(repr(s.getvalue()))
f = logging.Formatter("%(asctime)s", datefmt="%Y")
print(len(f.format(logging.makeLogRecord({"msg": "x", "created": 0.0}))))
rec = logging.makeLogRecord({"name": "n", "levelno": 40, "levelname": "ERROR", "msg": "m %s", "args": ("a",)})
print(rec.getMessage(), rec.levelname, rec.name)

# filters, levels on handlers, adapters
s = io.StringIO()
hh = logging.StreamHandler(s)
hh.setLevel(logging.WARNING)
hh.addFilter(lambda r: "secret" not in r.getMessage())
lg = logging.getLogger("filtered")
lg.propagate = False
lg.setLevel(logging.DEBUG)
lg.addHandler(hh)
lg.info("below the handler's level")
lg.warning("a secret warning")
lg.warning("a plain warning")
ad = logging.LoggerAdapter(lg, {"user": "u1"})
ad.error("through the adapter")
print(repr(s.getvalue()))

class Only(logging.Filter):
    def filter(self, record):
        return record.levelno >= logging.ERROR
lg.addFilter(Only())
lg.warning("filtered at the logger")
lg.error("passes")
print(repr(s.getvalue().splitlines()[-1]))

# exc_info: the traceback after the message
s = io.StringIO()
hh = logging.StreamHandler(s)
lg = logging.getLogger("exc")
lg.propagate = False
lg.addHandler(hh)
def fails():
    raise ValueError("boom")
try:
    fails()
except ValueError:
    lg.error("Error while working: ", exc_info=True)
    lg.exception("the same, through exception()")
out = s.getvalue()
print(out.count("Traceback (most recent call last):"), out.count("ValueError: boom"), out.splitlines()[0])

# basicConfig, disable, levels by name, NullHandler
logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s %(message)s", stream=sys.stdout)
logging.info("configured")
logging.basicConfig(level=logging.DEBUG, format="%(message)s")
logging.debug("not reconfigured without force")
logging.basicConfig(level=logging.DEBUG, format="forced %(message)s", stream=sys.stdout, force=True)
logging.debug("reconfigured with force")
logging.disable(logging.WARNING)
logging.warning("disabled")
logging.error("above the disabled level")
logging.disable(logging.NOTSET)
logging.addLevelName(25, "NOTICE")
logging.log(25, "a custom level")
logging.getLogger("lib").addHandler(logging.NullHandler())
print(logging.getLevelName(25), logging.getLevelNamesMapping()["NOTICE"])
try:
    logging.getLogger("x").setLevel("NOPE")
except ValueError as e:
    print("ValueError", e)

# atexit: last registered first, after the program's last line; an unregistered function doesn't run
def at_end(word):
    print("at exit:", word)
atexit.register(at_end, "first")
atexit.register(at_end, "second")
def dropped():
    print("never")
atexit.register(dropped)
atexit.unregister(dropped)
print("end of the program", atexit._ncallbacks())
