# web/cloud/fleet: the fleet Worker

The fleet service's Worker. For now it holds only the browser relay's control plane: the two calls the relay makes to admit a browser channel's opens and to learn about revocations (design: agent-autonomous-browser-relay.md r2.1, §3 and §5).

| Call | What it does |
| --- | --- |
| `POST /api/fleet/v1/relay/admit` | It takes one host open, app open or commit, as the relay received it. It answers with a signed refusal, or with `ok` and every fact it verified. |
| `GET /api/fleet/v1/relay/epochs?since=<cursor>` | It lists the agents, accounts and hosts whose epoch changed since the cursor. Every answer carries a new cursor, even one with no changes. |

**The contract is the fleet core's `control.mjs`.** The relay and this Worker run the same file. Here it lives in `vendor/fleet-core/`, vendored byte for byte from sagebrush-agent at the commit `vendor/fleet-core/vendor.json` names.

## How a call is checked

`fleet.ts` checks each call in order, and every step fails closed:

1. **The kill switch and the key.** `FLEET_RELAY_OPEN` must be `"1"`, and `RELAY_CONTROL_KEY` must be 32 bytes. Otherwise: 503.
2. **The method and target.** Each must be one of the two calls. Otherwise: 404 or 405.
3. **The body.** For `POST`: a `Content-Length` (411 without one) of at most 128 KiB (413 over it), and a body of exactly that length. For `GET`: no body.
4. **The service MAC.** It must verify, with a timestamp within 60 s. Otherwise: 401.
5. **The call's id.** It is consumed once, atomically, in D1 (`INSERT … ON CONFLICT DO NOTHING`), and kept for 10 minutes. A repeat gets 409.
6. **The endpoint.** It answers with a signed refusal from the closed list, or a signed `ok`, either one bound to the call's id and to its body's digest.

Steps 1 to 5 answer a bare status. Nothing is signed for a caller that hasn't proved the key, and so is any internal failure (a bare 503).

**What the Worker never consumes.** That's the relay's host nonces, app request ids and commit authorizations. The relay consumes them durably, after an `ok`, before it upgrades a socket or changes a slot. The Worker holds no `browser_gen` state: the host's per-agent compare-and-set is the only authority on it.

## What is still missing: the fleet service's state

An admission checks live facts:
- the fleet's owner and its device chain;
- the fleet's hosts: their keys, generations and revocations;
- the agent's grant;
- the account session behind the relay's copy of the `__Host-sb_session` cookie.

These belong to the fleet service, which doesn't exist yet. `fleet.ts` reads them through the `FleetFacts` interface. **Until the fleet service is built, the Worker runs with `NO_FACTS`, which refuses every open (`not_granted`).** The feed, the control plane's authentication and the call-id replay rule work in full.

**When the fleet service exists, two things are needed:**
- **A real `FleetFacts`.** It reads the epochs first and then the facts, twice around the epochs, as `fleet.ts` does.
- **Every path that changes such a fact calls `store.ts`'s `bump()`** for each account, agent and host the change touches. It commits the change first and bumps after.

## Storage

The Worker has one D1 database, `migrations/0001_relay.sql`, holding:
- the consumed call ids;
- one monotone sequence, behind every change and every feed cursor;
- each identity's epoch;
- the changes, kept 24 hours.

A cron runs every 10 minutes and removes call ids past their window and changes past 24 hours. Removing old changes raises the floor below which a cursor is `cursor_expired`.

## Logs

There is one line per call: a fixed code, the endpoint and the duration. **The logs never contain** a cookie, a record, a signature, a nonce, an id, the key or an answer's facts. `test-fleet.mjs` checks for canaries.

## Tests

```
cd web/site && npm ci && cd ../..
node web/cloud/fleet/test-fleet.mjs
```

The tests run in Miniflare with a real D1, using the vendored core to play the relay's side. In CI they run in web-sync.1.

**What they cover:**
- **The control plane:** the switch, the key, the routes, the body caps and the MAC.
- **The call id once:** a replayed call and four concurrent copies of one call each get exactly one answer.
- **Admission:** every refusal of host opens, app opens and commits.
- **The read order:** the epochs and the late-answer guard.
- **The feed:** an empty answer still advances its cursor, each identity appears once, pages are cut by count and by bytes, and a cursor ahead of the sequence or past retention is `cursor_expired`.
- **The cron**, and **the logs**.

**The vendored files:** the test checks their sha256 values. A reviewer can check the bytes against their own clone of sagebrush-agent:

```
node web/cloud/fleet/vendor/sync.mjs verify <sagebrush-agent clone>
```

## Deploy (DEV only)

There is no production deployment. `cloudflare.config.ts` refuses any mode but `dev`. Production needs its own review, and the owner's OK for its D1 migrations, file by file. Every Cloudflare change below (the database, the secret, the deploy, the name) is made by whoever deploys, never by a test or CI.

1. **Create the D1 database** `sagebrush-fleet-dev`. Put its id in `cloudflare.config.ts` in place of the zero UUID, as a reviewed commit.
2. **Apply `migrations/0001_relay.sql`** to that database, by hand.
3. **The service key.** Generate 32 random bytes with a CSPRNG and pipe them, base64url-encoded, straight into `wrangler secret put RELAY_CONTROL_KEY` on stdin. The key must never appear in argv, a file, a log or this repository. For example:
   ```
   node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url"))' | wrangler secret put RELAY_CONTROL_KEY --name sagebrush-fleet-dev
   ```
   The relay's copy goes onto the relay VM the same way, through stdin into its secret store, without passing through any file or log on the way. To rotate the key, put a new one on both sides. Calls fail closed (401) in between.
4. **Deploy:** `cd web/cloud/fleet && npm run deploy` (`cf deploy --mode dev`). The Worker gets its own name, `fleet-dev.sagebrush.space`, and only the relay calls it.
5. **Check it from the relay VM.** A signed `GET /api/fleet/v1/relay/epochs?since=0` answers `ok` with a cursor. An unsigned call gets 401. Until the fleet service exists, every admit answers `not_granted`.

To close the Worker, set `FLEET_RELAY_OPEN` to anything but `"1"`: every call then gets 503. That fails closed on the relay, so its 30 s timer shuts every pair.
