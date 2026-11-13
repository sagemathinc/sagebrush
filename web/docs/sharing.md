<!-- description: Publishing a notebook or a talk as a link that anyone can open, run and copy; your shares; quick links. -->
# Sharing

Open **File ▸ Share…** to share a notebook. The window has three tabs: **Link** publishes it as a link, **Download** saves it as a file, and **Quick link** puts its code in the link itself.

## Publish a link {#publish}

On the **Link** tab, **Publish link** puts this notebook on a page of its own at sagebrush.space/s/…, with its outputs and the data files you choose. Anyone with the link can view it, run it in their own browser and copy it. The link is copied for you.

- Publishing needs a CoCalc account: **Sign in with CoCalc** appears in the dialog when you aren't signed in.
- The **Download** tab saves the notebook as an .ipynb file, or with the files it uses as one .zip, to send any way you like; Jupyter or Sagebrush opens it. It needs no account and works on every site.
- A site that can't publish, such as Sagebrush on your own computer, says so in the dialog and still offers a quick link. Publish from [sagebrush.space](https://sagebrush.space/) instead.
- **Options** holds the title, the byline, the license, the edit history and the files; its summary line shows what you'll share. The files the notebook's code uses are included for you when Sagebrush can find them. **Add files…** shows them, and its search finds any other file to include.
- **Author(s)** is shown on the page as "by …", exactly as you type it: one name, several, or none. Leave it empty for no byline. Sagebrush never fills it in from your account.
- **License** starts as "None given": what you share is then governed by [CoCalc's policies](https://cocalc.ai/policies). Choose a license if you want one to apply.
- Each publish is a version. The window says which version the link shows and whether you've changed the notebook since; when you have, **Publish version 2** (and so on) puts the new version at the same link, with the title and byline you gave last time unless you change them. Someone who opens the link sees the newest version.
- Every version also has a link of its own that never changes: **Copy a link to this version only** in the link's **⋯** menu, or under **Your shares ▸ Versions**.
- **Include edit history (TimeTravel)** publishes the notebook's history up to this version, so readers can play it back with **▶ History**. It's off unless you check it, and it can contain text you later deleted.
- Shared pages are kept out of search engines: they're found only through their links.
- Nothing runs on its own: a visitor's browser runs the notebook's code only when they run it (with **Run all**, for example), in a sandboxed frame apart from the page.

## Copy to my workspace {#copy}

On a published notebook's page, **Copy to my workspace** puts the notebook, with its data files, in your own files in this browser and opens it, ready to edit. No account is needed. Next time, the button reads **Open my copy**.

Code brought in from a link can't change your files until you allow it.

## Share a talk {#talk}

In the LaTeX editor, **File ▸ Share…** shares a talk with its folder, because the talk's code can read the folder's files. The dialog lists them all, ticked, except any that look like they hold a key or password; untick any you don't want to publish. Each talk in the folder gets its own link, and the one you shared from is listed first. A talk at the top of your files can't be shared: move it, and the files it uses, into a folder first.

On the shared page, a visitor sees the slides with your results. **Run** runs the talk's code in their own browser, and **Copy to my workspace** copies the talk's folder into their files.

## Your shares {#your-shares}

**File ▸ Your shares…**, or the **Your shares** link at the bottom of the Share window, lists everything you've shared, newest first, with **Versions**, **Copy link**, **Open** and **Delete**. **Versions** lists each version with its time and its own link. Deleting a share stops its links working for everyone, and can't be undone; copies people already made stay theirs. If you then share that notebook or folder again, it gets a new link.

## Quick link {#quick-link}

On the **Quick link** tab, **Copy link** makes a link with the cells' code and text inside the link itself: no outputs or files, no account, and nothing sent to a server. It is copied, and the Share window says so, with the link's length. Some apps, such as email and chat, may cut off a very long link; publishing gives a short one.
