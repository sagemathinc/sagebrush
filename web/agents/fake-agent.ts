// A scripted stand-in for Claude, for the preview: it produces the same turn
// events a real agent's turn would (streamed text, thinking, tool calls with
// live output, an approval, diffs and artifacts), on a timer, with nothing
// sent anywhere. Each prompt picks a scenario by its words.

import type { TurnEvent } from "./events";

// An event without the stream's own fields, which the page assigns.
export type Draft = TurnEvent extends infer E ? (E extends unknown ? Omit<E, "seq" | "turn_id"> : never) : never;

export interface FakeTurn {
  // stops the turn at its next step; it finishes as interrupted
  interrupt(): void;
  // answers an open approval
  answer(id: string, approve: boolean): void;
  done: Promise<void>;
}

class Interrupted extends Error {}

export function startFakeTurn(prompt: string, emit: (d: Draft) => void, speed = 1): FakeTurn {
  let stopped = false;
  const waiting = new Map<string, (approve: boolean) => void>();
  const sleep = (ms: number) =>
    new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => (stopped ? reject(new Interrupted()) : resolve()), ms / speed);
      if (stopped) {
        clearTimeout(t);
        reject(new Interrupted());
      }
    });
  const step = () => {
    if (stopped) throw new Interrupted();
  };
  let messages = 0;
  let calls = 0;
  const say = async (text: string) => {
    const id = `m${messages++}`;
    emit({ type: "message_revised", message: id, revision: 1 });
    for (const piece of chunks(text)) {
      await sleep(18 + Math.random() * 30);
      emit({ type: "text_delta", message: id, revision: 1, text: piece });
    }
  };
  const think = async (text: string) => {
    for (const piece of chunks(text)) {
      await sleep(10 + Math.random() * 15);
      emit({ type: "thinking_delta", text: piece });
    }
  };
  const tool = async (
    tool: string,
    name: string,
    summary: string,
    work: (call: string) => Promise<{ status: string; summary?: string; diff?: { path: string; before: string; after: string } }>,
  ) => {
    const call = `t${calls++}`;
    const started = Date.now();
    emit({ type: "tool_call_started", call, tool, name, summary });
    const r = await work(call);
    emit({ type: "tool_call_finished", call, status: r.status, summary: r.summary, duration_ms: Date.now() - started, diff: r.diff });
  };
  const output = async (call: string, lines: string[], ms = 120) => {
    for (const line of lines) {
      await sleep(ms * (0.5 + Math.random()));
      emit({ type: "tool_output", call, text: line + "\n" });
    }
  };
  const approval = (id: string, title: string, summary: string) =>
    new Promise<boolean>((resolve, reject) => {
      step();
      emit({ type: "attention", id, kind: "approval", state: "open", title, summary });
      waiting.set(id, (approve) => {
        waiting.delete(id);
        emit({ type: "attention", id, kind: "approval", state: approve ? "approved" : "denied", title, summary });
        if (stopped) reject(new Interrupted());
        else resolve(approve);
      });
    });

  const done = (async () => {
    emit({ type: "turn_started" });
    try {
      await scenarioFor(prompt)({ say, think, tool, output, approval, sleep, emit, prompt });
      emit({ type: "turn_usage", usage: { input_tokens: 1800 + prompt.length * 3, output_tokens: 600 + messages * 140 } });
      emit({ type: "turn_finished", outcome: "completed" });
    } catch (err) {
      if (err instanceof Interrupted) emit({ type: "turn_finished", outcome: "interrupted" });
      else {
        emit({ type: "turn_error", code: "demo_error", message: String(err) });
        emit({ type: "turn_finished", outcome: "error", code: "demo_error" });
      }
    }
  })();

  return {
    interrupt() {
      stopped = true;
      for (const resolve of [...waiting.values()]) resolve(false);
    },
    answer(id, approve) {
      waiting.get(id)?.(approve);
    },
    done,
  };
}

// Text in the small pieces a streaming model sends: a word or two at a time.
function chunks(text: string): string[] {
  return text.match(/\S+\s*|\s+/g) ?? [];
}

interface Kit {
  say(text: string): Promise<void>;
  think(text: string): Promise<void>;
  tool(
    tool: string,
    name: string,
    summary: string,
    work: (call: string) => Promise<{ status: string; summary?: string; diff?: { path: string; before: string; after: string } }>,
  ): Promise<void>;
  output(call: string, lines: string[], ms?: number): Promise<void>;
  approval(id: string, title: string, summary: string): Promise<boolean>;
  sleep(ms: number): Promise<void>;
  emit(d: Draft): void;
  prompt: string;
}

