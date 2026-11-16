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

With sync on, your notebooks sync between your own browsers and devices, through Sagebrush's server, signed in with your account. It isn't peer-to-peer, and nothing is shared with other people.

- Only cells' code and text sync. Outputs never leave this browser: not to the server, not into TimeTravel, not in a push to GitHub.
- If the same cell is edited on two devices before they sync, the edits are merged. Both are kept.
- TimeTravel shows every version since the notebook first synced, on every device, including ones added later.
- Clearing TimeTravel isn't available yet for a synced notebook.
- If a notebook can't sync (the server refuses its changes, or a change is too large), the Sync line says so, its changes stay in this browser, and the panel lists them.
- Boards don't sync yet. A board made on another device is listed, but can't be opened until boards sync.

**Turn off sync here** stops syncing in this browser. Your files here stay.

### Same name on two devices {#sync-same-name}

A notebook, board or file made on two devices before sync was on is two separate documents, even with the same name. When the second device turns sync on, nothing is overwritten or lost: the first one keeps its name, and the second device's own copy is renamed with a number, for example `spiral (2).ipynb`. If its title was still its old file name, the title changes to match; a title you set yourself stays. Both devices list both. The Sync panel lists what was renamed. Edits sync within each document, not between the two: open the one you want to keep working on, on every device.

## Delete my synced data {#sync-delete}

**Delete my synced data** deletes what sync keeps on the server for your account. Every browser's own copy stays. You confirm by typing "delete".

## When sync is off in this browser {#sync-off}

- **This browser has sync data from an older version of Sagebrush:** sync can't start here until you reset it. Choose **Reset sync on this browser…** and confirm. The reset forgets how this browser was linked to sync. Your files, notebooks and boards here stay, with their TimeTravel history, and nothing on the server is deleted. What sync alone was keeping here is let go: bytes and old versions held back for upload are released, and old versions are then cleaned up as usual. Then **Turn on sync…** again: this browser joins as a new device. If a file here has the same name as one of your synced files, both are kept: see [Same name on two devices](#sync-same-name).
- **Sync data couldn't be read:** reload the page and try again. No reset is offered, because nothing is known to be wrong with the data.
- **Sign in to use sync:** sign in from **Share…**.
