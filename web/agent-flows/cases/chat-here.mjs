// "Chat here" on my computer: the agent runs on one of the person's own computers (a child of `sagebrush remote
// --serve-agents`, reached through the relay); the notebook it makes opens and runs beside the chat, and the agent is
// still there for the next message ("now 50"). Only the computer surface has a computer.
import { hostname } from "node:os";

const primes = (n) => `primes = []
k = 2
while len(primes) < ${n}:
    if all(k % p for p in primes):
        primes.append(k)
    k += 1
print(primes)`;
const plot = (n) => `import matplotlib.pyplot as plt
plt.plot(range(1, ${n} + 1), primes, "o-")
plt.title("The first ${n} primes")
plt.show()`;
const notebook = (n) => ({ json: { cells: [{ code: primes(n) }, { code: plot(n) }] } });

export default {
  id: "chat-here",
  prompt: "make a Python notebook that computes the first 20 primes and plots them, and run it",
  surfaces: ["computer"],
  ms: 240_000, // (enrolling the computer and starting its runner come first; two notebooks, two turns)
  // (decided Nov 19 2026: a notebook the agent creates runs once by itself under Everything and May run code)
  gaps: { computer: "the Agents page's pane shows the agent's notebook but doesn't run it by itself yet" },
  agent: [
    { tool: "workspace_create", args: { path: "/primes.ipynb", mode: "python", content: notebook(20) } },
  ],
  async expect(h) {
    // where the agent is: the page names the computer, and the agent's words come from it (this machine, in the test)
    h.ok(await h.until(`/ on lab-box/.test(document.querySelector('#who').textContent)`, 5000), "the header names the computer", await h.ev(`document.querySelector('#who').textContent`));
    h.ok(await h.until(`document.body.innerText.includes(${JSON.stringify("Working on " + hostname() + ".")})`, 15000), "the agent's reply comes from that computer (its name)");
    await h.shown("/primes.ipynb");
    await h.ran("/primes.ipynb", { images: 1, errors: 0, text: /\[2, 3, 5, 7, 11, .*, 71\]/ });
    await h.shot("first-20");
    // "now 50": the same agent, a second turn
    const more = await h.tool("workspace_create", { path: "/primes-50.ipynb", mode: "python", content: notebook(50) });
    h.ok(!more.isError, "the follow-up's notebook is made by the same agent", more.text.slice(0, 200));
    await h.shown("/primes-50.ipynb");
    await h.ran("/primes-50.ipynb", { images: 1, errors: 0, text: /, 229\]/ });
    await h.agentStillThere();
  },
};
