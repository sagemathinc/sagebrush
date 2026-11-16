# Sagebrush security model

**Status: normative goals, early implementation.** This document states what
Sagebrush intends to protect and how those claims must be tested. The status
table says which goals are true today. A goal is not a product claim until its
status is **met** and its acceptance tests pass on the shipped artifact.

The first priority is: **safe to run a malicious notebook**.

## How to use this document

- Security audits check implementation and deployed behavior against these
  goals. A missing control is a product gap even when no exploit is known.
- Every security-relevant change names the goal identifiers it affects and
  explains whether it preserves, advances, weakens, or deliberately drops
  them. Its tests exercise the affected trust boundary.
- A new execution path, renderer, broker, package mechanism, credential,
  publication path, or external service starts outside the model until this
  file names its authority and tests.
- A failure must be closed: refuse the operation or kill the untrusted realm.
  Falling back to a realm with more authority is not recovery.
- [SECURITY.md](SECURITY.md) says how to report a vulnerability. The detailed
  mechanisms, history, and implementation notes live in
  [design/security.md](design/security.md). Those documents do not override
  the goals or status here.

## Assets and trust boundaries

The protected assets are:

- the account, its session, identity, payment state, service grants, agent
  grants, and third-party credentials;
- each owned document, its source, outputs, history, attachments, and secrets;
- workspace files and data not explicitly supplied to a run;
- the user's computer, including local files, processes, devices, and
  credentials;
- the user's network identity and ability to make requests;
- other users, their accounts, documents, computers, and network authority;
- Sagebrush services and infrastructure; and
- CoCalc accounts, credentials, services, and infrastructure.

A document has one owner, never a collaborator. Collaboration is copy,
proposal, review, and owner acceptance. A proposal is untrusted input until
the owner accepts its exact effects.

The important boundaries are:

1. **Account origin / untrusted execution.** Notebook code must run in a realm
   with no account-origin storage, DOM, cookies, authenticated requests, or
   privileged application bridge.
2. **Privileged host / file and network brokers.** Untrusted code receives
   capabilities through narrow, revocable messages. It never turns a path,
   URL, or claimed provenance into authority by itself.
3. **Document / workspace.** Owning or opening one document grants no access
   to another document or to unrelated workspace files.
4. **Rendered content / application UI.** Saved and newly produced output is
   attacker-controlled content. It must not execute with account-origin or
   native-application authority.
5. **Browser / native executor.** A worker thread and a removed global are not
   an operating-system sandbox. Native execution needs a restricted process
   and explicit brokers.
6. **Local product / connected computer.** Connecting a computer deliberately
   crosses into that computer's files, processes, and network. The grant must
   be explicit, scoped, visible, and revocable.
7. **Sagebrush / external services.** CoCalc and every other provider are
   separate security principals with separately scoped credentials. A CoCalc
   compromise must not imply a Sagebrush compromise.
8. **Private / published.** Sync, export, Git pushes, proposals, and published
   links cross a disclosure boundary. Only the selected, previewed snapshot
   may cross it.

## Threat actors

The primary threat is the author of a malicious notebook or shared copy. The
notebook may exploit its language runtime, forge host messages, consume
resources, persuade a user to grant authority, or contain hostile saved
output. Opening it and running it are separate attack surfaces.

The model also covers, in this order:

1. malicious saved HTML, Markdown, SVG, images, widgets, and other outputs;
2. a malicious agent, proposal, tool result, or prompt-injected action;
3. a malicious package or compiled extension, including a compromised package
   source;
4. a compromised Sagebrush server, build, update channel, or external service;
5. another user attempting cross-account or cross-document access; and
6. an attacker with network position who can observe, replay, redirect, or
   modify traffic.

The model assumes the user's browser and operating system enforce their
documented isolation primitives. Vulnerabilities in them remain residual
risk, not a reason to give untrusted code ambient authority.

## Testable goals

### G1. Default-deny unread execution

Running an unread notebook in the default-deny profile:

- **G1a — declared reads:** cannot read another document or workspace file;
  it can read only its own source, its private scratch space, and immutable
  inputs named in the run confirmation;
