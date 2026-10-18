#!/usr/bin/env python3
"""Aggregate a read-traffic proxy from local Codex transcripts, without contents.

Counts source-path mentions in read-like tool calls, not instrumented file opens.
Mixed shell calls and broad searches make this a ranking signal, not exact reads.
Only tracked source paths are emitted; no transcript text or identities are saved.
"""
import argparse
from collections import Counter, defaultdict
import json
from pathlib import Path
import re
import subprocess

PATH = re.compile(r"(?:engine|src|lib|packages|web)/[\w./-]+\.(?:rs|py|ts|tsx|js|mjs)\b")
READ = re.compile(r"\b(?:rg|sed|cat|head|tail|read_text|readFile|Read|Grep|Glob)\b")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sessions", type=Path, required=True)
    parser.add_argument("--repo", type=Path, required=True)
    parser.add_argument("--session-cwd", help="Only sessions originally opened in this project directory")
    parser.add_argument("--since", required=True, help="ISO UTC timestamp")
    parser.add_argument("--until", required=True, help="Exclusive ISO UTC cutoff")
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    tracked = set(subprocess.check_output(["git", "ls-files"], cwd=args.repo, text=True).splitlines())
    counts, sessions = Counter(), defaultdict(set)
    candidates = list(args.sessions.rglob("*.jsonl"))
    examined, earliest, latest = 0, None, None
    eligible_sessions = 0
    for file in candidates:
        if args.session_cwd:
            with file.open(errors="replace") as stream:
                metadata = json.loads(next(stream, "{}"))
            if metadata.get("type") != "session_meta" or metadata.get("payload", {}).get("cwd") != args.session_cwd:
                continue
        eligible_sessions += 1
        for line in file.open(errors="replace"):
            if '"function_call"' not in line and '"custom_tool_call"' not in line:
                continue
            record = json.loads(line)
            timestamp = record.get("timestamp", "")
            payload = record.get("payload", {})
            if not args.since <= timestamp < args.until or payload.get("type") not in ("function_call", "custom_tool_call"):
                continue
            arguments = payload.get("arguments", payload.get("input", ""))
            # Exclude this pilot and outgoing communications from the ranking.
            if any(term in arguments for term in ("readability", "agent send", "memory write", "artifact publish")):
                continue
            if not READ.search(arguments):
                continue
            found = set(PATH.findall(arguments)) & tracked
            if not found:
                continue
            examined += 1
            earliest = min(earliest or timestamp, timestamp)
            latest = max(latest or timestamp, timestamp)
            for path in found:
                counts[path] += 1
                sessions[path].add(str(file))
    rows = []
    for path, count in sorted(counts.items(), key=lambda item: (-item[1], item[0])):
        data = (args.repo / path).read_bytes()
        rows.append({"path": path, "read_like_calls": count,
                     "sessions": len(sessions[path]), "lines": len(data.splitlines()), "bytes": len(data)})
    result = {"method": __doc__, "since": args.since, "until": args.until, "earliest": earliest, "latest": latest,
              "transcripts_available": len(candidates), "transcripts_scanned": eligible_sessions,
              "session_cwd_filter": args.session_cwd,
              "size_revision": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=args.repo, text=True).strip(),
              "matching_calls": examined, "files": rows}
    args.out.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps({"matching_calls": examined, "top": rows[:15]}, indent=2))


if __name__ == "__main__":
    main()
