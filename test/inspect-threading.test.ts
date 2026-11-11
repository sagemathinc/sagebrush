import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// inspect (lib/inspect.py, CPython 3.14's) and threading (lib/threading.py, for a single-threaded runtime): what
// CPython prints for test/inspect_cases.py and test/threading_cases.py, and the rows that are Sagebrush's own.
const TEST = __dirname + "/../../test/";
const cli = (args: string[]) => execFileSync(process.execPath, [__dirname + "/../src/cli.js", ...args], { encoding: "utf8" });
const py = (code: string) => execFileSync(process.execPath, [__dirname + "/../src/cli.js", "-c", code], { encoding: "utf8" });

test("inspect as CPython's: signature, Parameter, BoundArguments, getfullargspec, the predicates, getmembers, getdoc", () => {
  const want = execFileSync("python3", [TEST + "inspect_cases.py"], { encoding: "utf8" });
  assert.equal(cli([TEST + "inspect_cases.py"]), want);
});

test("threading as CPython's on one thread: locks, local, Event, Condition, Semaphore, Thread objects, main_thread", () => {
  const want = execFileSync("python3", [TEST + "threading_cases.py"], { encoding: "utf8" });
  assert.equal(cli([TEST + "threading_cases.py"]), want);
});

test("Sagebrush's own: a builtin's signature is a ValueError; a thread can't start; a wait only another thread could end is a RuntimeError", () => {
  assert.equal(py(`import inspect
try:
    inspect.signature(len)
except ValueError as e:
    print(e)`), "no signature found for builtin <built-in function len>\n");
  assert.equal(py(`import threading
for f in (lambda: threading.Thread(target=print).start(), lambda: threading.Event().wait(), lambda: threading.Semaphore(0).acquire()):
    try:
        f()
    except RuntimeError as e:
        print(e)`),
  "can't start new thread\n" +
  "Event.wait(): only one thread runs here, so nothing else could end the wait\n" +
  "Semaphore.acquire(): only one thread runs here, so nothing else could end the wait\n");
});