- **G1b — credentials and origin:** cannot read or use account credentials,
  origin storage, the account DOM, agent tokens, third-party tokens, or a
  privileged native bridge;
- **G1c — network:** cannot create an outbound request or cause a broker to
  request an undeclared network destination, including through images, CSS,
  SVG, imports, DNS, redirects, or credentialed same-origin requests;
- **G1d — writes:** cannot persist a file, modify another document, invoke a
  host action, or widen its own grants; and
- **G1e — script:** cannot execute script in the account's origin. A complete
  language-runtime escape remains inside an opaque, uncredentialed realm with
  the same read, write, and network restrictions.

The profile refuses to run if any required boundary is unavailable. Copies,
imports, shared notebooks, and replays enter this profile without inheriting
the author's grants.

### G2. Untrusted rendering

Opening or rendering a document, without running its code, cannot execute
script in the account origin, make an automatic remote request, access origin
storage or a native bridge, or mutate another document. This applies to saved
and live HTML, Markdown, SVG, math, images, widgets, links, and error output.
Sanitizers are defense in depth; the final output realm has no account or
native authority.

### G3. Capability integrity and revocation

Every file, network, agent, tool, package, and publication capability is bound
to the account, document, operation, parameters, execution generation, and
expiry that granted it. Narrowing or revocation takes effect before the next
observable effect. Stale, replayed, forged, reordered, and duplicate messages
fail closed. A restart, fallback, reload, or host switch cannot widen a grant.

### G4. Agents, proposals, and packages

An agent or proposal cannot produce an external or persistent effect until
the document owner approves the exact current action or diff. Approval is not
transferable to changed parameters or later content. Package bytes and
metadata are authenticated before execution, cannot replace core code, and
receive no more authority than the run that loaded them. Compiled extensions
must be treated as arbitrary native code unless a stronger sandbox proves
otherwise.

### G5. Stop and termination

In the default-deny profile, after the user presses Stop, cooperative code
must observe interruption within **1 second**. If the run has not reached a
terminal state, including because it caught the interrupt or entered native
code, the untrusted execution realm must be killed and replaced within
**3 seconds** of Stop. The privileged UI remains responsive and no queued
effect from the killed generation may commit.

These are proposed values requiring project-owner approval.

### G6. Resource ceilings

The default-deny profile enforces the following independent host-side limits.
Each limit has the required behavior listed below. Enforcing it must not take
down the privileged UI or another document.

| Resource | Proposed limit | Required behavior |
|---|---:|---|
| Wall time | 30 seconds per run | Stop and terminate the execution realm; a longer run requires a new explicit grant |
| Memory | 512 MiB per execution realm | Count JS heap, WebAssembly memory, buffers, decoder inputs, and queued messages; terminate at the cap |
| Output | 4 MiB or 10,000 messages per run, whichever comes first | Stop accepting output before copying or DOM insertion; mark the output truncated and stop the run |
| Retained output | 16 MiB per document session | Require explicit deletion or export before retaining more |
| Scratch storage | 64 MiB and 10,000 entries per execution realm | Refuse further writes; clear scratch when the realm is replaced or closed |

These values are proposed for project-owner approval. Their units, counting
rules, and behavior are part of the goal; approximate telemetry is not an
enforcement mechanism.

### G7. Service and identity separation

Sagebrush credentials are not accepted by CoCalc and CoCalc credentials are
not accepted by Sagebrush. An integration uses a distinct, least-authority,
expiring grant bound to its purpose. Compromise of CoCalc cannot mint a
Sagebrush session, approve an action, read documents not sent to CoCalc, or
obtain Sagebrush signing, deployment, payment, or agent credentials. The same
rule applies to other providers.

A compromised Sagebrush service can access only data deliberately sent to
that service. Local-only documents and credentials remain unavailable to it;
synced or published data is within the service's stated trust boundary.

### G8. Ownership, disclosure, and publishing

Only a document's owner can accept a proposal, change its authoritative
history, grant execution authority, or publish it. Sync and publication send
only the files and history named by their preview, never outputs, secrets,
credentials, hidden files, unrelated workspace data, or a later changed
snapshot. Published content runs with no account-origin authority and does not
become a collaboration channel back into the owned document.

