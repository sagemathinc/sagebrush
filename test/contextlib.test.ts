import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// contextlib (lib/contextlib.py, CPython 3.14's, ported): what CPython prints
// for test/contextlib_cases.py, and the async parts and plt.rc_context
// that use it.
const TEST = __dirname + "/../../test/";
const cli = (args: string[]) => execFileSync(process.execPath, [__dirname + "/../src/cli.js", ...args], { encoding: "utf8" });

test("contextlib as CPython's: contextmanager, suppress, redirect_stdout/stderr, ExitStack, nullcontext, closing, ContextDecorator, chdir, the ABCs", () => {
  const want = execFileSync("python3", [TEST + "contextlib_cases.py"], { encoding: "utf8" });
  assert.equal(cli([TEST + "contextlib_cases.py"]), want);
});

test("contextlib's AsyncExitStack and aclosing; sys.exception() and sys.exc_info() inside except clauses", () => {
  const code = `
import contextlib, sys
class ACM:
    async def __aenter__(self):
        print("aenter")
        return 5
    async def __aexit__(self, *exc):
        print("aexit", exc[0])
        return False
class AR:
    async def aclose(self):
        print("aclosed")
async def main():
    async with contextlib.AsyncExitStack() as st:
        st.callback(print, "sync cb")
        async def acb():
            print("async cb")
        st.push_async_callback(acb)
        print("entered", await st.enter_async_context(ACM()))
    async with contextlib.aclosing(AR()):
        pass
coro = main()
try:
    coro.send(None)
except StopIteration:
    print("done")
print(sys.exception(), sys.exc_info())
try:
    raise ValueError("a")
except ValueError:
    print(repr(sys.exception()), sys.exc_info()[0].__name__)
    try:
        raise KeyError("b")
    except KeyError:
        print(repr(sys.exception()))
    print(repr(sys.exception()))
print(sys.exception())
`;
  const want = execFileSync("python3", ["-c", code], { encoding: "utf8" });
  assert.equal(cli(["-c", code]), want);
});
