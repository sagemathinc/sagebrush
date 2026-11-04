# Sagebrush: one page

## What Sagebrush is

Sagebrush is open mathematics software that runs where you are: in a browser tab, in an app on your computer, or inside an AI agent's tools. It comes as three products.

### Sagebrush Space: [sagebrush.space](https://sagebrush.space)
Open the page and start computing: nothing to install, no sign-in needed, on a laptop, a tablet or a phone. Each document (a notebook, a LaTeX document or a board) gets the whole window, and opening another is quick, so there are no tabs to manage: close this one, open that one, or use another window.

### Sagebrush app: desktop builds for Mac, Windows and Linux; iPhone and Android in progress
The same documents and file model as Sagebrush Space, with what a local app adds:
- **Your files are real files,** in a folder on your disk, with their history kept beside them, and no browser storage limits.
- **Agents connect directly:** an agent on your computer pairs with the app, without going through a website.
- **Native engines and multicore acceleration are being added engine by engine.** Today the app runs the same engines as the web.

### Sagebrush engine: the mathematics
What distinguishes Sagebrush is its independent mathematical engine: research mathematics (class groups and units, modular symbols and newforms, Galois groups, elliptic curves, exact linear algebra, polynomial algorithms), implemented from scratch, with Sage- and Magma-compatible interfaces alongside Python and MATLAB modes, designed to run in a browser as well as natively. We are not aware of another project combining these.

- **It implements useful subsets** of Python, Sage, Magma and MATLAB, and a LaTeX editor with live code. It does not implement all of any of them. Results are exact where the mathematics is exact; where something isn't implemented yet, you get a precise error, not a wrong answer. See the [compatibility notes](https://sagebrush.space/articles/) for what is and isn't covered.
- **It is checked against the real systems:** Sage, Magma, and Octave for MATLAB. Agreement between independent implementations is strong evidence, though not a proof: shared algorithms or reference data can share mistakes.
- **The [articles](https://sagebrush.space/articles/) explain how each algorithm works,** what worked and what didn't.
- **AI assistance made this breadth practical** for a small team to build on this timescale.
- **It is open source (MIT/Apache) and ships on its own:**
  - `pip install sagebrush`;
  - the `sagebrush` command line;
  - `uvx sagebrush-mcp`, which gives any agent the engine and your documents as tools.

## Built for agents as much as for people

Agents work through the same document commands people use: open and edit documents, run code, render a page and check the result. Protected operations, such as deleting protected files or turning protection off, require explicit approval from a person in Sagebrush's interface. See [sagebrush.space/agents](https://sagebrush.space/agents).

## What the interface aims for

One document at a time, in one small, uniform frame. We keep polishing it toward:
1. **Immediacy:** you can do something useful right away.
2. **Speed:** opening, running and switching documents are never the slow part.
3. **Minimalism:** nothing on screen that the document doesn't need.
4. **Usability with agents:** everything visible, checkable and safe for a person and an agent working together.

## Safety

- **TimeTravel and Trash** let you recover recent edits and deleted documents within their retention limits.
- **History is bounded,** so it never grows without limit.
- **You can export everything to a zip at any time.**

Browser storage can still be cleared by the browser or by you; export, or sign in to sync across devices, if the work matters. Signing in adds sync; paying adds more storage and longer history. Nothing here locks you in.
