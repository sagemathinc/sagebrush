"""A small unittest: TestCase with the common assertions, TestResult,
skips, expected failures, TestSuite, TestLoader and main()."""
import sys

__all__ = ["TestCase", "TestResult", "TestSuite", "TestLoader", "SkipTest",
           "skip", "skipIf", "skipUnless", "expectedFailure", "main"]


class SkipTest(Exception):
    pass


class _ExpectedFailure(Exception):
    pass


def skip(reason):
    def deco(f):
        f.__unittest_skip__ = True
        f.__unittest_skip_why__ = reason
        return f
    if isinstance(reason, type(skip)):
        f, reason = reason, ""
        return deco(f)
    return deco


def skipIf(cond, reason):
    return skip(reason) if cond else (lambda f: f)


def skipUnless(cond, reason):
    return skip(reason) if not cond else (lambda f: f)


def expectedFailure(f):
    f.__unittest_expecting_failure__ = True
    return f


class TestResult:
    def __init__(self):
        self.failures = []
        self.errors = []
        self.skipped = []
        self.expectedFailures = []
        self.unexpectedSuccesses = []
        self.testsRun = 0
        self.shouldStop = False

    def wasSuccessful(self):
        return not self.failures and not self.errors and not self.unexpectedSuccesses

    def startTest(self, test):
        self.testsRun += 1

    def stopTest(self, test):
        pass

    def addSuccess(self, test):
        pass

    def addError(self, test, err):
        self.errors.append((test, _fmt(err)))

    def addFailure(self, test, err):
        self.failures.append((test, _fmt(err)))

    def addSkip(self, test, reason):
        self.skipped.append((test, reason))

    def addExpectedFailure(self, test, err):
        self.expectedFailures.append((test, _fmt(err)))

    def addUnexpectedSuccess(self, test):
        self.unexpectedSuccesses.append(test)


def _fmt(e):
    return "%s: %s" % (type(e).__name__, e)


class _Raises:
    def __init__(self, case, exc, regex=None):
        self.case = case
        self.expected = exc
        self.regex = regex
        self.exception = None

    def __enter__(self):
        return self

    def __exit__(self, t, v, tb):
        if t is None:
            name = getattr(self.expected, "__name__", str(self.expected))
            raise self.case.failureException("%s not raised" % name)
        if not issubclass(t, self.expected):
            return False
        self.exception = v
        if self.regex is not None:
            import re
            if not re.search(self.regex, str(v)):
                raise self.case.failureException('"%s" does not match "%s"' % (self.regex, v))
        return True


