<!-- description: Where Sagebrush keeps your files in this browser, what leaves it and when, what the Storage panel shows, exporting everything, sync, and who can read what sync keeps. -->
# Storage in this browser

Sagebrush keeps your notebooks, boards and files in this browser, on this device. Open the Storage panel from the meter at the foot of the file browser.

## What leaves this browser {#leaves}

By default your notebook code runs in this browser: Sagebrush doesn't upload its code, its outputs or your files to run it. The page does make ordinary requests to the site, for Sagebrush's own program and libraries and for signing in. Beyond that, these send document contents, contact other sites, or count use:

- **Sync**, when you turn it on: your notebooks' code and text, pictures attached to their text cells, and their TimeTravel history, which includes a record of each run (which cells ran, when and for how long, a fingerprint of each output, the values of controls, the interpreter's random seed and clock readings, the names and fingerprints of the files present when it started and of those it wrote or deleted, code typed in its console, and the code of another notebook that ran in the same interpreter); your data files' names, contents, sizes and fingerprints; the names of your notebooks, boards and folders, and their moves, renames and deletions; when each change was made, and the name of the agent that made it, if one did; and this device's id and name. They go to Sagebrush's server, under your account, and from there to your other browsers and devices; today the server can read them (see [Encryption](#encryption)). Cell outputs don't. On another site (one you host yourself, say), they go to that site's server, and notebooks' contents sync only if that server turns notebook sync on for the site, which no sync server Sagebrush ships does yet; otherwise only data files, the names of things and the details above about each change sync. See [Sync](#sync).
- **Publish a link**, **Share folder…** or **share a talk**, each time you publish: each notebook you publish as a file, with its outputs and metadata (such as when each cell last ran), the data files you chose (for a folder or a talk, every file left ticked, subfolders included), the title, byline and license, and the edit history if you include it go to Sagebrush's server (on a self-hosted site, that site's own server), where anyone with the link can open them. See [Sharing](sharing#publish).
- **Push to GitHub**, a test feature offered only on dev.sagebrush.space and on a Sagebrush running on this computer, and off unless it's turned on by hand: the folder's notebooks, without their outputs, its boards and its data files, and the files you delete, go through the push proxy the setting names, with your GitHub token, to a `sagebrush/…` branch of the GitHub repository you chose. After that, while a Sagebrush page is open in that browser, changes are pushed again about every 10 minutes; your GitHub token is saved only in that browser, and sent to the proxy with each push.
- **A computer you connect:** connecting one with `sagebrush remote login` gives Sagebrush's server its name (its hostname unless you choose one) and its public key, which the server keeps, with the kinds of agent it offers. A notebook paired with Python on this same computer sends it the cells you run, and the code before the cursor when you press Tab, over this computer's own loopback address. A terminal on a connected computer goes through Sagebrush's relay: what you type and what it prints are encrypted on the way, but not end to end (see [Encryption](#encryption)). Code running on that computer can make its own network requests, as any program there can.
- **An agent you connect**, through sagebrush-mcp on this computer or through Sagebrush's relay to one of your computers: in the folders you grant it (**Everything** is ticked to start with), it can list and read your files, their history and earlier versions, which can hold text you later deleted. **May change files**, ticked to start with when the agent asks to change files, lets it write, create, rename, duplicate, delete and restore files and folders, and edit a notebook's cells. **May run code**, ticked to start with, lets it run notebooks and files. It also sees what you type to it. Through the relay, all of this passes through Sagebrush's server, encrypted on the way but not end to end (see [Encryption](#encryption)). Whether the agent sends what it reads on to an AI service depends on the agent and how it's set up. With **Delegate** on in the Agents page, the documents you give a task are copied to the agent's computer, in `~/.sagebrush/tasks`, and stay there.
- **Pictures from other sites:** showing an image from another site requests it from that site, with its whole URL, which can itself carry information from the document, and, from most of Sagebrush's pages, with this site's address as the referrer. Some Markdown loads such images as soon as it's shown: a board's step captions and introduction in its tour, wherever the board came from, and the preview of your comment on a board; a board's notes, on a board made here; and text cells of a notebook that started empty in this browser (one made with **New notebook** in the File menu, or the Untitled one Sagebrush opens for you). Elsewhere, such as a notebook from another place, one made in the file browser, or a published page, a **Load picture** button appears instead. Cell outputs never load images from other sites.
- **Opening from another site:** a GitHub page in Sagebrush (`/gh/…`) reads the repository from api.github.com and raw.githubusercontent.com, and from data.jsdelivr.com when GitHub limits it. A Sagebrush link that names a notebook, data file or board at another address (`?open=`, `?file=` or `?doc=`) fetches it from that address, and anything a data file's parts list (`.parts.json`) names. A board downloaded as HTML and set to use the latest engine fetches it from the site it came from when you open it.
- **A board shown in another site's page** (a course's, say) that takes answers: **Submit** sends that page your answers, the words you typed and your comment, and **Get feedback on my words** sends it your words so it can choose among the question's options. A page that lets you edit its board is sent each change you make, as you make it.
- **Counting use**, on sagebrush.space and dev.sagebrush.space:
  - When you're signed in, the first time each day (UTC) that a page checks your sign-in (each notebook page does when it opens), or you use sharing or a connected computer, counts your account as active that day, and whether it's new that week and month, in a daily total and in a daily total by country (the country Cloudflare reports for the request). Your account also records when it was last active, to the hour. Global Privacy Control doesn't turn this off. A self-hosted site running Sagebrush's server counts its own signed-in accounts the same way.
  - When you're not signed in, this browser tells Sagebrush's server, at most once a day (by the server's UTC day), that it was used that day, week and month. If the server doesn't answer, or refuses, a later page load tries again. The count carries none of your code or files, and is added to a daily total and a daily total by country. It's on by default; your browser's Global Privacy Control turns it off.
  - The desktop app and the command line don't send these counts.

A quick link sends nothing to a server: the cells' code and text are in the link itself, after the `#`, so whoever gets the link can read them. Signing in while the address holds a quick link leaves the cells out of what goes to the server. **Download** and **Export** save to this device only.

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

With sync on, your notebooks and data files sync between your own browsers and devices, through Sagebrush's server, signed in with your account. (On another site, notebooks' contents sync only if its server turns notebook sync on; otherwise only data files and the names of things sync.) It isn't peer-to-peer, and nothing is shared with other people.

