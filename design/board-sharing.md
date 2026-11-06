# Sharing a board (a note for a decision; not built)

*Status: a question for William (@sagebrush, Nov 6). Today a board's File ▸ Share… is disabled. Its title says so and
points to File ▸ Download ▸ HTML (one file). Sim run 12's X01 agent tried it and got nothing.*

## What exists today

- **A notebook has two ways to share** (File ▸ Share…):
  - **the link:** the whole notebook in the URL (`/#z=<deflated cells>`, `m=` for the language). It needs no server
    and no account, and anyone who opens it gets a copy in their browser;
  - **a hosted collection** (design/sharing.md): the notebook and its files uploaded to sagebrush.space under a CoCalc
    sign-in, at a stable `/s/<id>` link.
- **A board has neither.** It can be downloaded as `.board.json`, as JSON Canvas, or as one HTML file that runs its
  code on its own. The board page also shows a board from a URL (`/board/?doc=<url>`).

## What a board link would have to carry

A `.board.json` holds a board's notes, code items, ink, edges, pages and tour. Two parts can make it large:

- **pictures:** each is a `data:` URL or an `https:` address, so pasted images make a board grow fast;
- **outputs:** the last results of its code items (plots as images), kept so that a reader sees them before running
  anything.

The corpus's boards are 5 to 6 KB each as JSON. A board with a few pasted pictures or plots is easily hundreds of KB.

## Options

1. **A link, as the notebook's (`/board/#z=…`):** no server and no account. Only for small boards: a URL past a few
   tens of KB breaks in chat apps and mail, so pictures and outputs would be left out, or a big board refused with a
   pointer to option 2. The reader's page would open it as an unsaved board, with its code paused until they run it
   (as a board brought in from a file is today: `codePaused`).
2. **A hosted collection, as the notebook's upload:** the server needs no change. It stores any file by its SHA-256
   and serves it only through its collection, as an attachment, with `nosniff` and a `sandbox` CSP. What's missing
   is on the reader's side: the share viewer (web/share-client/view.ts) opens only `.ipynb`, `.py` and `.sage`
   (`OPENABLE`), so a shared board is listed but can only be downloaded. It would need to open a board on the board
   page (for example `/board/?doc=` reading the collection's file, CORS allowed) with its code paused, as option 1.
   A board's pictures that are `https:` addresses stay links to elsewhere. That should be said on the dialog, or
   the pictures uploaded with it.
3. **Both,** as the notebook does: the link for a small board, the upload for anything else.

## Questions for William

- Is sharing a board wanted now, or after the notebook's sharing opens widely?
- Is the link (option 1) enough to start with, or should the upload come first?
- Should a shared board's outputs be included, so a reader sees results without running code (design/outputs.md),
  or left out?