class TestCase:
    failureException = AssertionError
    longMessage = True
    maxDiff = 80 * 8

    def __init__(self, methodName="runTest"):
        self._testMethodName = methodName
        self._cleanups = []

    def __repr__(self):
        return "<%s testMethod=%s>" % (type(self).__name__, self._testMethodName)

    def __str__(self):
        return "%s (%s)" % (self._testMethodName, type(self).__name__)

    def id(self):
        return "%s.%s" % (type(self).__name__, self._testMethodName)

    def setUp(self):
        pass

    def tearDown(self):
        pass

    @classmethod
    def setUpClass(cls):
        pass

    @classmethod
    def tearDownClass(cls):
        pass

    def addCleanup(self, f, *args, **kwargs):
        self._cleanups.append((f, args, kwargs))

    def doCleanups(self):
        while self._cleanups:
            f, a, k = self._cleanups.pop()
            f(*a, **k)

    def skipTest(self, reason):
        raise SkipTest(reason)

    def countTestCases(self):
        return 1

    def __call__(self, result=None):
        return self.run(result)

    def run(self, result=None):
        if result is None:
            result = TestResult()
        result.startTest(self)
        method = getattr(self, self._testMethodName)
        expecting = getattr(method, "__unittest_expecting_failure__", False)
        try:
            if getattr(method, "__unittest_skip__", False) or getattr(type(self), "__unittest_skip__", False):
                result.addSkip(self, getattr(method, "__unittest_skip_why__", ""))
                return result
            try:
                self.setUp()
            except SkipTest as e:
                result.addSkip(self, str(e))
                return result
            except Exception as e:
                result.addError(self, e)
                return result
            ok = False
            try:
                method()
                ok = True
            except SkipTest as e:
                result.addSkip(self, str(e))
            except self.failureException as e:
                if expecting:
                    result.addExpectedFailure(self, e)
                else:
                    result.addFailure(self, e)
            except Exception as e:
                if expecting:
                    result.addExpectedFailure(self, e)
                else:
                    result.addError(self, e)
            try:
                self.tearDown()
            except Exception as e:
                result.addError(self, e)
                ok = False
            try:
                self.doCleanups()
            except Exception as e:
                result.addError(self, e)
                ok = False
            if ok:
                if expecting:
                    result.addUnexpectedSuccess(self)
                else:
                    result.addSuccess(self)
        finally:
            result.stopTest(self)
        return result

    def debug(self):
        self.setUp()
        getattr(self, self._testMethodName)()
        self.tearDown()

    # --- assertions
    def _fail(self, default, msg):
        if msg is None:
            raise self.failureException(default)
        if self.longMessage:
            raise self.failureException("%s : %s" % (default, msg))
        raise self.failureException(msg)

    def fail(self, msg=None):
        raise self.failureException(msg)

    def assertEqual(self, first, second, msg=None):
        if not first == second:
            self._fail("%r != %r" % (first, second), msg)

    def assertNotEqual(self, first, second, msg=None):
        if not first != second:
            self._fail("%r == %r" % (first, second), msg)

    assertEquals = assertEqual
    assertNotEquals = assertNotEqual

    def assertTrue(self, x, msg=None):
        if not x:
            self._fail("%r is not true" % (x,), msg)

    def assertFalse(self, x, msg=None):
        if x:
            self._fail("%r is not false" % (x,), msg)

    def assertIs(self, a, b, msg=None):
        if a is not b:
            self._fail("%r is not %r" % (a, b), msg)

    def assertIsNot(self, a, b, msg=None):
        if a is b:
            self._fail("unexpectedly identical: %r" % (a,), msg)

    def assertIsNone(self, x, msg=None):
        if x is not None:
            self._fail("%r is not None" % (x,), msg)

    def assertIsNotNone(self, x, msg=None):
        if x is None:
            self._fail("unexpectedly None", msg)

    def assertIn(self, a, b, msg=None):
        if a not in b:
            self._fail("%r not found in %r" % (a, b), msg)

    def assertNotIn(self, a, b, msg=None):
        if a in b:
            self._fail("%r unexpectedly found in %r" % (a, b), msg)

    def assertIsInstance(self, obj, cls, msg=None):
        if not isinstance(obj, cls):
            self._fail("%r is not an instance of %r" % (obj, cls), msg)

    def assertNotIsInstance(self, obj, cls, msg=None):
        if isinstance(obj, cls):
            self._fail("%r is an instance of %r" % (obj, cls), msg)

    def assertLess(self, a, b, msg=None):
        if not a < b:
            self._fail("%r not less than %r" % (a, b), msg)

    def assertLessEqual(self, a, b, msg=None):
        if not a <= b:
            self._fail("%r not less than or equal to %r" % (a, b), msg)

    def assertGreater(self, a, b, msg=None):
        if not a > b:
            self._fail("%r not greater than %r" % (a, b), msg)

    def assertGreaterEqual(self, a, b, msg=None):
        if not a >= b:
            self._fail("%r not greater than or equal to %r" % (a, b), msg)

    def assertAlmostEqual(self, a, b, places=None, msg=None, delta=None):
        if a == b:
            return
        if delta is not None:
            if abs(a - b) <= delta:
                return
            self._fail("%r != %r within %r delta" % (a, b, delta), msg)
        if places is None:
            places = 7
        if round(abs(b - a), places) == 0:
            return
        self._fail("%r != %r within %r places" % (a, b, places), msg)

    def assertNotAlmostEqual(self, a, b, places=None, msg=None, delta=None):
        if delta is not None:
            if not (a == b) and abs(a - b) > delta:
                return
            self._fail("%r == %r within %r delta" % (a, b, delta), msg)
        if places is None:
            places = 7
        if not (a == b) and round(abs(b - a), places) != 0:
            return
        self._fail("%r == %r within %r places" % (a, b, places), msg)

    def assertCountEqual(self, a, b, msg=None):
        a, b = list(a), list(b)
        for x in a:
            if a.count(x) != b.count(x):
                self._fail("Element counts were not equal", msg)
        if len(a) != len(b):
            self._fail("Element counts were not equal", msg)

    def assertSequenceEqual(self, a, b, msg=None, seq_type=None):
        if list(a) != list(b):
            self._fail("Sequences differ: %r != %r" % (a, b), msg)

    def assertListEqual(self, a, b, msg=None):
        self.assertSequenceEqual(a, b, msg)

    def assertTupleEqual(self, a, b, msg=None):
        self.assertSequenceEqual(a, b, msg)

    def assertDictEqual(self, a, b, msg=None):
        self.assertEqual(a, b, msg)

    def assertSetEqual(self, a, b, msg=None):
        self.assertEqual(a, b, msg)

    def assertMultiLineEqual(self, a, b, msg=None):
        self.assertEqual(a, b, msg)

    def assertRegex(self, text, regex, msg=None):
        import re
        if not re.search(regex, text):
            self._fail("Regex didn't match: %r not found in %r" % (regex, text), msg)

    def assertNotRegex(self, text, regex, msg=None):
        import re
        if re.search(regex, text):
            self._fail("Regex matched: %r in %r" % (regex, text), msg)

    def assertRaises(self, exc, *args, **kwargs):
        ctx = _Raises(self, exc)
        if not args:
            kwargs.pop("msg", None)
            return ctx
        f, args = args[0], args[1:]
        with ctx:
            f(*args, **kwargs)

    def assertRaisesRegex(self, exc, regex, *args, **kwargs):
        ctx = _Raises(self, exc, regex)
        if not args:
            return ctx
        f, args = args[0], args[1:]
        with ctx:
            f(*args, **kwargs)

    failUnlessEqual = assertEqual
    failIfEqual = assertNotEqual
    failUnless = assertTrue
    failIf = assertFalse
    assert_ = assertTrue
    failUnlessRaises = assertRaises


