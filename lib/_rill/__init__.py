"""Rill: an R-language mode (design/rill.md).

`run(src)` runs an R program as Rscript does: one top-level statement at a
time, printing each visible value; an error prints R's message on stderr and
stops with exit status 1, after the statements before it have run.
`run_cases(cases)` runs corpus cases, each in a fresh session (design §7.5).

The modules load on first use: lex and parse, values, eval and base, fmt,
mem.  A1.1 holds the core; later PRs add the rest (design §3).
"""

import sys

import _memguard

from . import mem
from .eval import NotSupported, RError, Session
from .parse import ParseError, Parser

# "Error in <call> : <message>" stays on one line up to this many characters (R 4.5.3,
# rill-tests/errfmt/test_1.R); longer, the message goes on the next line, indented
ERROR_LINE = 73
# "In <call> : <message>", a warning's line, the same up to this many (rill-tests/errfmt/test_2.R)
WARNING_LINE = 75


def _error_text(message, call):
    """R's wording of an error, without the final newline."""
    from . import fmt
    if call is None:
        return "Error: " + message
    head = "Error in %s : " % fmt.deparse_call_line(call)
    first = message.split("\n", 1)[0]
    if len(head) + len(first) > ERROR_LINE:
        return head + "\n  " + message
    return head + message


def _warning_lines(warnings):
    """R's report of a statement's warnings (A1.1: one warning; A1.4 the rest)."""
    from . import fmt
    if len(warnings) > 1:
        raise NotSupported("several warnings in one statement")
    call, message = warnings[0]
    if call is None:
        return "Warning message:\n%s \n" % message
    head = "In %s : " % fmt.deparse_call_line(call)
    if len(head) + len(message) > WARNING_LINE:
        return "Warning message:\n%s\n  %s\n" % (head.rstrip(), message)
    return "Warning message:\n%s%s\n" % (head, message)


def _not_supported(what):
    return "Error: Rill doesn't support %s yet" % what


def run(src, write_out=None, write_err=None):
    """Run R source as Rscript does; returns the exit status."""
    write_out = write_out or sys.stdout.write
    write_err = write_err or sys.stderr.write
    sess = Session(write_out, write_err)
    try:
        with mem.reserve(0, "character", extra_bytes=len(src) * mem.PARSE_BYTES_PER_CHAR):
            return _run(sess, src, write_err)
    except _memguard.SagebrushMemoryError as e:
        write_err(_memory_text(e) + "\n")
        return 1


def _run(sess, src, write_err):
    parser = Parser(src)
    while True:
        try:
            expr = parser.statement()
        except ParseError as e:
            write_err(_error_text(e.message, e.call) + "\n")
            return 1
        except NotSupported as e:
            write_err(_not_supported(e.what) + "\n")
            return 1
        if expr is None:
            return 0
        sess.warnings = [(None, w) for w in parser.warnings]
        try:
            value = sess.evaluate(expr)
            if sess.visible:
                from .base import print_value
                print_value(sess, value)
        except RError as e:
            write_err(_error_text(e.message, e.call) + "\n")
            return 1
        except NotSupported as e:
            write_err(_not_supported(e.what) + "\n")
            return 1
        except _memguard.SagebrushMemoryError as e:
            write_err(_memory_text(e) + "\n")
            return 1
        if sess.warnings:
            try:
                write_err(_warning_lines(sess.warnings))
            except NotSupported as e:
                write_err(_not_supported(e.what) + "\n")
                return 1


def _memory_text(e):
    """A memory guard's refusal: R's allocation error, then Sagebrush's sentence."""
    from . import mem
    r_bytes = getattr(e, "r_bytes", None)
    if r_bytes is None:
        return "Error: " + str(e)
    return "Error: cannot allocate vector of size %s\n%s" % (mem.r_size(r_bytes), str(e))


def run_cases(cases):
    """Run corpus cases [(id, source)], each in a fresh session; returns
    [{"id", "stdout", "stderr", "status"}] (test/rill-corpus-*.test.ts)."""
    results = []
    for cid, src in cases:
        out, err = [], []
        status = run(src, out.append, err.append)
        results.append({"id": cid, "stdout": "".join(out), "stderr": "".join(err), "status": status})
    return results