- **Data files**, such as CSV tables and images, sync with their contents. When you turn sync on, its confirmation says how many data files it will upload, and their total size.
- **Notebooks:** cells' code and text, and pictures attached to text cells, sync; their outputs don't. Outputs aren't kept in TimeTravel or included in a push to GitHub either.
- If the same cell is edited on two devices before they sync, the edits are merged. Both are kept.
- If a data file is changed on two devices before they sync, the version that reaches the server first keeps the name on every device. The other device's version is kept beside it, as a copy with "conflict" in its name.
- TimeTravel shows every version since the notebook first synced, on every device, including ones added later.
- Clearing TimeTravel isn't available yet for a synced notebook.
- If a notebook can't sync (the server refuses its changes, or a change is too large), the Sync line says so, its changes stay in this browser, and the panel lists them.
- Boards don't sync yet. A board made on another device is listed, but can't be opened until boards sync.

**Turn off sync here** stops syncing in this browser. Your files here stay.

When your plan has a storage limit, the Sync panel shows how much of it you've used. Synced files and what you publish count against the same storage.

## Encryption {#encryption}

**Today,** what sync keeps on Sagebrush's server is encrypted at rest by Cloudflare, Sagebrush's host, and what goes through the relay to a connected computer is encrypted on the way. In both, Sagebrush's server can read it, and so could someone with access to the server, or a legal demand made to it.

**Decided, before sync opens to everyone:** sync, the relay to your own computers, and agents' conversation logs kept on the server become end-to-end encrypted. There will be one mode, with no setting to turn it off:

