# Sagebrush: one page

## What Sagebrush is

Sagebrush is open mathematics software that runs wherever you are: in a browser tab, in an app on your computer or phone, or inside an AI agent's tools. It comes as three products.

### Sagebrush Space: [sagebrush.space](https://sagebrush.space)
Open the page and start computing. There is nothing to install and no sign-in, and it works on a laptop, a tablet or a phone. Notebooks, LaTeX documents and boards open in well under a second, so each document gets the whole window. To work on another one, close this one or open another window.

### Sagebrush app: Mac, Windows, Linux, iPhone, Android
Everything Sagebrush Space does, and more:
- **Faster.** Native engines with real threads, not WebAssembly. They arrive engine by engine; today the app runs the same engines as the web.
- **Your files are real files,** in a folder on your disk, with their history kept beside them. There are no browser storage limits.
- **Agents connect directly.** An agent on your computer pairs with the app at once, with nothing going through a website.

The documents and files work the same way as in Sagebrush Space, so you can move between the two without converting anything.

### Sagebrush engine: the mathematics
This is the part nobody else has. It is a math-focused reimplementation of Python, Sage, Magma, MATLAB and LaTeX, each one a practical approximation: what working mathematicians, teachers and students actually use, with exact arithmetic and precise errors where something isn't there yet. Each piece is checked against the real system (real Sage, real Magma, real Octave), and the [articles](https://sagebrush.space/articles/) explain how each algorithm works. Writing software like this only became possible once AI got good enough to help write it. The engine is open source (MIT/Apache) and also ships on its own:
- `pip install sagebrush`;
- the `sagebrush` command line;
- `uvx sagebrush-mcp`, which gives any agent the engine and your documents as tools.

## Built for agents as much as for people

Everything a person can do, an agent can do too, through the same commands. An agent can open documents, run code, render a page and check the result. Anything serious, such as deleting protected files or turning off protection, still needs a person to approve it explicitly, and an agent can't get around that.

See [sagebrush.space/agents](https://sagebrush.space/agents).

## What the interface aims for

One document at a time, in one small, uniform frame. We keep polishing it toward four goals:
1. **Immediacy:** you can do something useful in the first second.
2. **Speed:** opening, running and switching documents are never the slow part.
3. **Minimalism:** nothing on screen that the document doesn't need.
4. **Usability with agents:** everything visible, checkable and safe for a human and an agent working together.

## Safe by default

- Every document keeps a bounded TimeTravel history.
- Deleted files go to a Trash.
- You can export everything to a zip at any time.
- Recent work is always recoverable.

Signing in adds sync across devices; paying adds more storage and longer history. Nothing here locks you in.