## Status today

This table describes the implementation as of November 16, 2026. **Partial**
means useful controls exist but the whole goal is not a supported guarantee.

| Goal | Status | Evidence and gap |
|---|---|---|
| G1 | **Not yet** | The hosted restricted runner has an opaque origin, restrictive CSP, brokered fetches, and guarded writes. However, all workspace data files are supplied to the interpreter, read scopes are not enforced, and native mode refuses this profile because it has no OS sandbox. |
| G2 | **Partial** | HTML, Markdown, SVG, math, and image sanitizers plus hosted CSP block known script and remote-load paths. Notebook output still renders in the privileged page; the separate output realm is not wired into production, and the desktop page lacks the hosted CSP. |
| G3 | **Partial** | Write policy epochs, host-side path checks, worker generations, and non-replaying fallback close important races. Read and network settings are not yet one universal broker policy, and every restart, native, connected-computer, agent, and package path has not passed the same revocation suite. |
| G4 | **Partial** | Optional package sets are content-addressed and cannot replace core modules. Agent and proposal flows have scoped approval mechanisms. There is no accepted containment boundary for arbitrary external compiled code, and the full approval/replay matrix is not yet a release gate. |
| G5 | **Partial** | Compiled loops poll an interrupt word and the browser host restarts a still-pending interpreter after a delay. Coverage has waivers, interruption can be caught, native calls may not poll, and the proposed 1/3-second contract is not enforced across shipped hosts. |
| G6 | **Not yet** | Some allocators, images, transport queues, and explicit evaluations have limits. Ordinary runs have no default wall-time or output cap, numerical budgets default to unlimited, and memory accounting is not a hard total-realm limit. |
| G7 | **Partial** | Sagebrush uses its own identity and scoped integration protocols. A complete negative test proving that a compromised external service cannot cross every identity, agent, sync, deployment, and payment boundary is not yet a release gate. A compromised account-origin server can still serve privileged application code. |
| G8 | **Partial** | Documents use a single-owner, copy-and-propose model; publication and sync have selection and secret-removal controls. Exact-snapshot, hidden-file, symlink, output, and cross-origin assertions are not yet one end-to-end acceptance gate for every disclosure path. |

No row is **met** today. The product must not advertise the unqualified claim
that an unread malicious notebook is safe to run.

## Weaker modes

The default-deny profile is the reference security claim. Each mode below is
an explicit grant; its UI must name the dropped goals before execution.

| Mode | Goals deliberately dropped | Goals that still apply |
|---|---|---|
| Network on | G1c for the approved destinations and request shapes | G1a, G1b, G1d, G1e, and G2–G8 |
| Files on | G1a and G1d for the selected read/write handles or paths | G1b, G1c, G1e, and G2–G8 |
| Connected computer | G1a, G1c, and G1d within the connected host's displayed grant; G5 and G6 unless that host proves the same limits | G1b, G1e, G2, G3, G4, G7, and G8 |
| Native mode without an OS sandbox | G1a–G1e and G4's no-more-authority package clause for any runtime or compiled-code escape; G5 and G6 beyond controls the native host independently proves | G2, G3, G7, and G8 |
| External compiled package | G4's no-more-authority clause; in an unsandboxed native host also G1a–G1e, G5, and G6 | Package identity and integrity in G4, plus G2, G3, G7, and G8 |
| Publishing | G1a confidentiality and G8 privacy only for the exact previewed snapshot | G1b–G1e, G2–G7, and G8 ownership and isolation |

Combining modes combines their dropped goals. A saved choice must not silently
apply to a copied notebook, another document, a changed destination, or a new
execution generation.

## Non-goals and residual risks

- The model does not promise that notebook results are correct, honest, or
  reproducible, or that a malicious notebook cannot mislead a person.
- It does not make a deliberately granted network destination, file, agent,
  package, connected computer, or published snapshot private from its
  recipient.
- It does not provide anonymity or hide timing, traffic volume, package
  access patterns, or local resource use from infrastructure that serves the
  request.
