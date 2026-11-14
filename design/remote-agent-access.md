# Remote compute: an agent on one computer using another computer

Status: design note, no code. It will be built later. It is written now so that today's data structures and schema
don't have to change shape when it is.

**The goal:** an agent running on one of your computers (say `lite`) can use a terminal or a notebook on another of
your computers (say `gpu`), because you granted exactly that. You can see what it did, and you can take the grant
back, which stops any further use at once.

## 1. Words

- **Computer:** an enrolled `sagebrush remote` runner (a `remotes` row, kind `runner`). It is identified by its
  `remote_id`. Its name is only a label: names can be renamed, and two computers can share one (enrollment doesn't
  check, and the rename check is not atomic).
- **Agent:** what acts. Either an agent kind that a runner offers (`--agent claude=...`, so "claude on lite"), or an
  enrolled agent peer (kind `agent`, `sagebrush-mcp --remote`).
- **Capability:** what the agent may open on the target computer:
  - `terminal`: a shell;
  - `notebook`: a kernel, for notebooks under a path on the target, relative to the folder its runner started in.
- **Grant:** one agent × one capability (with its path, for `notebook`) × one target computer. A grant is created and
  revoked by the account's person, never by an agent. It may have an expiry.
- **Address:** what an agent writes, for example `gpu:terminal` or `gpu:notebook/thesis/ch3.ipynb`. An address is
  resolved to a `remote_id` when the grant is made, and the grant stores the id, not the name. An ambiguous or unknown
  name is refused, with the list of computers. Renaming a computer doesn't change what a grant points at.

## 2. How a call flows

1. The agent asks its own runner on `lite`, over the local link that runner already has with it (stdio), to open an
   address.
2. `lite`'s runner opens a **reach leg** to the Worker. It is authenticated like its own upgrade, by a fresh challenge
   signed with its enrolled key, and it names the target, the capability, the path and the agent kind.
3. The Worker admits the leg only if all of these hold:
   - both computers are live and belong to the same account;
   - a live, unexpired grant matches the agent, the capability, the path and the target exactly;
   - the target's runner has said it accepts reach legs (§5).
4. `gpu`'s relay (its Durable Object) attaches the leg like a page, marked as coming from `lite`'s agent and naming
   the grant. `gpu`'s runner sees that marking and checks it too: a `notebook` grant opens kernels only for paths under
   the granted path, and a `terminal` grant opens terminals only.
5. **Every call is checked:** the relay holds the grant's state for each attached leg. It checks that state before it
   forwards every message, either way. Revoking or expiring a grant is a durable write in that object, which closes
   the leg at once (4403), the same way a revoked computer is closed today.

### 2.1 Where grant state lives, and how a revoke completes

- **D1 is the record:** it holds every grant, its expiry and when it was revoked. The Worker reads it to admit a reach
  leg, and the UI reads it to list grants.
- **The target's Durable Object is the fence:** each target computer's object keeps a durable set of grant ids
  revoked for that target. It checks the set when a leg attaches and before every message. A leg admitted from a
  stale D1 read, racing a revoke, is still refused there.
