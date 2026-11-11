"""Sprig: a bracket-notation symbolic mode (design/sprig-mvp.md).

`run(src)` runs a program one top-level statement at a time, printing each
value that isn't Null (as InputForm text until S1.3's output form); Print
writes to stdout and messages to stderr.  A syntax error stops the program
with exit status 1, after the statements before it have run.
`run_cases(cases)` runs corpus cases, each in a fresh session, as the
oracle's recorder does: the case's statements in order, its result the last
one's (test/sprig-corpus-*.test.ts).

S1.1 holds the core: the parser, the evaluator's stack, arithmetic and the
printers.  The mode is hidden until S1.4 (`--sprig -c` only).
"""

import sys

import _memguard

from . import base, mem, parse
from .eval import Session, SprigAbort
from .expr import NULL, FAILED, Sym, size_of
from .fmt import full_form, input_form
from .parse import NotYetSyntax, Parser, SprigSyntaxError

ABORTED = Sym("$Aborted")
# (Sprig's own names, its builtins', attributes', constants' and messages', are interned while it loads, in the shared
# table; from here on a new name goes in its session's own table, charged to it, Sym's docstring)
# (and the heads Sprig itself writes: the parser's operators, the atoms' types, and the forms its builtins return)
SYSTEM_NAMES = ("Integer", "Rational", "Real", "String", "Symbol", "Blank", "BlankSequence", "BlankNullSequence",
                "Pattern", "Optional", "Slot", "SlotSequence", "Out", "Not", "PreIncrement", "PreDecrement", "Increment",
                "Decrement", "Function", "Factorial", "Unset", "Derivative", "Part", "CompoundExpression", "Inequality",
                "Condition", "Alternatives", "PatternTest", "Rule", "RuleDelayed", "ReplaceAll", "ReplaceRepeated", "Map",
                "Apply", "Span", "AddTo", "SubtractFrom", "TimesBy", "DivideBy", "UpSet", "UpSetDelayed", "Dot",
                "StringJoin", "DirectedInfinity", "ComplexInfinity", "Indeterminate", "Sequence", "General", "Syntax",
                "Thread", "Infinity", "$Aborted", "$Failed", "Hold", "HoldForm", "FullForm", "InputForm", "List")
for _name in set(base.BUILTINS) | set(base.ATTRIBUTES) | base.PROTECTED_SYMBOLS | {n for n, _ in base.MESSAGES} | \
        set(SYSTEM_NAMES) | set(parse.FLAT.values()) | set(parse.SIMPLE.values()) | set(parse.RELATIONS.values()):
    Sym(_name)
Sym._frozen = True


def _memory_message(sess, e):
    """General::memory (design §5.6): the function's name, and Sagebrush's figures and routes."""
    lines = str(e).split("\n")
    detail = lines[1].rstrip(".") if len(lines) > 1 else str(e)
    # (one sentence: "Range needs more memory than this session allows: a list of ... needs about ...")
    detail = detail[:1].lower() + detail[1:]
    name = e.sprig_name if isinstance(e, mem.SprigMemoryError) else "Evaluation"
    sess.message(name, "memory", name, detail)
    for line in lines[2:]:
        sess.write_err(line + "\n")


def _formatted(value, how):
    with mem.reserve(size_of(value) * mem.FORMAT_BYTES_PER_NODE,
                     "Formatting an expression", "Print"):
        return how(value)


def _statements(sess, src, where, each):
    """Parse and evaluate src's statements, calling each(value) after each; True when it parsed to the end."""
    with mem.reserve(len(src) * mem.PARSE_BYTES_PER_CHAR, "Parsing " + mem.count(len(src), "character"), "Sprig"):
        parser = Parser(src)
        while True:
            try:
                stmt = parser.statement()
            except SprigSyntaxError as err:
                from .base import syntax_message
                syntax_message(sess, err, src, where)
                return False
            except NotYetSyntax as err:
                sess.message("General", "notyet", err.what)
                return False
            if stmt is None:
                return True
            try:
                value = sess.evaluate(stmt)
            except _memguard.SagebrushMemoryError as err:
                _memory_message(sess, err)
                value = ABORTED
            except SprigAbort:
                # (a language limit passed: its message said why)
                value = ABORTED
            each(value)


def _stdout(text):
    # (each line as it is printed, so Print's output appears while a long evaluation runs)
    sys.stdout.write(text)
    sys.stdout.flush()


def _stderr(text):
    sys.stderr.write(text)
    sys.stderr.flush()


def run(src, write_out=None, write_err=None):
    """Run Sprig source; returns the exit status."""
    write_out = write_out or _stdout
    write_err = write_err or _stderr
    sess = Session(write_out, write_err)
    prev = sess.activate()

    def show(value):
        if value is not NULL:
            try:
                write_out(_formatted(value, input_form) + "\n")
            except _memguard.SagebrushMemoryError as err:
                _memory_message(sess, err)

    try:
        return 0 if _statements(sess, src, "<string>", show) else 1
    except _memguard.SagebrushMemoryError as err:
        _memory_message(sess, err)
        return 1
    finally:
        sess.close()
        Session.restore(prev)


def run_cases(cases):
    """Run corpus cases [(id, source)], each in a fresh session; returns [{"id", "result", "fullform", "output",
    "messages"}], the recorder's fields: the result's InputForm and FullForm, everything printed (Print's lines
    and messages, in order), and the messages."""
    results = []
    for cid, src in cases:
        out = []
        sess = Session(out.append, out.append)
        prev = sess.activate()
        last = [NULL]

        def keep(value):
            last[0] = value

        try:
            if not _statements(sess, src, "<string>", keep):
                last[0] = FAILED
            value = last[0]
            result, full = _formatted(value, input_form), _formatted(value, full_form)
        except _memguard.SagebrushMemoryError as err:
            _memory_message(sess, err)
            result, full = "$Aborted", "$Aborted"
        finally:
            sess.close()
            Session.restore(prev)
        results.append({"id": cid, "result": result, "fullform": full, "output": "".join(out),
                        "messages": list(sess.messages)})
    return results
