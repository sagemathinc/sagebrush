#!/usr/bin/env python3
"""Recompute frozen-rubric coverage and usage summaries from graded answers."""
import argparse
import hashlib
import json
from pathlib import Path
from statistics import median

HERE = Path(__file__).resolve().parent


def input_tokens(record):
    usage = record["usage"]
    return sum(usage.get(key, 0) for key in (
        "input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"))


def summarize(records):
    metrics = {
        "seconds": [r["seconds"] for r in records],
        "tool_calls": [r["tool_count"] for r in records],
        "input_tokens": [input_tokens(r) for r in records],
        "output_tokens": [r["usage"]["output_tokens"] for r in records],
    }
    return {
        "runs": len(records),
        "covered_criteria": sum(sum(r["criteria"]) for r in records),
        "possible_criteria": sum(len(r["criteria"]) for r in records),
        "fully_covered_answers": sum(all(r["criteria"]) for r in records),
        **{key: {"median": median(values), "min": min(values),
                 "max": max(values), "total": sum(values)}
           for key, values in metrics.items()},
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--results", type=Path, default=HERE / "results")
    parser.add_argument("--key", type=Path, default=HERE / "questions.json")
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--markdown", type=Path, required=True)
    args = parser.parse_args()
    key = json.loads(args.key.read_text())
    key_hash = hashlib.sha256(args.key.read_bytes()).hexdigest()
    expected = {(q["id"], repetition) for q in key["questions"]
                for repetition in range(1, key["repetitions"] + 1)}
    summary = {"key_sha256": key_hash, "model": key["model"], "phases": {}}
    for phase in ("before", "after"):
        data = json.loads((args.results / (phase + ".json")).read_text())
        records = data["records"]
        pairs = [(r["id"], r["repetition"]) for r in records]
        if len(pairs) != len(expected) or set(pairs) != expected:
            raise ValueError(f"{phase}: missing, duplicate or unexpected runs")
        for r in records:
            if (r["key_sha256"] != key_hash or r["models"] != [key["model"]]
                    or r["timed_out"] or r["exit_code"] != 0 or r["is_error"]
                    or not r["answer"]):
                raise ValueError(f"{phase}: invalid run {r['id']}-{r['repetition']}")
            criterion_count = next(len(q["criteria"]) for q in key["questions"] if q["id"] == r["id"])
            if len(r["criteria"]) != criterion_count or any(type(c) is not int or c not in (0, 1) for c in r["criteria"]):
                raise ValueError(f"{phase}: invalid grading {r['id']}-{r['repetition']}")
        revisions = {r["sha"] for r in records}
        if len(revisions) != 1:
            raise ValueError(f"{phase}: mixed revisions")
        summary["phases"][phase] = {
            "sha": revisions.pop(), "grading": data["grading"],
            "all": summarize(records),
            "questions": {q["id"]: summarize([r for r in records if r["id"] == q["id"]])
                          for q in key["questions"]},
        }
    args.out.write_text(json.dumps(summary, indent=2) + "\n")
    text = ["# Frozen-rubric coverage and usage", "",
            "Each question has three criteria and three independent runs (nine possible points).",
            "A compound criterion needs all its claims; omissions receive zero, as do contradictions.",
            "This measures coverage, not the probability that an entire answer is factually correct.", "",
            "| Question | Before / 9 | After / 9 |", "| --- | ---: | ---: |"]
    for q in key["questions"]:
        scores = [summary["phases"][phase]["questions"][q["id"]]["covered_criteria"]
                  for phase in ("before", "after")]
        text.append(f"| {q['id']} | {scores[0]} | {scores[1]} |")
    text += ["", "Values below are median [minimum, maximum]. Input tokens include cache reads and",
             "cache creation on every model call, so they measure processed context, not unique text.",
             "Time is per CLI process; three processes ran concurrently. It is not pure inference time.", "",
             "| Question | Phase | Seconds | Tool calls | Input tokens | Output tokens |",
             "| --- | --- | ---: | ---: | ---: | ---: |"]
    for ident in ["all"] + [q["id"] for q in key["questions"]]:
        for phase in ("before", "after"):
            group = summary["phases"][phase]
            values = group["all"] if ident == "all" else group["questions"][ident]
            cells = []
            for metric in ("seconds", "tool_calls", "input_tokens", "output_tokens"):
                v = values[metric]
                fmt = ".1f" if metric == "seconds" else ",.0f"
                cells.append(f"{v['median']:{fmt}} [{v['min']:{fmt}}, {v['max']:{fmt}}]")
            text.append(f"| {ident} | {phase} | " + " | ".join(cells) + " |")
    args.markdown.write_text("\n".join(text) + "\n")
    print(json.dumps({phase: summary["phases"][phase]["all"] for phase in ("before", "after")}, indent=2))


if __name__ == "__main__":
    main()
