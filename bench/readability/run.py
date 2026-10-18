#!/usr/bin/env python3
"""Cold Claude comprehension runs; adapted from /scratch/sagebrush-eval/run-l1.py.

Only subscription CLI calls and source reads run here. Builds/corpora belong on VMs.
The frozen key is read by this driver, never included in the agent's directory.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time

HERE = Path(__file__).resolve().parent
PROMPT = """Read the source code in ./source to answer this newcomer question.
Use only these source files, with Read, Glob and Grep. Do not use prior knowledge
as evidence, the web, external files, or other agents. Do not modify files.
Give a concise answer with source paths and function names. State uncertainty
where the source does not establish an answer. This is a comprehension task,
not a request to improve or change the implementation.

Question: {question}
"""


def snapshot(repo, sha, paths, destination):
    """Read-only projection of the exact tree, with no git/history/key/reviews."""
    names = subprocess.check_output(
        ["git", "ls-tree", "-r", "--name-only", sha, "--", *paths], cwd=repo,
        text=True).splitlines()
    manifest = {}
    for name in names:
        if not name.endswith((".rs", ".py", ".ts", ".tsx")):
            continue
        data = subprocess.check_output(["git", "show", f"{sha}:{name}"], cwd=repo)
        target = destination / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        target.chmod(0o444)
        manifest[name] = hashlib.sha256(data).hexdigest()
    for directory, _, _ in os.walk(destination, topdown=False):
        Path(directory).chmod(0o555)
    return manifest


def parse_transcript(path):
    tools, result, model_ids, seen = [], {}, set(), set()
    for line in path.read_text(errors="replace").splitlines():
        try:
            event = json.loads(line)
        except ValueError:
            continue
        if event.get("type") == "result":
            result = event
        message = event.get("message") or {}
        if message.get("model"):
            model_ids.add(message["model"])
        for block in message.get("content", []):
            if isinstance(block, dict) and block.get("type") == "tool_use" and block.get("id") not in seen:
                seen.add(block.get("id"))
                tools.append({"name": block.get("name"), "input": block.get("input")})
    return {"answer": result.get("result"), "usage": result.get("usage", {}),
            "model_usage": result.get("modelUsage", {}), "models": sorted(model_ids),
            "tool_calls": tools, "tool_count": len(tools),
            "is_error": result.get("is_error", True), "result_subtype": result.get("subtype")}


def run_one(question, repetition, args, key, sha):
    ident = f"{question['id']}-{repetition}"
    record_path = args.out / f"{ident}.json"
    if record_path.exists():
        raise RuntimeError(f"refusing to overwrite measured run {record_path}")
    directory = Path(tempfile.mkdtemp(prefix=f"readability-{ident}-", dir=args.work))
    manifest = snapshot(args.repo, sha, key["source_paths"], directory / "source")
    prompt = PROMPT.format(question=question["question"])
    command = [args.claude, "-p", prompt, "--model", key["model"],
               "--output-format", "stream-json", "--verbose",
               "--permission-mode", "bypassPermissions", "--safe-mode",
               "--no-session-persistence", "--strict-mcp-config",
               "--mcp-config", '{"mcpServers":{}}', "--tools", "Read,Glob,Grep",
               "--disable-slash-commands"]
    transcript = args.out / f"{ident}.jsonl"
    stderr = args.out / f"{ident}.stderr"
    start = time.monotonic()
    timed_out = False
    try:
        with transcript.open("w") as stdout, stderr.open("w") as err:
            try:
                process = subprocess.run(command, cwd=directory, stdout=stdout,
                                         stderr=err, timeout=args.timeout)
                exit_code = process.returncode
            except subprocess.TimeoutExpired:
                timed_out, exit_code = True, None
        record = {"id": question["id"], "repetition": repetition, "sha": sha,
                  "key_sha256": hashlib.sha256(args.key.read_bytes()).hexdigest(),
                  "seconds": round(time.monotonic() - start, 3),
                  "timed_out": timed_out, "exit_code": exit_code,
                  "manifest": manifest, **parse_transcript(transcript)}
        record_path.write_text(json.dumps(record, indent=2) + "\n")
        print(json.dumps({k:record[k] for k in ("id", "repetition", "seconds", "tool_count", "exit_code", "is_error")}), flush=True)
        return record
    finally:
        for root, _, _ in os.walk(directory):
            Path(root).chmod(0o755)
        shutil.rmtree(directory)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, default=HERE.parent.parent)
    parser.add_argument("--sha", required=True)
    parser.add_argument("--key", type=Path, default=HERE / "questions.json")
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--work", type=Path, required=True)
    parser.add_argument("--claude", default="claude")
    parser.add_argument("--jobs", type=int, default=3)
    parser.add_argument("--timeout", type=int, default=600)
    parser.add_argument("--id", action="append", help="diagnostic subset; final measurement uses all questions")
    args = parser.parse_args()
    args.repo, args.out, args.work = (p.resolve() for p in (args.repo, args.out, args.work))
    args.out.mkdir(parents=True, exist_ok=True)
    args.work.mkdir(parents=True, exist_ok=True)
    sha = subprocess.check_output(["git", "rev-parse", args.sha + "^{commit}"], cwd=args.repo, text=True).strip()
    key = json.loads(args.key.read_text())
    questions = [q for q in key["questions"] if not args.id or q["id"] in args.id]
    # Run each repetition as a separate process/directory; no resumed sessions.
    with ThreadPoolExecutor(max_workers=args.jobs) as executor:
        futures = [executor.submit(run_one, q, rep, args, key, sha)
                   for rep in range(1, key["repetitions"] + 1) for q in questions]
        records = [future.result() for future in as_completed(futures)]
    records.sort(key=lambda r: (r["id"], r["repetition"]))
    (args.out / "results.json").write_text(json.dumps(records, indent=2) + "\n")


if __name__ == "__main__":
    main()
