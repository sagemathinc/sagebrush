<!-- description: Where Sagebrush keeps your files in this browser, what the Storage panel shows, exporting everything, and sync. -->
# Storage in this browser

Sagebrush keeps your notebooks, boards and files in this browser, on this device. Open the Storage panel from the meter at the foot of the file browser.

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

- **Data files:** the contents of files such as CSV tables and images sync between your devices. When you turn on sync, the confirmation shows the count and size of the data files it will upload.
- **Notebook cells:** only their code and text sync. Cell outputs aren't included in notebook sync, TimeTravel, or a push to GitHub. Saving an output as a separate data file makes it part of data-file sync.
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
