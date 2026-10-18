"""What a suite is: cases (fixed inputs, each in a tier) and engines.

An engine has a name, available() (False: "not installed"), version(),
run(case, repeat, timeout) -> Timing whose answer the suite's same() compares
across engines, and close(). The first engine is Sagebrush's."""

TIERS = ("quick", "standard", "large")


class EngineTimeout(Exception):
    """An engine overran the per-case timeout."""


class Case:
    """expected: an answer recorded elsewhere (results/), compared like an
    engine's, or None."""

    expected = None

    def __init__(self, label, params, tier):
        assert tier in TIERS, tier
        self.label, self.params, self.tier = label, params, tier


class Suite:
    name = title = claim = ""

    def cases(self):
        raise NotImplementedError

    def engines(self):
        raise NotImplementedError

    def same(self, a, b):
        return a == b
