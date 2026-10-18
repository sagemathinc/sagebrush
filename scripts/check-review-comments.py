#!/usr/bin/env python3
"""Flag review-history identifiers in comment lines added since --base.

Checks the current tracked working tree (including staged edits). Markdown,
fixtures and ordinary string literals are excluded. Python docstrings count
as documentation comments. Give the PR/branch base explicitly in automation.
"""
import argparse
import ast
import io
from pathlib import Path
import re
import subprocess
import tokenize

REVIEW = re.compile(r"\b(?:CORR-|HARD-|LIMIT-|(?i:astra)\b|HOLD\b)")
SUFFIXES = {".py", ".rs", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".sh"}


def comment_lines(source, suffix):
    comments = {}
    if suffix == ".py":
        for token in tokenize.generate_tokens(io.StringIO(source).readline):
            if token.type == tokenize.COMMENT:
                comments[token.start[0]] = token.string
        tree = ast.parse(source)
        lines = source.splitlines()
        for node in ast.walk(tree):
            if isinstance(node, (ast.Module, ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and node.body:
                first = node.body[0]
                if isinstance(first, ast.Expr) and isinstance(first.value, ast.Constant) and isinstance(first.value.value, str):
                    for number in range(first.lineno, first.end_lineno + 1):
                        comments[number] = lines[number - 1]
        return comments
    if suffix == ".sh":
        return {i: line for i, line in enumerate(source.splitlines(), 1) if line.lstrip().startswith("#")}
    # Strings are consumed before searching for another comment. Rust lifetime
    # apostrophes are not character strings; raw strings have matched hashes.
    single = r"'(?:\\.|[^'\\\n])'" if suffix == ".rs" else r"'(?:\\.|[^'\\])*'"
    raw = r'r(?P<hashes>\#{0,16})"[\s\S]*?"(?P=hashes)' if suffix == ".rs" else r"(?!)"
    tokens = re.compile(raw + r'|"(?:\\.|[^"\\])*"|' + single + r"|`(?:\\.|[^`\\])*`|(?P<comment>//[^\n]*|/\*[\s\S]*?\*/)")
    for match in tokens.finditer(source):
        if match.group("comment") is not None:
            line = source.count("\n", 0, match.start()) + 1
            for offset, content in enumerate(match.group().splitlines()):
                comments[line + offset] = comments.get(line + offset, "") + content
    return comments


def added_lines(diff):
    number = 0
    added = set()
    for line in diff.splitlines():
        if line.startswith("@@"):
            number = int(re.search(r"\+(\d+)", line).group(1))
        elif line.startswith("+++") or line.startswith("---"):
            continue
        elif line.startswith("+"):
            added.add(number)
            number += 1
        elif not line.startswith(("-", "\\")):
            number += 1
    return added


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", required=True)
    args = parser.parse_args()
    root = Path(subprocess.check_output(["git", "rev-parse", "--show-toplevel"], text=True).strip())
    names = subprocess.check_output(["git", "diff", "--name-only", "-z", "--diff-filter=ACMR", args.base, "--"], cwd=root).decode().split("\0")
    findings = []
    for name in filter(None, names):
        path = root / name
        if path.suffix not in SUFFIXES:
            continue
        diff = subprocess.check_output(["git", "diff", "--no-ext-diff", "--no-color", "--unified=0", args.base, "--", name], cwd=root, text=True)
        try:
            comments = comment_lines(path.read_text(), path.suffix)
        except (SyntaxError, tokenize.TokenError, UnicodeError) as error:
            raise SystemExit(f"cannot inspect comments in {name}: {error}")
        for number in sorted(added_lines(diff)):
            text = comments.get(number, "")
            if REVIEW.search(text):
                findings.append(f"{name}:{number}: review history belongs in the commit message: {text.strip()}")
    print("\n".join(findings) if findings else "New comments contain no review-history identifiers.")
    raise SystemExit(bool(findings))


if __name__ == "__main__":
    main()
