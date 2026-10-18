"""Regression checks for the lint's distinction between code and comments."""
import importlib.util
from pathlib import Path
import unittest

path = Path(__file__).resolve().parents[2] / "scripts/check-review-comments.py"
spec = importlib.util.spec_from_file_location("comment_lint", path)
lint = importlib.util.module_from_spec(spec)
spec.loader.exec_module(lint)


class CommentLintTests(unittest.TestCase):
    def flagged(self, text, suffix):
        return [n for n, line in lint.comment_lines(text, suffix).items() if lint.REVIEW.search(line)]

    def test_python_literal_and_inline_comment(self):
        self.assertEqual(self.flagged('x = "CORR-1"\nx = 1 # HARD-2\n', ".py"), [2])

    def test_docstring_and_assigned_string(self):
        self.assertEqual(self.flagged('"""LIMIT-3"""\nx = """HOLD"""\n', ".py"), [1])

    def test_rust_lifetime_raw_string_and_comments(self):
        text = 'fn f(x: &\'a str) {}\nlet x = r#"// HOLD"#;\n// CORR-4\n/*\n astra\n*/\n'
        self.assertEqual(self.flagged(text, ".rs"), [3, 5])

    def test_js_strings(self):
        self.assertEqual(self.flagged('let x = "// HOLD";\n/* HARD-5 */\n', ".ts"), [2])

    def test_normal_prose(self):
        self.assertEqual(self.flagged('// hold the lock while changing state\n// astronomical precision\n', ".rs"), [])

    def test_diff_only_new_lines(self):
        diff = '--- a/x.py\n+++ b/x.py\n@@ -2 +2,2 @@\n-old\n+new\n+next\n@@ -9 +10 @@\n-a\n+b\n'
        self.assertEqual(lint.added_lines(diff), {2, 3, 10})


if __name__ == "__main__":
    unittest.main()