- **Revoking one grant:**
  1. The Worker writes the fence in the target's object, which closes that grant's legs and acknowledges.
  2. Only then does it write `revoked` in D1.
  3. The UI says "Revoked" only after both.
  A failed fence write leaves D1 unchanged and the UI saying it couldn't revoke, and the person tries again. This is
  the order the existing computer revoke already uses (the relay's durable write first, then the row).
- **Revoking a computer:** a computer's grants can point at several targets, so no single write fences them all. The
  Worker first revokes the computer itself, as today. That write closes its own legs and is checked when any reach
  leg it opens is admitted, so it stops new reach legs at once. The Worker then writes the fence in each target's
  object that holds one of its grants, and the UI shows the revoke as finishing until every target has acknowledged.
  Reach legs already attached to a target that hasn't acknowledged yet are closed when its fence is written. That
  window is the one thing not instant, and the UI says so while it lasts.
- **Expiry:** each object checks expiry itself, against its own clock, at attach and before every message, so an
  expiry needs no write to take effect.

## 3. Security model

**What it protects:**
- An agent can reach only what the person granted: which computer, which capability, which path.
- A grant can't be widened by the agent, by the agent's computer, or by a page, because only the person's signed-in
  session creates grants.
- Revoking a grant stops new reach legs and closes attached ones, so nothing more passes through it (§2.1).
- The person can see every use (§4).
- A compromised `lite` gets, directly, only the targets and capabilities `lite`'s agents were granted, not every
  computer on the account.

**What it does not protect, said plainly:**
- **`notebook` isn't a sandbox.** A kernel runs arbitrary code as the target's user, so a `notebook` grant is as
  strong as a `terminal` grant on that computer. The path limits which notebooks the agent opens, not what their code
  can do. The only containment is what the target runs in: the Docker image is one layer.
- **The grant is to the computer `lite`, really.** The relay authenticates `lite`'s runner key, not the agent. The
  runner says which agent kind is asking. Anything running as the same user on `lite` can read that key and use every
  grant made to any agent on `lite`. The UI says this when a grant is made.
- **The relay is trusted here, for authorization.** Under the threat model of the end-to-end note
  (design/remote-e2e.md), a relay adversary can admit reach legs, as it can admit pages today. With that note's full
  design (pairing, pinning and authenticated records on every reach leg, `lite`'s runner paired to `gpu` like a
  device), the relay could no longer read or inject on a reach leg. But it would still decide which grants exist:
  authenticating `lite` is not the same as authenticating the person's grant of a capability and path. So the relay
  stays trusted to authorize unless grants get a root of trust of their own, for example a grant confirmed on `gpu`
  itself, in its own terminal, which `gpu`'s runner then enforces. That root is not specified here.
- **Revoking doesn't undo anything.** It fences future use only. It does not undo what was already done, or stop
  processes the agent started on `gpu` (a background job keeps running). It doesn't recall files or credentials the
  agent copied off `gpu`, or close access it set up from `gpu` to elsewhere (a key it added, a service it started).
- **Access is transitive.** Whatever `gpu` can reach (its files and credentials, other machines it can log in to), an
  agent with a `terminal` or `notebook` grant on `gpu` can reach too. "Only what was granted" means only through the
  relay.
- **An agent's own judgment isn't controlled.** A granted agent can do anything in its grant, including things the
  person didn't intend. Keep grants narrow and set expiries.

## 4. The audit trail

- **The site keeps metadata only:**
  - a grant created, revoked or expired;
  - each reach leg opened, refused (and why) and closed;
  - its bytes each way and how long it lasted.
  It never keeps content: the relay doesn't parse application messages, and it must not start.
- **The target keeps the content, on that computer only:** `gpu`'s runner keeps a local log of each reach session
  (terminal input and output, the cells run), 0600 in its own folder, rotated. That is where "what did the agent type"
  is answered. It never leaves the computer.
- **In the UI:**
  - the Your computers dialog gains an Access part for each computer: its grants (agent, capability, path, expiry, last
    use), each with Revoke, and the recent metadata entries;
  - while an agent holds a reach leg, the target's pages show "claude on lite is using this computer's terminal" with
    a Stop button, which revokes the grant.

## 5. Decisions to take now (so later changes don't reshape what exists)

1. **Grants bind `remote_id`s, never names.** This is already true of `remotes`: re-enrolling makes a new id, and
   nothing moves from an old one (the comment in `0009_remotes.sql`).
2. **Two new tables**, added only when built, and touching no existing table:

   ```sql
   CREATE TABLE remote_grants (
     grant_id TEXT PRIMARY KEY,
     account TEXT NOT NULL,
     subject_remote TEXT NOT NULL,   -- the acting computer (or agent peer)
     subject_agent TEXT,             -- its agent kind ('claude'), or NULL for an agent peer itself
     target_remote TEXT NOT NULL,
     capability TEXT NOT NULL CHECK (capability IN ('terminal', 'notebook')),
     path TEXT,                      -- notebook: a path prefix on the target; terminal: NULL
     created INTEGER NOT NULL,
     expires INTEGER,
     revoked INTEGER
   );
   CREATE INDEX remote_grants_target ON remote_grants (target_remote, revoked);
   CREATE INDEX remote_grants_subject ON remote_grants (subject_remote, revoked);

   CREATE TABLE remote_audit (
     account TEXT NOT NULL,
     at INTEGER NOT NULL,
     grant_id TEXT,
     event TEXT NOT NULL CHECK (event IN ('grant', 'revoke', 'expire', 'open', 'refuse', 'close')),
     why TEXT,                       -- refuse: a fixed reason word
     bytes_in INTEGER,
     bytes_out INTEGER
   );
   CREATE INDEX remote_audit_account ON remote_audit (account, at);
   ```

   Revoking a computer revokes its grants both ways (as subject and as target), by the steps in §2.1. That is not one
   write.
3. **Runners advertise what they accept.** A runner reports its agent kinds on its upgrade today
   (`x-sb-remote-agents`). It should report its features the same way (`x-sb-remote-features`), for that connection
   only: the relay keeps them with the connection and drops them when that runner reconnects or is replaced, so a
   new connection starts with none until it advertises its own. The relay must never
   send a runner a control it didn't advertise: the runner parses `page-open` strictly (fixed keys, `kind` only
   `runner` or `agent`), and anything else is a protocol violation that ends its whole leg. A reach leg's
   `page-open` gains a `from` and a `grant`. Only runners that advertised `reach` ever see one, so old runners keep
   working and never admit one.
4. **Reach legs are opt-in on the target.** `sagebrush remote --accept-agents` is off by default. The person's grant
   in the UI and the target's own consent are both needed.
5. **Caps:** a new row in the relay's caps table (`relay-caps.ts`) for reach legs, by capability, with their own
   limits. They also count against the account's existing day budget.

## 6. Not decided here

- Grants to an agent across accounts (to share a computer with a colleague's agent): not proposed. Grants stay within
  one account.
- Read-only capabilities (watch a terminal, read a notebook's outputs). They would be real containment, unlike
  `notebook`. They are a later addition: a new capability value, with no change of shape.
- How long the site keeps audit entries, and what the target's local log is rotated at: to be set when built, from
  measured sizes.
