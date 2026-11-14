# Remote compute: an agent on one computer using another computer

Status: design note, no code. It will be built later. It is written now so that today's data structures and schema
don't have to change shape when it is.

**The goal:** an agent running on one of your computers (say `lite`) can use a terminal or a notebook on another of
your computers (say `gpu`), because you granted exactly that. You can see what it did, and you can take the grant
back at once.

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

## 3. Security model

**What it protects:**
- An agent can reach only what the person granted: which computer, which capability, which path.
- A grant can't be widened by the agent, by the agent's computer, or by a page, because only the person's signed-in
  session creates grants.
- Revoking a grant ends its use at once and for good.
- The person can see every use (§4).
- A compromised `lite` reaches only what `lite`'s agents were granted, never the rest of the account.

**What it does not protect, said plainly:**
- **`notebook` isn't a sandbox.** A kernel runs arbitrary code as the target's user, so a `notebook` grant is as
  strong as a `terminal` grant on that computer. The path limits which notebooks the agent opens, not what their code
  can do. The only containment is what the target runs in: the Docker image is one layer.
- **The grant is to the computer `lite`, really.** The relay authenticates `lite`'s runner key, not the agent. The
  runner says which agent kind is asking. Anything running as the same user on `lite` can read that key and use every
  grant made to any agent on `lite`. The UI says this when a grant is made.
- **The relay is trusted here.** Under the threat model of the end-to-end note (design/remote-e2e.md), a relay
  adversary can admit reach legs as it can admit pages today. With pairing in place, `lite`'s runner would be paired
  to `gpu` like a device, and `gpu` would check its pin, which removes that.
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

   Revoking a computer revokes its grants both ways (as subject and as target), in the same write.
3. **Runners advertise what they accept.** A runner reports its agent kinds on its upgrade today
   (`x-sb-remote-agents`). It should report its features the same way (`x-sb-remote-features`). The relay must never
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
