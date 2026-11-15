<!-- description: Where Sagebrush keeps your files in this browser, what leaves it and when, what the Storage panel shows, exporting everything, and sync. -->
# Storage in this browser

Sagebrush keeps your notebooks, boards and files in this browser, on this device. Open the Storage panel from the meter at the foot of the file browser.

## What leaves this browser {#leaves}

By default your notebook code runs in this browser: Sagebrush doesn't upload its code, its outputs or your files to run it. The page does make ordinary requests to the site, for Sagebrush's own program and libraries and for signing in. Beyond that, these send document contents, contact other sites, or report use:

- **Sync**, when you turn it on: your notebooks' code and text, pictures attached to their text cells, their TimeTravel history, and your data files' contents and names go to Sagebrush's server, under your account, and from there to your other browsers and devices. Cell outputs don't. See [Sync](#sync).
- **Publish a link** or **share a talk**, each time you publish: the notebook with its outputs, the data files you chose (for a talk, the folder files you leave ticked), the title, byline and license, and the edit history if you include it go to Sagebrush's server, where anyone with the link can open them. See [Sharing](sharing#publish).
- **Push to GitHub** (on the testing site), once you set it up: the folder's notebooks, without their outputs, and its data files go through Sagebrush's push proxy, with your GitHub token, to a `sagebrush/…` branch of the GitHub repository you chose. After that, while the page is open, changes are pushed again about every 10 minutes.
- **A connected computer**, while it's connected: the cells you run go to Python on that computer, and their outputs come back. They go straight to it, or through Sagebrush's relay when the computer is connected that way. Code running there can make its own network requests, as any program on that computer can.
- **An agent you connect**: it can read your documents and what you type to it. Whether that then goes on to an AI service depends on the agent and how it's set up.
- **Remote images in Markdown:** displaying an image from another site requests its URL directly from that site, including the path and query. Images in Markdown you wrote here can load when the Markdown renders; other documents offer a **Load picture** button. The image URL can itself contain information from the document.
- **A daily usage count**, on sagebrush.space and dev.sagebrush.space: at most once a day, after the page has loaded, this browser tells Sagebrush's server that it was used that day, week and month. The count carries none of your code or files. It's sent with this site's cookies, so when you're signed in, the server counts your account as active. It's on by default; to turn it off, have your browser send Global Privacy Control. The desktop app and the command line don't send it.

A quick link sends nothing to a server: the cells' code and text are in the link itself, so whoever gets the link can read them. **Download** and **Export** save to this device only.

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

With sync on, your notebooks and data files sync between your own browsers and devices, through Sagebrush's server, signed in with your account. It isn't peer-to-peer, and nothing is shared with other people.

- **Data files**, such as CSV tables and images, sync with their contents. When you turn sync on, its confirmation says how many data files it will upload, and their total size.
- **Notebooks:** cells' code and text, and pictures attached to text cells, sync; their outputs don't. Outputs aren't kept in TimeTravel or included in a push to GitHub either. An output you save as a data file is a data file, and syncs as one.
- If the same cell is edited on two devices before they sync, the edits are merged. Both are kept.
- TimeTravel shows every version since the notebook first synced, on every device, including ones added later.
- Clearing TimeTravel isn't available yet for a synced notebook.
- If a notebook can't sync (the server refuses its changes, or a change is too large), the Sync line says so, its changes stay in this browser, and the panel lists them.
- Boards don't sync yet. A board made on another device is listed, but can't be opened until boards sync.

**Turn off sync here** stops syncing in this browser. Your files here stay.

## Delete my synced data {#sync-delete}

**Delete my synced data** deletes what sync keeps on the server for your account. Every browser's own copy stays. You confirm by typing "delete".

## When sync is off in this browser {#sync-off}

- **This browser synced with an older version of Sagebrush:** sync stays off here. To use sync again, clear this site's data in your browser's settings. Export everything first (**Export all current files (.zip)**), because clearing site data deletes this browser's copy of your files.
- **Sync data couldn't be read:** reload the page and try again.
- **Sign in to use sync:** sign in from **Share…**.