- It does not protect a machine whose browser, operating system, or hardware
  isolation is already compromised. Browser and OS vulnerabilities remain
  residual risk.
- It does not treat sanitization, language restrictions, signing,
  notarization, content hashes, or reviewed source as an OS sandbox.
- It does not guarantee availability of a shared device or service under
  failures outside the stated per-run limits.
- Side channels, parser/decoder defects, compiler/runtime defects, supply-chain
  compromise, and social engineering remain residual risks. Defense in depth
  must keep one defect from automatically gaining account, filesystem, and
  network authority.

## Goal-to-test map

Existing tests are useful evidence, not proof of a whole goal. A goal becomes
**met** only when its required acceptance test runs against the actual browser
builds and signed native artifacts that ship.

| Goal | Existing evidence | Required acceptance gate |
|---|---|---|
| G1 | `test/security.test.ts`, `web/test-runner.mjs`, `web/test-runner-broker.mjs`, `web/test-runner-files.mjs`, `web/notebook/test-confine.mjs`, `web/test-confine-writes.mjs`, `web/notebook/test-runner-fallback.mjs` | Run hostile Python and injected JavaScript in each shipped execution realm. Prove no read outside declared inputs; no fetch, XHR, WebSocket, import, DNS, image, CSS, SVG, storage, DOM, credential, or native-bridge access; no persistent write; and fail-closed behavior when CSP, isolation, or the runner is missing. |
| G2 | `test/safe-html.test.ts`, `web/board/test-xss.mjs`, `web/notebook/test-render-contain.mjs` | Open hostile saved outputs and stream hostile live outputs through every renderer in hosted and native builds. Record all requests and effects; prove the output realm has no account storage, authenticated fetch, parent DOM, application IPC, script execution, or automatic remote loads. |
| G3 | `web/notebook/test-confine.mjs`, `web/test-confine-writes.mjs`, `web/notebook/test-runner-fallback.mjs` | For every broker, race grant, revoke, restart, fallback, reload, duplicate, reorder, stale generation, stale snapshot, and host switch. Assert no effect after revocation and no widening or replay. |
| G4 | `test/pkgset.test.ts`, `web/test-pkgset.mjs`, `web/test-pkgset-pin.mjs`, `web/workspace/test-agent-pair.mjs`, `web/workspace/test-agent-e2e.mjs` | Mutate package indexes, chunks, approvals, proposal bodies, parameters, actors, generations, and timestamps. Inject arbitrary compiled/native code and prove it has only the declared sandbox authority, or label and refuse the stronger claim. |
| G5 | `web/test-interrupt-browser.mjs`, `web/test-interrupt-matrix.mjs`, native self-tests | On each shipped browser and native host, test tight loops, caught interrupts, long native/Wasm calls, blocked message handling, background tabs, and queued writes. Measure from Stop at the trusted host. Require cooperative code to observe interruption within 1 second; if the run remains nonterminal, require realm death and replacement within 3 seconds of Stop, with no later queued effect. |
| G6 | allocation guards, image-size tests, transport-queue tests, and limit sweeps | Exercise infinite output, object/ArrayBuffer/Wasm growth, decoder bombs, scratch-file floods, deep trees, message floods, and concurrent documents. Assert the exact wall, memory, output, retained-output, and scratch limits without privileged-UI failure. |
| G7 | identity, session, integration, and service-worker integrity tests | Treat each external service and the Sagebrush service as compromised in turn. Forge tokens, responses, redirects, metadata, updates, and callbacks; prove no session minting, cross-service credential use, unauthorized approval, or access to local-only data. |
| G8 | sharing, folder-publication, copy, sync, and secret-removal tests | Publish and sync adversarial trees with outputs, secrets, hidden files, symlinks, traversal names, concurrent edits, and stale previews. Assert only the owner's exact previewed snapshot crosses the boundary and published content cannot act back on the account. |

Security fixes add a regression test at the lowest useful layer and, when they
cross a trust boundary, an end-to-end test at that boundary. Passing a mock or
source inspection alone cannot mark a goal met.