class FunctionTestCase(TestCase):
    def __init__(self, f):
        TestCase.__init__(self, "runTest")
        self._f = f

    def runTest(self):
        self._f()


class TestSuite:
    def __init__(self, tests=()):
        self._tests = []
        self.addTests(tests)

    def __iter__(self):
        return iter(self._tests)

    def countTestCases(self):
        return sum(t.countTestCases() for t in self._tests)

    def addTest(self, t):
        self._tests.append(t)

    def addTests(self, ts):
        for t in ts:
            self.addTest(t)

    def run(self, result):
        for t in self._tests:
            if result.shouldStop:
                break
            t.run(result)
        return result

    def __call__(self, result):
        return self.run(result)


class TestLoader:
    testMethodPrefix = "test"

    def getTestCaseNames(self, cls):
        names = []
        for c in reversed(cls.__mro__):
            for k in c.__dict__:
                if k.startswith(self.testMethodPrefix) and callable(getattr(cls, k)) and k not in names:
                    names.append(k)
        return sorted(names)

    def loadTestsFromTestCase(self, cls):
        return TestSuite([cls(n) for n in self.getTestCaseNames(cls)])

    def loadTestsFromModule(self, module):
        tests = []
        for v in list(vars(module).values()):
            if isinstance(v, type) and issubclass(v, TestCase) and v is not TestCase:
                tests.append(self.loadTestsFromTestCase(v))
        return TestSuite(tests)


defaultTestLoader = TestLoader()


class TextTestRunner:
    def __init__(self, stream=None, descriptions=True, verbosity=1, **kw):
        self.verbosity = verbosity

    def run(self, test):
        result = TestResult()
        test.run(result)
        for t, err in result.errors:
            print("ERROR:", t, err, file=sys.stderr)
        for t, err in result.failures:
            print("FAIL:", t, err, file=sys.stderr)
        print("Ran %d test%s" % (result.testsRun, "" if result.testsRun == 1 else "s"), file=sys.stderr)
        print("OK" if result.wasSuccessful() else "FAILED", file=sys.stderr)
        return result


def main(module="__main__", exit=True, verbosity=1, **kw):
    if isinstance(module, str):
        module = sys.modules[module]
    result = TextTestRunner(verbosity=verbosity).run(defaultTestLoader.loadTestsFromModule(module))
    if exit:
        sys.exit(0 if result.wasSuccessful() else 1)
    return result
