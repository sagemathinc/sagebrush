<!-- description: Where Sagebrush keeps your files in this browser, what leaves it and when, what the Storage panel shows, exporting everything, and sync. -->
# Storage in this browser

Sagebrush keeps your notebooks, boards and files in this browser, on this device. Open the Storage panel from the meter at the foot of the file browser.

## What leaves this browser {#leaves}

By default your notebook code runs in this browser: Sagebrush doesn't upload its code, its outputs or your files to run it. The page does make ordinary requests to the site, for Sagebrush's own program and libraries and for signing in. Beyond that, these send document contents, contact other sites, or count use:

- **Sync**, when you turn it on: your notebooks' code and text, pictures attached to their text cells, and their TimeTravel history; your data files' names and contents; the names of your notebooks, boards and folders, and their moves, renames and deletions; when each change was made, and whether an agent made it; and this device's id and name. They go to Sagebrush's server (on a self-hosted site, that site's own server), under your account, and from there to your other browsers and devices. Cell outputs don't. See [Sync](#sync).
- **Publish a link**, **Share folder…** or **share a talk**, each time you publish: the notebook as a file, with its outputs and its metadata, the data files you chose (for a folder or a talk, the files you leave ticked), the title, byline and license, and the edit history if you include it go to Sagebrush's server, where anyone with the link can open them. See [Sharing](sharing#publish).
- **Push to GitHub**, a test feature on dev.sagebrush.space that is off unless it's turned on by hand: the folder's notebooks, without their outputs, its boards and its data files go through Sagebrush's push proxy, with your GitHub token, to a `sagebrush/…` branch of the GitHub repository you chose. After that, while the page is open, changes are pushed again about every 10 minutes.
- **A connected computer**, while it's connected: the cells you run, and what you type in its terminal, go to that computer, and their outputs come back. They go straight to it, or through Sagebrush's relay when the computer is connected that way; through the relay they're encrypted on the way, but not end to end. Code running there can make its own network requests, as any program on that computer can.
- **An agent you connect**, through sagebrush-mcp on this computer or through Sagebrush's relay to one of your computers: in the folders you grant it, it can read your files, and, if you allow it, change, create, rename and delete them and run notebooks and files. It also sees what you type to it. Through the relay, all of this passes through Sagebrush's server, encrypted on the way but not end to end. Whether the agent sends what it reads on to an AI service depends on the agent and how it's set up.
- **Pictures from other sites:** showing an image from another site requests it from that site, with its whole URL, including the path and query, which can itself carry information from the document. In the Markdown of a notebook made in this browser (whoever wrote or pasted it), and in a board's Markdown, such images load as soon as they're shown. Elsewhere, such as a notebook from another place or a published page, a **Load picture** button appears instead. Cell outputs never load images from other sites.
- **Opening from another site:** a GitHub page in Sagebrush (`/gh/…`) reads the repository from api.github.com and raw.githubusercontent.com, and from data.jsdelivr.com when GitHub limits it. A Sagebrush link that names a notebook, data file or board at another address (`?open=`, `?file=` or `?doc=`) fetches it from that address.
- **Counting use**, on sagebrush.space and dev.sagebrush.space only:
  - When you're signed in, the first request you make to Sagebrush's server each day (UTC) counts your account as active that day, and whether it's new that week and month, in a daily total and in a daily total by country (the country Cloudflare reports for the request). Your account also records when it was last active, to the hour. Global Privacy Control doesn't turn this off.
  - When you're not signed in, this browser tells Sagebrush's server, at most once a day (by the server's UTC day), that it was used that day, week and month. If the server doesn't answer, a later page load tries again. The count carries none of your code or files, and is added to a daily total and a daily total by country. It's on by default; your browser's Global Privacy Control turns it off.
  - The desktop app and the command line don't send these counts.

A quick link sends nothing to a server: the cells' code and text are in the link itself, after the `#`, so whoever gets the link can read them. One exception today: clicking **Sign in** on a page opened from a quick link carries the whole link, cells included, to Sagebrush's sign-in. **Download** and **Export** save to this device only.

## What the panel shows {#panel}

- **The bar:** how much space Sagebrush uses in this browser, out of what the browser allows.
- **Notebooks and boards**, and **data files:** how many, and how large.
- **Old versions:** the earlier versions of your data files. **Free…** deletes them all, after asking. The files as they are now stay.
- **Trash:** what you deleted. **Show** opens it; **Empty…** deletes it for good, after asking.

## What can be cleared {#kept}

Sagebrush clears only caches it can fetch or compute again. Old versions and Trash go only when you delete them.

A browser may clear a site's storage when the device runs short of space, unless it has agreed to keep it. When the panel shows **Keep**, this browser hasn't agreed yet: press it to ask. A browser may say no until the site is used more, or installed. When it has agreed, the panel says **kept**. Sagebrush also asks once, at your first edit.

## Export everything {#export}

**Export all current files (.zip)** downloads one zip of your current notebooks, boards, data files and folders.

It doesn't include TimeTravel, old file versions, Trash, or this device's settings.

The line beside it says when you last exported on this device. When that was more than 7 days ago, or there's something to export and you never have, it reminds you, with **Export now**.

## Sync {#sync}

With sync on, your notebooks and data files sync between your own browsers and devices, through Sagebrush's server (on a self-hosted site, that site's own server), signed in with your account. It isn't peer-to-peer, and nothing is shared with other people.

- **Data files**, such as CSV tables and images, sync with their contents. When you turn sync on, its confirmation says how many data files it will upload, and their total size.
- **Notebooks:** cells' code and text, and pictures attached to text cells, sync; their outputs don't. Outputs aren't kept in TimeTravel or included in a push to GitHub either.
- If the same cell is edited on two devices before they sync, the edits are merged. Both are kept.
- TimeTravel shows every version since the notebook first synced, on every device, including ones added later.
- Clearing TimeTravel isn't available yet for a synced notebook.
- If a notebook can't sync (the server refuses its changes, or a change is too large), the Sync line says so, its changes stay in this browser, and the panel lists them.
- Boards don't sync yet. A board made on another device is listed, but can't be opened until boards sync.

**Turn off sync here** stops syncing in this browser. Your files here stay.

## Same name on two devices {#sync-same-name}

A notebook, board or file made on two devices before sync was on is two separate documents, even with the same name. When the second device turns sync on, nothing is overwritten or lost: the first one keeps its name, and the second device's own copy is renamed with a number, for example `spiral (2).ipynb`. If its title was still its old file name, the title changes to match; a title you set yourself stays. Both devices list both. The Sync panel lists what was renamed. Edits sync within each document, not between the two: open the one you want to keep working on, on every device.

## Delete my synced data {#sync-delete}

**Delete my synced data** deletes what sync keeps on the server for your account. Every browser's own copy stays. You confirm by typing "delete".

## When sync is off in this browser {#sync-off}

- **This browser has sync data from an older version of Sagebrush:** sync can't start here until you reset it. Choose **Reset sync on this browser…** and confirm. The reset forgets how this browser was linked to sync. Your files, notebooks and boards here stay, with their TimeTravel history, and nothing on the server is deleted. What sync alone was keeping here is let go: bytes and old versions held back for upload are released, and old versions are then cleaned up as usual. Then **Turn on sync…** again: this browser joins as a new device. If a file here has the same name as one of your synced files, both are kept: see [Same name on two devices](#sync-same-name). Instead of a reset, you can also clear this site's data in your browser's settings. Export everything first (**Export all current files (.zip)**), because clearing site data deletes this browser's copy of your files.
- **Not available for this account:** sync isn't open to the account you're signed in as. If this browser synced before, the account you're signed in as is shown beside it ("signed in as …"). Check that you are signed in as the account you used for sync, and that sync is still available for it.
- **Sync data couldn't be read:** reload the page and try again. No reset is offered, because nothing is known to be wrong with the data.
- **Sign in to use sync:** sign in from **Share…**.