- **Only your devices hold the keys.** The server stores what they send, but can't read your files, notebooks or their names. It still sees how much you store, when your devices sync, which device sent what, and whom you share with.
- **A recovery code,** shown once when you set sync up, is the only way back in without one of your devices. Nobody stores it: not Sagebrush, and not your devices. **If you lose every device and the recovery code, your synced data is gone,** and nobody can recover it, not Sagebrush and not support.
- **A browser can lose its keys** when its site data is cleared. It then asks to be set up again, from another of your devices or with the recovery code.
- **Removing a lost device** stops it reading what your devices write afterwards, under new keys. It can't make it forget what it already had. A share someone sends you can lag behind: their Sagebrush may use your previous key for up to 30 days, until it fetches the new one.
- **A GPU machine you start joins your devices.** Pressing **Start** on a GPU machine adds that machine to your end-to-end workspace: while it's there, it can read and change everything in the workspace, and it can keep a copy of what it read. The machine's administrators, the provider's and Sagebrush's, can read its keys and your files while you use it. It can't add or remove devices or change your recovery code. It's removed, under new keys, when its reservation ends; to remove it earlier, choose **Remove** on the notice that appears after Start, or in your list of devices. To check the machine first, choose **Approve it myself**: Start then waits until you compare the fingerprint the machine shows in its terminal with the one on the page, and approve it. If the machine reports that its sign-in token was already used somewhere else, Sagebrush removes the device that used it, changes the keys and warns you.
- **The limit of any web page:** a page served by a compromised or compelled server could use the keys while it's open. The desktop app has the stronger guarantee, because its signed builds don't come from the server.
- **"Delete my synced data" keeps your keys' record:** the chain of your account's keys, your encrypted keys, and each device's name and public key stay on the server. They identify your devices and let you set sync up again; your synced files and history are deleted. Deleting your CoCalc account removes these records too.
- **Exceptions are explicit:** a link you publish is public, and anyone, the server included, can read it ([Sharing](sharing#publish)); a support bundle is only what you choose to send; and class work opened from a school's course site stays readable by the course's instructors and graders, and the editor says so. Who else may read class work, and how long it's kept, will be decided before that part is built.

The design is in Sagebrush's source, in design/e2e-encryption.md.

## Same name on two devices {#sync-same-name}

A notebook, board or file made on two devices before sync was on is two separate documents, even with the same name. When the second device turns sync on, nothing is overwritten or lost: the first one keeps its name, and the second device's own copy is renamed with a number, for example `spiral (2).ipynb`. If its title was still its old file name, the title changes to match; a title you set yourself stays. Both devices list both. The Sync panel lists what was renamed. Edits sync within each document, not between the two: open the one you want to keep working on, on every device.

## Delete my synced data {#sync-delete}

**Delete my synced data** deletes what sync keeps on the server for your account. Every browser's own copy stays. You confirm by typing "delete".

## When sync is off in this browser {#sync-off}

- **This browser has sync data from an older version of Sagebrush:** sync can't start here until you reset it. Choose **Reset sync on this browser…** and confirm. The reset forgets how this browser was linked to sync. Your files, notebooks and boards here stay, with their TimeTravel history, and nothing on the server is deleted. What sync alone was keeping here is let go: bytes and old versions held back for upload are released, and old versions are then cleaned up as usual. Then **Turn on sync…** again: this browser joins as a new device. If a file here has the same name as one of your synced files, both are kept: see [Same name on two devices](#sync-same-name). Instead of a reset, you can also clear this site's data in your browser's settings. Export everything first (**Export all current files (.zip)**), because clearing site data deletes this browser's copy of your files.
- **Not available for this account:** sync isn't open to the account you're signed in as. If this browser synced before, the account you're signed in as is shown beside it ("signed in as …"). Check that you are signed in as the account you used for sync, and that sync is still available for it.
- **Sync data couldn't be read:** reload the page and try again. No reset is offered, because nothing is known to be wrong with the data.
- **Sign in to use sync:** press its **Sign in** button, or **Sign in** at the top right of the page.