function scenarioFor(prompt: string): (k: Kit) => Promise<void> {
  const p = prompt.toLowerCase();
  if (/\b(fix|test|bug|fail|error)/.test(p)) return fixTests;
  if (/\b(plot|graph|chart|visuali[sz]e)/.test(p)) return plot;
  if (/\b(write|report|doc|explain|summar|notes?)\b/.test(p)) return writeDoc;
  return chat;
}

const STATS_BEFORE = `def mean(xs):
    return sum(xs) / len(xs)


def variance(xs):
    m = mean(xs)
    return sum((x - m) ** 2 for x in xs) / len(xs)
`;

const STATS_AFTER = `def mean(xs):
    if not xs:
        raise ValueError("mean() of an empty list")
    return sum(xs) / len(xs)


def variance(xs, ddof=1):
    """Sample variance (ddof=1) by default, like numpy.var(..., ddof=1)."""
    m = mean(xs)
    return sum((x - m) ** 2 for x in xs) / (len(xs) - ddof)
`;

async function fixTests(k: Kit) {
  await k.think(
    "The person wants failing tests fixed. Start by running the test suite to see what fails, then read the code under test before changing anything.",
  );
  await k.say("I'll run the tests first to see what's failing.");
  await k.tool("terminal", "pytest", "pytest -q", async (call) => {
    await k.output(call, [
      "============================= test session starts ==============================",
      "collected 7 items",
      "",
      "tests/test_stats.py ....FF.                                              [100%]",
      "",
      "=================================== FAILURES ===================================",
      "_______________________________ test_variance _________________________________",
      "    assert variance([2, 4, 4, 4, 5, 5, 7, 9]) == pytest.approx(4.571428)",
      "E   assert 4.0 == 4.571428 ± 4.6e-06",
      "_____________________________ test_mean_empty ________________________________",
      "E   ZeroDivisionError: division by zero",
      "=========================== 2 failed, 5 passed in 0.08s ========================",
    ]);
    return { status: "error", summary: "exit 1" };
  });
  await k.tool("file", "read", "src/stats.py", async () => {
    await k.sleep(400);
    return { status: "ok", summary: "8 lines" };
  });
  await k.say(
    "Two problems in `src/stats.py`:\n\n" +
      "1. `variance` divides by $n$, but the test expects the **sample** variance, which divides by $n - 1$:\n\n" +
      "$$s^2 = \\frac{1}{n-1}\\sum_{i=1}^{n} (x_i - \\bar x)^2$$\n\n" +
      "2. `mean([])` raises `ZeroDivisionError`; the test expects a `ValueError` with a clear message.\n\n" +
      "I'd like to edit the file to fix both.",
  );
  const ok = await k.approval("edit-stats", "Edit src/stats.py", "Make variance() the sample variance (ddof=1) and raise ValueError for an empty list.");
  if (!ok) {
    await k.say("Okay, I won't change the file. The fix above is all you need if you'd like to make it yourself.");
    return;
  }
  await k.tool("edit", "edit", "src/stats.py", async () => {
    await k.sleep(600);
    return { status: "ok", summary: "+4 −2", diff: { path: "src/stats.py", before: STATS_BEFORE, after: STATS_AFTER } };
  });
  k.emit({ type: "artifact", id: "stats-diff", kind: "diff", title: "src/stats.py", body: JSON.stringify({ before: STATS_BEFORE, after: STATS_AFTER }) });
  await k.tool("terminal", "pytest", "pytest -q", async (call) => {
    await k.output(call, [
      "============================= test session starts ==============================",
      "collected 7 items",
      "",
      "tests/test_stats.py .......                                              [100%]",
      "",
      "============================== 7 passed in 0.05s ===============================",
    ]);
    return { status: "ok", summary: "exit 0" };
  });
  await k.say(
    "All 7 tests pass now. Summary of the change:\n\n" +
      "| Function | Before | After |\n|---|---|---|\n" +
      "| `mean([])` | `ZeroDivisionError` | `ValueError(\"mean() of an empty list\")` |\n" +
      "| `variance(xs)` | divides by $n$ | divides by $n - 1$ (`ddof=1`, overridable) |\n\n" +
      "The diff is open on the right.",
  );
}

