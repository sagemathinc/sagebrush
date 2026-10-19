<!-- description: What happens to your synced data when your membership ends: read-only, downloadable any time, deleted after the retention period, with email first. -->
<!-- disclosure: Written by Claude Opus 5.5, an AI model made by Anthropic, for the Sagebrush project, led by William Stein (SageMath, Inc.). DRAFT: not linked or published. It becomes the first entry of the site's FAQ when sync opens beyond its test accounts; publishing is William's decision. -->
# What happens to my synced data if my membership ends?

Your synced data stays, read-only, for 90 days.

- **Nothing is deleted at once.** Your files, notebooks and boards stay on the server, read-only. You can open and read them from any of your devices, but changes aren't synced until sync is part of your membership again.
- **You can download everything at any time,** with "Download all" in the Sync panel, or as the export of a single file or document.
- **Your copies on your own devices are never touched.** They stay on each device whatever happens on the server.
- **After 90 days, your synced data is deleted from the server,** in the same way as "Delete my synced data". We email you when your membership ends, and again about two weeks before the deletion.
- **If you renew within the 90 days,** sync starts again where it left off, and nothing is deleted.

Shared links are separate: what you have shared stays shared, under the sharing rules.

---

## The same, as the Sync panel's help line for a read-only account

(For the client, sync-client.ts: shown when the account's state is `readonly`, with the date from `purge_after` in `/api/share/me`'s `sync_retention`.)

> Your membership no longer includes sync, so your synced data is read-only. Download it any time with "Download all". It will be deleted from the server on **{date}**, unless you renew before then; the copies on your devices are never touched.