const PLOT_CODE = `import numpy as np
import matplotlib.pyplot as plt

x = np.linspace(0, 4 * np.pi, 400)
fig, ax = plt.subplots(figsize=(7, 3.5))
for k in (1, 2, 3):
    ax.plot(x, np.sin(k * x) / k, label=f"sin({k}x)/{k}")
ax.plot(x, sum(np.sin(k * x) / k for k in (1, 2, 3)), "k", lw=2, label="sum")
ax.set_xlabel("x")
ax.legend(loc="upper right")
ax.set_title("Partial sums of a Fourier series")
plt.tight_layout()
plt.show()
`;

async function plot(k: Kit) {
  await k.think("A plot request. Write a short matplotlib script, show it as an artifact, and explain the math briefly.");
  await k.say("Here's a script that plots the first partial sums of the Fourier series of a sawtooth wave,");
  await k.say(
    "$$f(x) = \\sum_{k=1}^{\\infty} \\frac{\\sin kx}{k} = \\frac{\\pi - x}{2}, \\quad 0 < x < 2\\pi.$$\n\n" +
      "I put the code in an artifact so you can copy or open it full screen.",
  );
  await k.tool("file", "write", "plot_fourier.py", async () => {
    await k.sleep(500);
    return { status: "ok", summary: "14 lines" };
  });
  k.emit({ type: "artifact", id: "plot-code", kind: "code", lang: "python", title: "plot_fourier.py", body: PLOT_CODE });
  await k.say("Each extra term sharpens the corners; near the jumps you'll see the Gibbs overshoot of about 9%, which never goes away.");
}

const DOC = `# Notes: eigenvalues of a 2×2 matrix

For $A = \\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}$ the eigenvalues solve the characteristic equation

$$\\lambda^2 - (a + d)\\,\\lambda + (ad - bc) = 0,$$

so with $\\tau = \\operatorname{tr} A$ and $\\delta = \\det A$:

$$\\lambda_{1,2} = \\frac{\\tau \\pm \\sqrt{\\tau^2 - 4\\delta}}{2}.$$

## Cases

| Discriminant $\\tau^2 - 4\\delta$ | Eigenvalues | Picture (for $\\dot x = Ax$) |
|---|---|---|
| $> 0$ | two real | node or saddle |
| $= 0$ | one repeated | degenerate node |
| $< 0$ | complex pair | spiral (or center if $\\tau = 0$) |

## Example

$A = \\begin{pmatrix} 2 & 1 \\\\ 1 & 2 \\end{pmatrix}$: $\\tau = 4$, $\\delta = 3$, so $\\lambda = 1, 3$, with eigenvectors $(1, -1)$ and $(1, 1)$.

## Checks

- $\\lambda_1 + \\lambda_2 = \\tau$ and $\\lambda_1 \\lambda_2 = \\delta$.
- A symmetric matrix always has real eigenvalues.
`;

async function writeDoc(k: Kit) {
  await k.think("The person wants a written document. Draft it as a Markdown artifact with math, a table and an example; keep the chat reply short.");
  await k.say("I'll draft that as a document.");
  await k.tool("file", "write", "notes/eigenvalues-2x2.md", async () => {
    await k.sleep(700);
    return { status: "ok", summary: "34 lines" };
  });
  k.emit({ type: "artifact", id: "doc-eig", kind: "markdown", title: "eigenvalues-2x2.md", body: DOC });
  await k.say(
    "The draft is open on the right: the characteristic equation, the closed form for the eigenvalues, a table of cases, and a worked example. " +
      "Tell me what to change, or open it full screen to read it.",
  );
}

async function chat(k: Kit) {
  await k.think(`Answer directly: "${k.prompt.slice(0, 120)}". No tools needed.`);
  await k.say(
    "This preview runs a **scripted** stand-in for Claude, so my answers are canned, but everything you see is the real UI: " +
      "streamed text, thinking, tool calls with live output, approvals, and artifacts on the right.\n\n" +
      "Try one of these to see more:\n\n" +
      "- *fix the failing tests*: runs a test suite, asks to edit a file, shows the diff\n" +
      "- *plot a Fourier series*: writes a script into an artifact\n" +
      "- *write notes on eigenvalues*: drafts a Markdown document with math\n\n" +
      "Keys: **Shift+Enter** sends, **Alt+Enter** queues a message for after the current turn, **Ctrl+Enter** posts a note without sending it, " +
      "and **Enter** is a new line.",
  );
}
