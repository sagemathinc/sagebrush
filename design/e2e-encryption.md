# End-to-end encryption for private synced data

*Status: draft design r2, with SEC review. William's decisions (Nov 23 2026) are in §10; only the post-quantum question (Q11) is open. Nothing here is built. Sync, sharing and the agent endpoint are DEV-only, and no paying customer has data yet.*

## 0. The decision

Today private synced data is encrypted **at rest by Cloudflare** ((a), decided Oct 18: design/workspace-files.md §7.4, design/sync-server.md §10). The server, Cloudflare, an insider or a legal demand can read paths and content.

**Decided (William, Nov 23 2026: "Yes, approve E2E as the one mode"): switch, before any paying customer, to one mode: end-to-end encryption for all private synced data.** Only the person's devices hold the keys. The server stores and orders ciphertext. There is one mode, not two.

**The principle** (William, Nov 23): "e2e by default; explicit exceptions for problems when e2e doesn't make sense." Every exception is listed here and in the product, and the editor says plainly when a file is under one:
- **public publishing:** an explicit decrypt-and-publish step (§5);
- **support bundles:** an explicit, per-ticket export (§5);
- **class work:** assignment files launched from a school's LMS, in a class store the server can read (§5.2).

Already decided or approved by William:
- one mode, not both;
- sharing stays GitHub-like, never a shared live document:
  - a share is an encrypted copy for its recipient, or a link share whose key is in the URL fragment;
  - a proposal comes back as an encrypted, signed diff against the snapshot's hash;
  - applying and merging happen client-side;
- public publishing is an explicit decrypt-and-publish step;
- support works only from a snapshot bundle the person chooses to send. Nobody looks at anything directly;
- files are compressed before they are encrypted. Dedup works within an account through keyed blob names. Cross-account dedup is lost.
- (Nov 23) DEV synced data is wiped at the cutover; the recovery code is the only recovery; agents and Autonomous VMs are full trusted devices, with no per-folder keys; no size padding; TOFU key warnings in v1; the generic preview card for encrypted links;
- (Nov 23) agent logs and the relay to your own computers are end to end too (§6.2);
- (Nov 23) the browser's limit is accepted, and signed releases with a public log are planned (§8).

Each section below gives the options, a recommendation, and what it costs. §10 records William's decisions.

## 1. What the person sees (the honest version)

- **Setting up sync** creates the account's keys on that device and shows a **recovery code** once. The person must confirm they kept it, by typing back part of it, before sync starts.
- **Adding a device** is done from a device that is already set up: scan a QR code or compare a short code, as when pairing a phone. Without such a device, the person enters the recovery code.
- **If every device and the recovery code are lost, the data is gone.** Nobody can recover it: not Sagebrush, not CoCalc, not support. The setup screen says this in one sentence, and Settings says it again.
- **Nobody stores the recovery code:** not the service, and not a device. Settings shows "Recovery is set up" and offers **Replace recovery code**. There is no "Show recovery code": a device that kept the seed would stay able to recover the account even after it was removed.
- **Removing a device** (lost or sold) stops it from reading anything written afterwards. It can't make it forget what it already downloaded. The dialog says so.
- **A browser can lose its keys on its own:** site data cleared, or storage evicted (Safari's 7-day rule for sites not visited). The page then asks to set the browser up again, from another device or the recovery code. Nothing is lost as long as one of those exists. The desktop app, or a second device, makes this rare.

## 2. Keys

**Recommendation: per-epoch account secrets, certified per-device keys, and a recovery key that every epoch is also wrapped to.** This is SEC's recommended shape.

- **Device keys:** each device has an X25519 key, to receive the epoch secret, and an Ed25519 key, to sign its ops and its key-chain entries.
  - **In the browser:** non-extractable WebCrypto keys in IndexedDB. The client already makes non-extractable WebCrypto keys and refuses extractable ones (web/notebook/remote-client.js's DPoP P-256 key); keeping them in IndexedDB is new.
  - **In the desktop app:** the OS keychain (macOS Keychain, Windows Credential Manager, Secret Service), through the Tauri app and the small `keyring` crate. The app has no keychain access yet.
- **The recovery key:** a 32-byte seed, shown once as the recovery code. Domain-separated derivations give a recovery X25519 key and a recovery Ed25519 key, and only their public halves are stored.
  - **No password-derived escrow:** a password could be guessed offline, and a 256-bit seed can't.
  - **Nobody stores the seed** (§1), not even a device.
  - **Recovering uses the seed transiently.** The recovering device enrolls itself with it, then clears it from memory. It immediately makes a new recovery key (and so a new recovery code to write down) and a new epoch, so the code just typed opens nothing written afterwards.
  - **Replacing the recovery code** makes a new recovery key, re-wraps every epoch that recovery may need to it, and records the replacement in the chain. New epochs are wrapped only to the current recovery key.
  - **The recovery code is as powerful as a device.** If it may have been exposed, the person replaces it. Settings says so.
    - **The limit:** an old code can't be made to forget epochs it could already open. The server deletes the old wrapped copies, but a malicious server or a copy taken earlier could keep them.
- **Epochs:** each epoch `e` has a random 32-byte secret `S[e]`, and its chain entry names its **suite**: the KEM, AEAD, KDF, signature, codec and label version used for everything written in it (§11.1). It is HPKE-wrapped to every current device's X25519 key **and** to the recovery X25519 key, and the wrapped copies are stored next to the key chain.
  - So the recovery code can always open the latest epoch the server shows it, with no stored copy encrypted under the code itself.
  - **Only the current epoch is wrapped to devices and recovery.** Earlier epochs' secrets travel in the epoch's **keyring** (§11.2), which is encrypted under the current epoch.
  - **From `S[e]`,** HKDF-SHA256 derives, each under its own label:
    - the index key `K_index[e]`;
    - the address key `K_addr[e]` (§3.3);
    - the blob key `K_blob[e]` (§3.3);
    - the key that wraps per-object content keys, `K_wrap[e]`.
- **The inbox key pair** (X25519, for receiving shares and proposals, §5) is random, kept wrapped under `K_wrap[e]`.
  - **Removing a device rotates it automatically** (SEC). A removed device knew the old private key, and could otherwise open every future share sent to the unchanged public key.
  - The new inbox public key is published in a signed chain entry. Senders that pinned the account's chain accept it as continuity, verified through the chain, not as a first-use key.
  - **The inbox record has bounded validity** (30 days, renewed automatically by any of the account's devices). A sender refuses an expired record and fetches a fresh one.
  - **The limit, stated plainly** (SEC): the chain proves continuity, not freshness.
    - Anything already sent to the old inbox key stays readable by the removed device.
    - A share sent after the removal, by a sender that hasn't yet learned of the rotation, is readable by it too, until that record expires.
    - A malicious server can withhold the rotation from a sender to stretch that window, up to the record's validity.
    - **Revocation is not instant for shares.** The account's own writes under the new epoch are protected at once.
- **The key chain:** an append-only, signed log of the account's devices and epochs. It reuses the structure the fleet protocol already has and SEC has already reviewed (sagebrush-agent's lib/fleet/core: genesis, add with the new device's countersignature, remove, recover, rotate recovery).
  - The server stores the chain and can't forge it.
  - Each device pins the head it last verified, and refuses a chain that rolls back or forks from it.
- **Adding a device** is a chain entry signed by an existing device, after a QR code or short-code comparison, and countersigned by the new device. It's followed by `S[e]` wrapped to the new device.
- **Not recommended for r1:**
  - a key held by CoCalc or Sagebrush (that's (a) again);
  - social or threshold recovery.

  **No passkey as an extra unlock factor** (decided, §10 Q2): the recovery code is the only recovery.

### 2.1 Key-chain authority (SEC)

- **Who may change the chain:**
  - any current device may add a device (after the QR or short-code comparison) or remove one;
  - only the recovery key may sign a recovery;
  - only a current device may replace the recovery key.
- **Concurrent entries:** the chain is linear. An entry names its predecessor's hash, and the first valid entry at a position is the chain. An add or removal made on a stale head is refused, and rebased by its device. An add is always countersigned by the new device. A device whose entry lost re-reads the chain and retries on top of it. Two devices removing each other at once: the first entry wins, and the removed device's later entry is refused.
- **The last device:** losing it leaves only the recovery code (§1).
- **The limit:** a compromised current device can add an attacker's device until its own removal is seen. A malicious server can keep devices on different valid forks; signatures don't prevent that, and checkpoints (§4.1) detect it only against what a device has already seen.

### 2.2 Removing a device

- **A removal is a chain entry, then a new epoch** `e+1`: a fresh `S[e+1]`, wrapped to the remaining devices and the recovery key, with a new address key.
- **New writes use the new epoch.** The new epoch's keyring carries every earlier epoch's secret, so nothing old becomes unreadable to current devices and nothing has to move (§11.2). Old objects keep their keys unless the person asks for a background re-encryption.
- **The limit, stated plainly:** a removed device keeps whatever it decrypted or downloaded before.
- **A malicious server can show an old epoch.** It could show a recovering device an old chain, and so an old epoch, unless that device already holds a checkpoint (§8).

## 3. Primitives

| Option | Content | Wrapping | Signing | Added dependencies |
| --- | --- | --- | --- | --- |
| **A (recommended)** | AES-256-GCM (WebCrypto) | HPKE base mode, DHKEM(X25519, HKDF-SHA256) + AES-256-GCM, from our fleet core | Ed25519 (WebCrypto) with the fleet core's strict checks | none: our own small HPKE module, already pinned by RFC 9180's vectors and the shared fixtures, and checked by an independent Python verifier |
| B | AES-256-GCM | `@hpke/core` + `@hpke/dhkem-x25519` | Ed25519 | a small third-party package |
| C | XChaCha20-Poly1305 (`@noble/ciphers`) | as A or B | Ed25519 | an audited JS library on every path |

**Recommendation: A** (SEC concurs). It adds no crypto dependency, the code is already reviewed by SEC, and keys can stay non-extractable. B's package joins the tests only, as an independent interop check.

**Sizes, pinned:**
- content key 32 B, nonce 12 B, tag 16 B;
- one HPKE-wrapped 32 B key: 80 B (enc 32 + key 32 + tag 16);
- Ed25519 public key 32 B, signature 64 B;
- a blob address 32 B.

**Browser floor:** Web Cryptography Level 2 specifies X25519 and Ed25519 with non-extractable private keys. Chrome has Ed25519 by default from 137, and Firefox has both from 130. The released Safari version is to be confirmed. The crypto-core PR keeps a runtime capability test, which is the real gate, and measures:
- the exact versions;
- raw-key import differences between engines;
- what an older browser shows: "this browser can't sync securely; update it or use the desktop app".

### 3.1 Objects and their keys

- **Documents, snapshots and index snapshots** each get a random 32-byte content key (CEK). It is stored wrapped, inside the sealed op or manifest that names the object, under `K_index[e]` or `K_wrap[e]`.
- **Blobs are encrypted deterministically within an epoch** (SEC), so dedup needs no key registry (§3.3).
- **Either way, a share hands over one object's key and nothing else** (§5).

### 3.2 Streaming: large objects in chunks (SEC's construction)

WebCrypto's AES-GCM takes whole buffers, so a large object is sealed in fixed, bounded chunks:
- **Chunks:** 1 MiB of compressed bytes each.
- **The nonce:**
  - for a document or snapshot, a random 64-bit prefix per object, plus a big-endian u32 chunk index;
  - for a blob, a per-chunk key with a fixed nonce (§3.3).
- **AAD binds:**
  - the protocol and version;
  - the account, the object and its version;
  - the chunk's index, the chunk count;
  - the total plaintext and compressed lengths, and each chunk's compressed length.

  So chunks can't be reordered, dropped, cut short or moved to another object.
- **Decompression is bounded** after authentication: an output-size and ratio limit, so a hostile blob can't exhaust memory.
- **This aligns with the chunked-files work** (the sync client's plan): the manifest of chunks is itself an encrypted object.
- **Chunk boundaries must not fingerprint content:** content-defined chunking (1 to 8 MiB today) would reveal a sequence of chunk sizes that identifies a known file, even with every chunk encrypted.
  - **Recommendation for v1: fixed-size chunks** (SEC): the whole file is compressed with the pinned codec, and the compressed stream is split into chunks of exactly 1 MiB (the last one shorter).
    - The server then learns only the total compressed length.
    - Compressing each plaintext chunk separately would leak every chunk's compressibility, which is itself a fingerprint.
    - This matches the streaming construction, and keeps keyed chunking's implementation and proof out of the cutover.
  - Keyed content-defined chunking (the gear table derived from `K_blob[e]`) can come later, as a measured optimization for dedup across small edits.

### 3.3 Blob addresses and dedup within an account

- **The device keeps plaintext SHA-256 locally,** as today. The local blob store, a write's `base` compare-and-swap and the reducer all keep using it.
- **At the wire boundary, one function:** `wireAddress(sha) = "a1:" + hex(HMAC-SHA256(K_addr[e], "sagebrush.blob.v1" ‖ sha))` (the sync client's proposal). The `a1:` names the address scheme's version (§11.5).
  - The server keys holdings by that address.
  - It checks the uploaded ciphertext's declared `ct_sha256`.
- **Deterministic blob encryption** (SEC): any device holding the epoch derives a blob's keys from the plaintext's hash, so two devices racing to upload the same file produce the same ciphertext, and no "winning key" has to be found. A random key per upload would need a serialized key registry, which is more complex and race-prone.
  - **The codec is pinned and is part of the blob's format:** one compressor implementation and version, deterministic by construction.
    - It is our own vendored implementation, not the browser's CompressionStream, whose output can differ between browsers and versions.
    - Changing the codec bumps the format version, and with it the key derivation.
  - **A file key, then chunk keys** (SEC):
    - `K_file = HKDF(K_blob[e], "sagebrush.blob.file.v1" ‖ sha ‖ codec)`;
    - `K_chunk = HKDF(K_file, "sagebrush.blob.chunk.v1" ‖ chunk index)`.

    `K_file` opens exactly that blob and nothing else, so a share hands over only `K_file` (§5). `K_blob[e]`, which opens the whole epoch, is never handed out.
    - The nonce is fixed (zero). That's safe only because each key encrypts exactly one chunk: the pinned codec makes the compressed chunk a function of `(sha, codec, index)`.
    - **AAD binds:**
      - the protocol, the account, the address and the codec;
      - the chunk count, the total plaintext length and the total compressed length;
      - this chunk's index and its compressed length.

      The whole file is compressed once and split afterwards, so a chunk has no plaintext length of its own. The blob's manifest binds the same totals, signed.
  - **The invariant:** a chunk key is used for one chunk's bytes only. It rests on the codec being deterministic, which the blob format's tests check across engines (the same input gives byte-identical output). A mutation test checks the derivation's inputs, not collision-freedom.
  - **Two codec versions at one address:** they derive different keys, and the envelope names its codec, so any device can open whichever version the server holds. The first upload for an address is kept, and a device that sees an older codec there re-encrypts only if asked.
- **The index records each blob's epoch, address and codec.** Its keys come from that epoch's secret, which every current device holds through the keyring (§11.2).
  - **Dedup across epochs, within the account:** the device keeps plaintext hashes locally. A file whose hash its index already knows references the existing blob at its recorded address, instead of being uploaded again.
  - **What that shows the server** (SEC): a new op referencing an older epoch's address reveals that the content equals an earlier blob's, across epochs. The server already sees the ref graph; this is stated, not hidden.
  - Only bytes that the index no longer names (deleted, then released) are uploaded again under the current epoch.
- **Releasing blobs safely** (SEC): the refs that signed envelopes add and release must not let a stale, concurrent client free a blob that is still referenced elsewhere.
  - So physical deletion waits for a grace window **and** a signed, client-made compaction checkpoint covering the release.
  - Until those exist, physical garbage collection of file blobs is deferred: released blobs are kept and counted. That is the simplest safe start, and its cost is bounded by the quota.
  - **Index pages are the exception, and its first user:** a page belongs to the checkpoint that wrote it, and is freed once a newer signed checkpoint covers it and the grace window has passed. That lands with the paged index (PR 5), since otherwise every re-sealed page would grow the quota with no bound (§11.4).
- **What the server learns:** equality of plaintext within one account and one epoch, and across epochs where an old blob is referenced again (above). Never across accounts.
  - A new epoch gets a new `K_addr` (SEC), so a removed device can't test the addresses of new uploads. Equality across epochs is visible only where a device deliberately references an old blob (above).
- **Hashing compressed bytes instead** (SEC's variant) was considered. Plaintext is used because two browsers' compressors can differ, which would break dedup without adding privacy. SEC to confirm.
- **The cost:** cross-account dedup is lost, measured in §9.

### 3.4 Wrapping keys: HPKE bound to its context (SEC)

RFC 9180's base mode doesn't authenticate the sender and doesn't prevent replay. So every wrapped key (an epoch secret for a device or the recovery key, a share's `SK`, a proposal's key, a support bundle's key) is used only inside a signed context:
- **HPKE's `info`** is a domain-separated, canonical encoding of the wrapper's whole context, including its wrapper id:
  - the protocol and version, and the purpose (epoch delivery, recovery, share, proposal, support);
  - the sender's account and signing-key id;
  - the recipient's account and key id (a device, the recovery key, or an inbox key);
  - the object, share or proposal id, the epoch, and any expiry.
- **An outer envelope signs** that context, the encapsulated key `enc` and the ciphertext, with the sender's Ed25519 key.
- **The recipient checks:**
  - the signature, against the sender's pinned chain;
  - that every field names itself and the object it expects;
  - the expiry.

  So a valid wrapper can't be replayed in another context, or moved between accounts, shares, recovery and epoch delivery.
- **An exact replay in the same context isn't stopped by the binding** (SEC). So every wrapper also carries a unique **wrapper id** (128 random bits), inside both the canonical `info` and the outer signature.
  - Recipients record the wrapper ids they have processed, and refuse a repeat. That covers epoch and recovery delivery, shares, proposals and support bundles.
  - Each action is idempotent too (installing an epoch secret, importing a share, applying a proposal), so a repeat that slipped past the record would change nothing.

## 4. Sync: what becomes opaque

(From the sync client's and the sync documents' owners.)

| | Today (a) | Under E2E |
| --- | --- | --- |
| File and document bytes, patches, snapshots | opaque bytes; the document object never parses payloads (web/sync/doc.ts) | ciphertext, under each object's key (§3.1) |
| Index ops (path, kind, size, fid, sha256, base, parent) | plaintext; the server rebuilds a derived index after acceptance | sealed under `K_index[e]` and signed by the device; visible: `{dseq, size, refs added, refs released}` |
| Blob names | plaintext SHA-256 | `wireAddress` (§3.3) |
| Quota | holding and document sizes | ciphertext bytes, as now (quota already uses sizes only) |
| Agent scope, `list`/`stat` | the server's derived index | a device acting for the agent (§6) |
| Grants and the access log | each grant's scope paths, and every agent call's paths, in plaintext (account.ts `grants.scopes`, `access_log.paths`) | scopes sealed to the devices, which enforce them; the server keeps only the grant id, token hash, tag, rates and expiry. The access log is written by the answering device, encrypted (or with paths HMACed under `K_index[e]`) |
| Version retention, Trash | every file blob an op names is held until the account is purged; version retention is client-side (IndexedDB), and the server enforces no version cap | explicit client ops; the server counts the refs each envelope adds and releases. Physical GC stays deferred (§3.3), as it effectively is today |

**What changes in the server:**
- `checkOp` becomes form-only. The server still checks the signature, `dseq` order, envelope size, and that every added ref is a held blob.
- **Clients verify too, not just the server** (SEC). Each client checks every op it applies:
  - its signature;
  - that its device was authorized at that point in the key chain;
  - its epoch;
  - its `dseq` and the previous envelope's hash;
  - the commitments to its ciphertext and refs.

  A server that skips its own checks can't slip an op past a client.
- `indexApply` and the derived index (entries.ts) leave the Worker. The index bounds become log caps.
- **Rejection must be deterministic:** a rule every client applies identically, with a fuzz test that two clients reducing the same log always agree, as they already must.
- **A new device** starts from a client-made, encrypted **index snapshot** at a `seq`, plus the sealed ops after it, so the server can drop older ops.
- **The server can no longer keep an overwritten blob as a version on its own.** The device that writes, including one writing for an agent, sends the retention op.
- **Documents:**
  - the document object stores and serves batch bodies without parsing them (it parses only the envelopes), and "Clear history"'s root is client-made, so both carry ciphertext unchanged;
  - segments and exports (sync-server.md) aren't built, and will be designed sealed;
  - "Download my data" needs a device to decrypt.

### 4.1 Signed envelopes and checkpoints (SEC)

- **Canonical bytes:** every signed or hashed structure (op envelopes, chain entries, wrappers, manifests, proposals, checkpoints) is encoded with the fleet protocol's canonical JSON rules (sorted keys, integers only, no duplicate keys), and signed over a domain-separated prefix, `sagebrush.e2e.<kind>.v1\n`, as the fleet's signed bytes are.
- **The log is hash-chained:** each accepted op envelope carries the previous envelope's hash in the account's server-ordered log. The log root at `seq` n is the hash of root n-1 and envelope n.
- **A checkpoint** is the key chain's head plus the log root and its `seq`.
  - Every device stores its latest verified checkpoint.
  - Every index snapshot and document snapshot binds the account, the protocol version, and the checkpoint it was made at.
- **A signed op's context** binds the account, the protocol, the epoch, the device, its `dseq`, the previous hash, the ciphertext hash and the visible refs.
- **A device verifies every envelope from its last trusted checkpoint onward:**
  - the signature;
  - the device's authorization at that chain state;
  - the epoch;
  - the previous hash and `seq`;
  - the ciphertext hash, the visible refs and all AAD.

  A log that doesn't extend its checkpoint's root is refused as a fork. That holds even at the same length, which a highest-`seq` check alone would miss.
- **Removed devices** (SEC): each op commits to the exact key-chain head that authorized it. Once a removal is in the chain, the server and every client refuse an op authorized at a head from before the removal, even if it is validly signed and its device's `dseq` is next.
  - **The limit:** a malicious server can withhold a signed tail or fork made before the removal from a client that has no later checkpoint. It is detected only once that client sees a checkpoint past it.

**What the server still sees (metadata):**
- the account hash, device ids, IP addresses and online times;
- the count, timing and ciphertext size of ops, batches and blobs;
- per document:
  - its kind (notebook, board or chat), bytes, created time and epoch;
  - each patch's `cseq`, `id` (a millisecond time: edit timing), `parents` (the graph's shape), size and blob refs;
  - each batch's author and device;
- **presence:** each device's presence messages are relayed as they are today, so their timing and size per device are visible. Their `state` is sealed under the document's key (PR 4);
- each batch's `writer`, and the `clients` table's `(client, writer, last_id)`, beside its author and device;
- blob equality within an account and epoch;
- which shares exist, between which account hashes (§5), and so who sends to whom;
- opaque document identifiers and counts, and the stable graph of which ops and patches reference which blobs;
- access patterns: which blobs and documents are fetched, when, and how often, plus traffic volume and frequency;
- the key directory and the key chain: device additions and removals, epochs, and key rotations.

An encrypted index doesn't hide these correlations.

**What doesn't leak:**
- **Document ids are random** (a UUID or 12 hex), so their form carries no path.
- **R2 object keys** are `s/<account hash prefix>/<random>`, so storage reveals only the account prefix.

**Index ceilings** (design/fs-sync-scale.md's `workspace_entries` and `folder_entries`) count entries on the server today. They become a count of opaque entries, or are enforced by clients.

**Admin views** after the switch show account and billing data and sizes. They never show titles, paths or content of private data (the sync documents' owner).

Sizes aren't padded to buckets (decided, §10 Q5): exact ciphertext sizes stay visible, and the threat model says so.

## 5. Shares, proposals, public publishing, support

- **A private share to a person:**
  - **The snapshot:** the sender makes an encrypted manifest `{format: "sagebrush-share", v: 1, title, created, parent, files: [{path, address, codec, size, key}]}` under a fresh snapshot key `SK`.
    - `parent` chains versions, as collections' manifests already do.
    - The bytes aren't uploaded again: each file's `K_file` is handed over (§3.3). It opens that blob only, never the epoch. The share's grant lets the recipient read those blobs.
  - **Delivery:** `SK` is HPKE-wrapped to the recipient's inbox key. The sender's device signs the manifest.
  - **Import:** "Copy to my workspace" decrypts, then encrypts under the recipient's own keys, all client-side.
  - **The share pins its blobs:** it holds its own durable references, so the sender deleting files or compacting history can't destroy the copy before the recipient imports it. They're released when the share is revoked or expires.
  - **Revoking a share stops future retrieval only.** A recipient who already downloaded it keeps what they have.
- **A link share:** `SK` travels in the URL fragment (`/s/<id>#k=…`), which browsers never send to the server.
  - The files origin serves ciphertext by `<collection>/<address>` as today: attachment, `nosniff`, sandbox CSP, CORS + CORP.
  - The page decrypts.
  - **The page clears the key at once,** before any other app work: it imports the fragment key, then removes it from the address bar and history (`history.replaceState`).
  - The page loads no third-party resources, and no analytics or crash report carries its URL.
  - **Anyone who copied the link keeps the capability.** Revoking stops future retrieval from the server; it can't erase a downloaded key or plaintext.
  - An encrypted link share's preview is the generic card, because the server doesn't know the title (decided, §10 Q7).
- **Proposals:**
  - **The format:** a canonical, signed envelope `{proposal id, target owner and inbox-key id, share or snapshot id, base manifest hash, result manifest hash, expiry, ops}`, with the ops bounded in size. It is encrypted and wrapped to the owner's inbox key (§3.4).
  - **Checks:** the owner's client verifies the proposer's signature against their currently pinned chain before showing the proposal, and refuses it once expired.
  - **Applying it:** the owner's client checks the base, applies the diff with merge3, and shows a per-file accept or reject before anything is kept, as agents' branches and Delegate tasks already do in the workspace.
- **The public-key directory:** each account publishes its inbox and signing public keys, signed under its key chain.
  - **TOFU:** a sender pins them at first use and shows their fingerprint (20 base32 characters, as the fleet's).
  - **A change** is a loud warning that can't be clicked through without comparing fingerprints.
  - **Inbox records expire after 30 days,** and a sender refuses an expired one. That bounds, but doesn't remove, the window in which a withheld rotation sends a new share to a removed device's old key (§2).
  - **The limit:** TOFU can't stop a substitution at first use. TOFU with loud warnings is v1, and a transparency log or device gossip comes later (decided, §10 Q6).
- **Grading is class work, not a share between people:** an LTI-launched assignment lives in the class store, and its grade or link goes back through the LMS (§5.2).
- **Public publishing is an explicit step:** "Publish publicly" decrypts on the device and writes **separate plaintext objects**, which is today's collections, unchanged. They are never the private holdings, and never made from synced server bytes. The dialog says that anyone, including the server, can read them. D1's `versions.title` is written only for public shares.
- **Support bundles:**
  - the person picks the files from an explicit manifest;
  - the client encrypts them to a **per-ticket support X25519 key**, which must itself be authenticated (SEC):
    - a **support root public key** is pinned in the client's code (and in the signed desktop app);
    - each ticket's key comes in a record signed by that root, binding the ticket id, key id, purpose ("support bundle") and expiry;
    - the client refuses a key without a valid record, and binds the record through HPKE's `info` and the signed envelope (§3.4).

    So a changed Worker can't substitute its own key and turn a support export into exfiltration. On the web, a compelled origin could still serve a client with another pinned root: §8's limit applies here too;
  - the bundle has an expiry and can be revoked. **The limit:** expiry and revocation stop future downloads, and the key's use through the service's own protocol. They don't stop a support recipient who already decrypted or kept the bundle, just as removal doesn't stop a removed device;
  - support decrypts it in its own tool. There is no ambient access.

### 5.1 Live collaboration is replaced

design/workspace-files.md §7.9 and "Phase 3: collaboration" (one document written by several accounts, editors and viewers, presence), and sync-server.md's `acl(account, role)` for phase 3, contradict "never a shared live document".

None of the cross-account part is built: documents' access lists are owner-only today. Presence among one's own devices is built, and is sealed in PR 4. The designs are rewritten as copy plus proposals (§7, PR 0).

### 5.2 Class work: an explicit exception

Assignment files launched from a school's LMS (LTI) aren't end-to-end encrypted. The school is the data controller for them, as it is for any LMS submission, and FERPA may require the school to be able to get at a student's work.
- **The class store:** the files live in a store the server can read, filed under (course, assignment, student).
- **Identity comes from the LTI launch, and only from it** (SEC):
  - the (course, assignment, student) tuple is derived only from the verified launch's immutable claims: the platform and deployment, the context, the resource link and the learner's subject;
  - **access:** a learner reaches only their own rows; an instructor or grader reaches only the rows of the context and resource the launch names; any other tuple is refused;
  - only an authenticated launch enters class mode, which stays labelled for as long as the file is open. **A file is never silently moved out of end-to-end encryption.**
- There is no sync and no recovery code for class work.
- **Saving and resuming:** partial work saves to the class store. Relaunching the assignment from the LMS on another computer resumes it.
- **Submitting** sends the grade, or a link, back through LTI Assignment and Grade Services. The instructor and graders read the file in the class store.
  - **Delivery is bound** to the verified platform, deployment, context, resource link and learner.
  - **A link requires authentication.** It's never a durable bearer URL to plaintext.
- **Said plainly:** the editor shows that a file is class work and is not end-to-end encrypted.
- **A copy into the student's own files** is the student's, and is end-to-end encrypted like anything else they own.
- **Gates before any build** (SEC):
  - launch replay prevention: each launch's nonce is used once, within its validity;
  - tenant and course isolation: no row is reachable across platforms, deployments or contexts;
  - deletion and retention enforced, by rules set before any class-store build (§10 item 11).

  Q10 (who may read, and how long the store keeps it) must be answered before any class-store code is built.
- **The threat model differs:** a breach, an insider or a legal demand can read class-store files, as with the LMS itself. **The server, or an insider, can also alter, delete or roll back class work, and could change a grade it sends through AGS.** Nothing in this design detects that (§8).

## 6. Agents

- **An Autonomous VM is a full, trusted device.** It is added through the same approval as any device and holds `S[e]` on the person's machine. It syncs and decrypts like a browser.
- **The person's own agents on their own computer** (the sagebrush CLI, the MCP adapter, the desktop app) also become devices.
- **Scope is about behavior, not confidentiality** (SEC). A device holding `S[e]` can read every object in that epoch.
  - A grant's scope is enforced by the device acting for the agent: it controls what the agent does, not what that device could read.
  - **No per-folder keys** (decided, §10 Q4: "it's already complicated enough"): agents are full trusted devices in v1.
- **The agent endpoint** (design/agent-endpoint.md), for an agent holding only a grant token:
  - the grant token, its tag and its rates stay on the server;
  - **every verb relays to an online device** of the person's (an open tab, the desktop app or an Autonomous VM), which decrypts, checks scope (`inScope`, and the Trash visibility rule for grants, `trashVisible`) and answers, as runs are designed to (agent-endpoint.md §6; not built yet);
  - the document verbs aren't built yet (only `list` and `stat` answer today, from the derived index), so nothing is lost by making them relay-only from the start;
  - with no device online, the endpoint queues the request opaquely and answers "waiting for one of your devices". It never decrypts.
### 6.1 Autonomous VM custody (SEC)

An Autonomous VM is a full account device, so whoever controls the VM controls its keys: the cloud provider, a root compromise, a disk snapshot, or a clone of its image. They can take its device keys and every epoch secret it holds.
- **Unique enrollment:** each VM enrolls with keys made on that VM. An enrolled image is never cloned or reused. The agent's provisioning makes a fresh VM enroll afresh.
- **Unattended custody:** a VM runs with no person present, so its keys can't wait for a human to unlock them. That's the tradeoff of running an agent unattended, and the enrollment dialog says so.
- **Deleting a VM removes it from the chain** (a new epoch). Removal protects only later epochs.
- **A cloned key can't be made harmless.** Whoever holds a copy of the VM's signing key can read the log's head, continue its sequence, and make valid ops as the VM until the VM is removed. That's not detectable as a fork.
  - Only concurrent, divergent use is detected: two envelopes from one device with the same `dseq` or previous hash. Clients refuse that fork, the device is removed, and its signing key is never accepted again.
  - Unique enrollment prevents deliberate reuse of an image. It can't make a snapshot or a clone harmless.

- **Agent logs and the relay to your own computers** are under end-to-end encryption too (decided, §10 Q8 and Q9): §6.2.

### 6.2 Agent logs and the relay to your own computers (decided, §10 Q8 and Q9)

**Agent logs are private synced data** (William: "make sure the encryption plan fully addresses agent logs, and also Sagebrush remote proxying").
- **Today:** the log mirror (web/cloud/mirror) seals each segment under an account data key that is wrapped by a key-encryption key held in a Worker secret. So the server can read every log.
- **Under E2E:**
  - each conversation's mirror gets a random CEK, wrapped under the current epoch like a document's (§3.1), and recorded in the sealed index;
  - **segments are sealed by the writing device,** which must be an enrolled device (the page, the desktop app, the CLI or an Autonomous VM, §6). The server stores and serves opaque segments, as it does document batches;
  - the segment format keeps its header as AAD (version, the conversation's locator, the segment id, both ranges, the previous segment's digest). The visible key id names the epoch and the **CEK id**, never the CEK itself;
  - **a key per segment, not a shared nonce space** (SEC): `K_seg = HKDF(CEK, "sagebrush.logseg.v1" || format version || canonical segment id)`, with a fixed nonce, as for blob chunks (§3.3). The canonical segment id is, in a pinned encoding, the conversation locator, the writer's device id, its sequence number and a **fresh random 128-bit segment key id**. The key id is drawn from a CSPRNG for every sealing, and is separate from the ordering fields (sequence and previous digest). So two segments never share a key, even when one device seals two forked segments at the same sequence number (after a crash, or from a cloned VM), and no random-nonce bound is needed. The key id is visible in the header and bound as AAD;
  - **each segment is signed by its writer** (SEC), since a CEK alone would let a removed device that kept it forge later segments. The signature covers the protocol, the account, the conversation's locator, the writer's device id, the authorizing chain head and epoch, a **conversation sequence number** that rises by one per segment, the previous segment's digest, the CEK id, the segment key id and the ciphertext's hash;
  - **readers verify** that the writer is a current device at the authorizing head, that the epoch isn't older than that head's (§4.1's rule), and that the sequence and previous digest continue the chain. Two different segments with the same sequence number or previous digest are a fork: readers refuse both branches past the fork point, as for sealed ops, and show the conversation as forked;
  - **removed devices, exactly as §4.1** (SEC): each segment commits to the chain head that authorized it. Once a removal is in the chain, the server and every reader refuse any segment authorized at a head from before the removal, even if its CEK, signature and sequence are all valid. §4.1's limit (a withheld pre-removal tail) applies unchanged;
  - **after a device removal,** the next segment also starts a new CEK under the new epoch, so a removed device can't read later segments either. The new CEK alone doesn't stop appends; the rule above does;
  - **appends are an atomic compare-and-swap** (SEC), in the conversation's server object. The server accepts a segment only if its sequence is the conversation's next, its previous digest is the current tail's, its authorizing head is the current chain head, and its CEK id is the conversation's current one. Otherwise it refuses and returns the current tail. The first honest writer wins; a stale writer reloads, reseals under a fresh segment key id, and retries. So two honest writers never fork the conversation; only a malicious server can, and readers catch that with the fork rule above;
  - **the server-held key-encryption key is retired.** Existing DEV mirrors are wiped with the other synced data at the cutover (Q1).
  - **tests:** a race row, where two honest writers append at the same sequence: one wins, and the other reseals and lands next. A mutant per compare-and-swap condition (sequence, previous digest, authorizing head, CEK id), each omitted, must let a race or a post-removal append through and fail a test. A segment authorized at a pre-removal head is refused. Two segments sealed by one device at the same sequence number get different keys, and both decrypt and verify on their own until the continuity rule refuses the fork; a header edited after sealing, including its key id, fails to decrypt.
- **What the server still sees:** each segment's size and timing, and the header fields kept visible for ordering: the conversation locator, the segment id and the ranges. They're listed with §4's metadata.
- **What's lost:** anything that read logs on the server (search, previews) runs on a device instead.

**The relay to your own computers goes end to end** (decided, Q9).
- **Today:** a computer connected with `sagebrush remote login` registers a public key with the server. Its terminal and agent traffic passes through Sagebrush's relay, encrypted to the server but not end to end. So the relay sees what you type, what the computer prints, and what an agent reads and writes there.
- **Under E2E:**
  - **the connected computer becomes a device, through the ordinary add-device ceremony** (§2): `sagebrush remote login` shows a QR or short code that a current device confirms, or takes the recovery code. Server registration alone never makes a computer trusted. Its chain entry gives it the role "computer" and a dedicated Noise static key, separate from its HPKE key. Its epoch secret is wrapped to it only if it also syncs files;
  - **page and computer run Noise_IK_25519_AESGCM_SHA256 through the relay** (SEC). The fleet channel's Noise_IK uses ChaCha20-Poly1305, which WebCrypto lacks, and runs only in Node, so the page can't reuse it as is. The AES-GCM suite runs on WebCrypto's X25519, AES-GCM and SHA-256, with no new dependency. The handshake pattern is ported from the fleet channel, but that isn't a claim of reuse: the page's implementation is new code and is tested on its own:
    - the published Noise test vectors for this suite;
    - interop vectors between the page (WebCrypto) and the computer (Node), in both roles;
    - the suite is pinned in the protocol version;
  - **both ends verify the current chain:** the page checks that the selected computer's static key is current, and the computer checks that the page's is. Either refuses a removed device;
  - **the Noise prologue is canonical** and binds "sagebrush.remote.v1", the account, both device ids and static public keys with their roles (page as initiator, computer as responder), the computer the person selected, the chain head each side verified, and a fresh session id. A mismatch on either side fails the handshake;
  - the relay forwards opaque Noise messages. It never holds a session key. A key change is a chain entry, never a silent server-side update;
  - **the rollback limit:** a server can show either end an older valid chain head, where a removed device is still current. Each end refuses a head older than its last verified checkpoint (§4.1), so this only works against an end that hasn't yet seen the removal; it's §2.1's fork limit.
- **What the relay still sees:** which page talks to which computer, when, and how much (message sizes and timing). Not the content.
- **Agents through the relay** (agent endpoint, §6) ride the same Noise session, so the relay never sees their reads and writes either.

## 7. Migration and the order of PRs

**Decided (§10 Q1): DEV synced data is wiped and re-enrolled** at the cutover, since sync is DEV-only. There is no migration.

| # | PR | What it changes |
| --- | --- | --- |
| 0 | docs and the decision | rewrite workspace-files §7.4 and §7.9, sync-server §10, agent-endpoint §4 and §9, web/docs/storage.md and sharing.md, and PRODUCT.md; remove phase-3 live collaboration (the sync documents' owner offers to draft these) |
| 1 | crypto core in web | port the fleet core's HPKE, strict Ed25519 and fixtures (shared with the page's fleet verifier); add the chunked AEAD (§3.2), the HKDF labels, an `@hpke/core` interop test, and the browser-floor check |
| 2 | keys and devices | epochs, device enrollment (QR or short code), the recovery code, the key chain, and the Settings UI. The desktop app gains `keyring`. No sync change |
| 3 | blobs | `wireAddress`; the pinned codec, then deterministic chunked AEAD with per-chunk keys; every table keyed by address instead of plaintext sha256 (holdings, pins, `files`, doc.ts `releases`, account.ts `reservations` and `finalized`; `ops.sha256` until PR 5 seals it), checking `ct_sha256`; physical GC deferred (§3.3) |
| 4 | document payloads | patches and the Clear-history root encrypted, and presence `state` sealed (sync carries no outputs). Small: doc.ts never parses a body (moved ahead of sealed ops, as the sync documents' owner recommends) |
| 5 | sealed ops | sealed, signed op envelopes with visible ref adds and releases. The Worker loses `indexApply` and entries.ts, gains log caps, and keeps a form-only `checkOp`. Ops are **sealed at send time, not when queued**: a device that sees a newer chain head re-seals its unsent records under the current head and epoch, keeping their `dseq`s, so no `dseq` is burned by a refusal. Client-side index snapshots, paged (§11.4), recording each blob's epoch, address and codec (§3.3); retention and Trash as client ops; the two-client agreement fuzz test |
| 6 | the agent endpoint | relay to an online device; Autonomous VMs, the CLI and the desktop app as devices; grant scopes sealed to devices, and the access log written by devices |
| 7 | chunked files | encrypted chunk manifests (with the chunked-files work) |
| 8 | shares | private shares, link-fragment shares, proposals, the key directory and its warnings; decrypt-and-publish into the existing collections |
| 9 | support bundles | per-ticket key, with expiry |
| 9b | agent logs and the relay | mirror segments sealed by devices under per-conversation CEKs, the Worker KEK retired; connected computers certified in the chain; Noise_IK through the relay |
| 10 | the cutover | the server refuses plaintext ops and unkeyed addresses; a check that no table column or log line holds a plaintext sha256; DEV is wiped and re-enrolled |
| 11 | signed releases | a release manifest signed with a release key, a public append-only log, and checks in the desktop app (its own design) |

Each PR gets SEC review, rows and mutants. PRs 0, 1 and 2 can start at once. The sync PRs follow the sync owners' order: small, already-opaque payloads first, then the big sealed-index change.

## 8. Threat model

| Who | Can learn | Can do | Can't |
| --- | --- | --- | --- |
| A breach of storage (R2, Durable Objects, backups) | metadata (§4) | nothing useful without keys | read content, paths or names |
| An insider at Sagebrush or Cloudflare, or a legal demand | metadata; that shares exist, and their sizes | delete or withhold data; **compel the service to serve a web session JavaScript that takes plaintext** the next time a person opens the web app (the malicious-origin row) | decrypt stored data from the service-side copies alone |
| **A malicious server** (changed Worker code) | metadata | omit, delay, roll back, or show devices different histories (equivocation); withhold an inbox rotation from senders, up to the record's validity (§2) | forge or alter ops, chain entries or shares, since they are signed |
| **A malicious origin serving the web app** | everything a page can read | ship JavaScript that uses the keys while the page is open, and sends plaintext away | — this is the limit of end-to-end encryption in any web app |
| A stolen unlocked device | what that device can decrypt | act as the person until it's removed | read what is written after its removal |
| A breach, an insider or a legal demand, for class work (§5.2) | the class-store files themselves | read them, as with an LMS submission; the server or an insider can also alter, delete or roll back them, and change a grade sent through AGS | — this is the stated exception |
| Every device and the recovery code lost | — | — | the person's data can't be recovered by anyone |

**Integrity, plainly (SEC):**
- **What's detected:**
  - device-signed, hash-chained envelopes detect alteration, and gaps in one device's sequence;
  - a device's remembered checkpoint (the chain head, the log root and its `seq`, §4.1) detects a rollback, or a fork of the same length, against what that device saw.
- **What isn't detected:**
  - a substitution at first use;
  - an omission;
  - equivocation between devices;
  - a rollback shown to a new or reinstalled device.

TOFU with loud key-change warnings is the v1 answer. Transparency or device gossip comes later. No server-signed "global head" solves this, and the design doesn't claim one does.

**The browser, plainly (SEC):**
- **Protected:** browser E2E protects stored data against a breach, an insider, or a demand for the service-side copies.
- **Not protected:** a page served by a compromised or compelled origin can use the keys while it's open, and send plaintext away. Non-extractable keys prevent exporting the raw key; they don't prevent using it, by such a page or by XSS.
- **The desktop app** runs signed builds that the server doesn't serve. It has the stronger boundary, and the design says so.
- **Signed releases with a public log are planned** (decided, §10 Q3; William is "very interested"):
  - every web release's files are hashed into a release manifest, signed with a release key and appended to a public, append-only log;
  - the desktop app, and a verifier extension, can check that the page they run is a logged release;
  - it narrows the malicious-origin limit for people who check, without removing it for those who don't. It gets its own design, listed as PR 11 in §7.

## 9. Cost: measuring the dedup loss on DEV

This needs DEV read access, and aggregate numbers only:
1. From DEV's sync account objects (holdings by sha256) and sharing's D1 holdings, count:
   - total bytes;
   - bytes after per-account dedup (what's stored now);
   - bytes after cross-account dedup.

   **The loss** is the difference between the last two.
2. **Epochs:** model the loss across epochs, using how often devices are removed (assume once a year, and say so).
3. **Compression:** deflate a sample of blobs, by type (notebooks, CSV, images, PDFs, wasm), and report the ratio. Text gains a lot; images and PDFs very little.
4. **Report the numbers, not the data.** The coordinator runs the read-only script with DEV access. r2 carries the result.

With a handful of DEV accounts, cross-account dedup is likely tiny. The measurement mostly sizes compression's gain and confirms that nothing depends on global dedup.

## 10. Decisions (William, Nov 23 2026)

1. **One mode:** "Yes, approve E2E as the one mode."
2. **DEV data:** wipe synced data and re-enroll at the cutover; no migration (§7).
3. **Recovery:** the recovery code only; no passkey (§2).
4. **The browser's limit (§8):** accepted, and the desktop app is recommended for the strongest guarantee. Signed releases with a public log are planned: "yes, yes and I'm very interested in signed releases" (§8, PR 11).
5. **Agents:** Autonomous VMs and agents are full trusted devices, with scope enforced by the acting device. No per-folder keys: "no; it's already complicated enough" (§6).
6. **Sizes:** no padding to size buckets (§4).
7. **Key transparency:** the recommendation, TOFU with loud change warnings in v1, and a transparency log or device gossip later (§5).
8. **Link previews:** encrypted link shares show the generic card (§5).
9. **Agent logs:** under end-to-end encryption, with Sagebrush remote proxying fully addressed (§6.2).
10. **The relay to your own computers:** under end-to-end encryption (§6.2).
11. **Class work (§5.2):** the exception is decided. Who may read class work beyond instructors and graders, and how long it's kept, must be set before any class-store code is built.

**Open:**

12. **Post-quantum (§11.1):** accept X25519 now, with a hybrid suite in a later epoch when WebCrypto has ML-KEM (recommended), or ship a hybrid KEM sooner as a small library?

## 11. Scale and later change (millions of files)

William asked for this review because a mistake found later, with millions of files per account, would be costly. Each finding is either fixed in the design or stated as a limit.

### 11.1 Crypto agility: no flag day

- **Everything is versioned:** every envelope (`v`, `alg`), key wrapper (HPKE suite ids in `info`), derivation (the `…v1` in every HKDF label), codec, chunk format, canonical encoding and checkpoint names its version.
  - **Every version field is bound** into what protects it: the signature's canonical bytes, AEAD AAD, HPKE `info` and the checkpoint. So a version can't be swapped without breaking the object.
  - A client refuses a version it doesn't know.
  - A new version is added beside the old, never in its place, and old ones stay readable.
- **Rotation is per epoch:** each epoch's chain entry names its suite (§2). A new suite starts at the next epoch, which any device can start: everything written afterwards uses it, and old data stays readable under its own suite.
  - Moving old data to a new suite is the explicit compaction of §11.2.
- **Rotating the long-lived keys themselves** (SEC): a suite change can't rotate device, recovery or inbox keys by naming a version.
  - **Signing keys rotate by cross-certification:** a device makes its new Ed25519 key. The old signing key signs a chain entry naming the new one, and the new key countersigns it.
  - **KEM keys can't sign** (SEC), so a new X25519 or ML-KEM key is bound through the signing chain:
    - the device's current signing key signs a chain entry naming the new KEM key;
    - **proof of possession** is separate, and not circular:
      - the **pre-entry hash** is the hash of the entry's body without its signatures or proof: protocol, account, predecessor hash, the key's owner and role, and the new public key;
      - the challenger (a current device) HPKE-encapsulates to the new KEM key, with `info` = "sagebrush.kem-pop.v1" and the pre-entry hash. The holder decapsulates and returns `MAC = HMAC(export(ss, "pop"), pre-entry hash || enc)`;
      - the challenger checks the MAC. The final entry carries `enc` and the MAC, and its signatures cover the pre-entry hash, `enc` and the MAC. Other devices verify the signatures; only the challenger could check the MAC itself.
  - **Who authorizes each:**
    - a device's own keys: that device;
    - **the recovery key** has both halves (§2): an Ed25519 key, which alone may sign a recovery (§2.1), and an X25519 key that epochs are wrapped to. Replacing it ("Replace recovery code") is authorized by a current device's signature. The new recovery Ed25519 key countersigns the entry, and the new recovery X25519 key proves possession as above, with that device as challenger. Both new private halves exist only transiently on that device, before the code is shown and discarded;
    - **the inbox key:** any current device (§2.1). Its KEM key is proven as above.
  - **A monotone policy:** the chain records the account's **minimum writer suite**. It can only rise. A client refuses to accept any new epoch, wrapper or entry below it, and refuses to write below it.
    - A downgrade can't be served, since the policy is in the signed chain that clients pin.
    - Withholding the upgrade entry ("freezing" a client) is bounded like any other withholding (§4.1, §8).
  - **Old clients:** a client that doesn't know the current minimum suite becomes read-only, and says an update is required. It never writes under a lower suite.
  - **Timing, stated plainly:** cross-certification must happen while the old primitive is still sound. Once it's broken, a signature under the old key proves nothing, and the new key can only be enrolled the way a new device is (§2), or through recovery.
- **Post-quantum, stated as a limit:**
  - X25519 (in HPKE and in device and inbox keys) can be broken by a future quantum computer. Ciphertext stored today, epoch secrets wrapped to X25519 included, could then be opened by whoever kept a copy.
  - AES-256 and HMAC-SHA256 hold up.
  - WebCrypto has no ML-KEM yet. A hybrid suite (X25519 + ML-KEM, for example X-Wing) comes in a later epoch through this agility, and protects only what is written after it.
  - Whether to ship a hybrid KEM sooner, as a library, is §10 Q12.

### 11.2 Many epochs: a keyring, not a cap (William's question)

**Recommendation, after SEC: no hard cap on epochs. Each new epoch carries an encrypted keyring of all earlier epochs' secrets, so epochs cost almost nothing as they accumulate. Moving data off old epochs is a separate, explicit compaction.**
- **Why not a cap:** a device removal starts a new epoch at once, and must never wait for a background job. So a cap of 10 could only be a target, and any cost claim of "at most 10" would be false. A low hard cap would block security rotations, and that can't be allowed.
- **The keyring:**
  - when epoch `e+1` starts, its signed chain entry comes with a **keyring**: `S[0..e]`, the earlier epochs' secrets (32 bytes each), encrypted under `S[e+1]`. **The keyring's hash is committed in that signed chain entry, and so in its checkpoint**, so a device refuses any other keyring for that epoch;
  - **the construction** (SEC):
    - `K_ring[e+1] = HKDF(S[e+1], "sagebrush.keyring.v1")`, a key used for this one keyring only;
    - AES-256-GCM with a fresh random 96-bit nonce;
    - AAD: the account id, the epoch `e+1`, the suite and format version, the predecessor chain entry's hash, and the ordered list of the epoch ids it includes;
    - the signed entry commits the hash of the whole ciphertext (nonce, ciphertext and tag), and a device checks that the decrypted list matches the AAD's;
  - devices and the recovery key are wrapped only `S[e+1]`. A device reading an old object opens the keyring, then uses that epoch's keys as written: addresses, blob keys, CEK wraps and sealed entries are all unchanged;
  - a removed device never gets `S[e+1]`, so it can't open the new keyring. It still holds whatever epoch secrets it had before, which is §2.2's unchanged limit.
- **What it costs:**
  - **adding a device or replacing the recovery code:** one wrap, for the current epoch;
  - **removing a device:** one new epoch, one wrap per remaining device plus recovery, and one keyring re-encrypted: 32 bytes per earlier epoch. After a hundred removals, that's about 3 KB;
  - nothing moves: no blob, index page or document is re-written, and nothing waits for a compactor.
- **Explicit compaction, kept for when it's wanted** (SEC): for example after a suspected compromise, or to move old data to a new suite. It moves content off old epochs, at O(N + B) cost (entries plus bytes):
  - **a blob moves** to a new address and new keys under the current epoch: download, decrypt, re-encrypt, upload. The index entries naming it are updated by signed compare-and-swap ops, and the old blob is released;
  - **each step is idempotent and resumable,** keyed by the blob's old address. A crash resumes at the first blob still on the old epoch;
  - **old keys are kept until a signed checkpoint proves coverage** (SEC). Before an epoch's secret is dropped from the keyring, a **coverage manifest** must account for every live reference to that epoch.
    - **Paged:** a million references can't fit in one signed object (64 KiB), so the manifest is a tree of encrypted pages. Its root is signed and bound to a checkpoint, and records per-kind counts and key ranges, so any page can be verified alone.
    - **The kinds:** index entries, retained versions, Trash, document CEK wraps, document snapshots and histories, index pages, share pins, support bundles and the inbox key's wrapper.
    - **Each reference ends in one of three states:**
      - moved to the current epoch;
      - released;
      - **independently decryptable without `S[e]`:** a completed share or support export holds the blob's exported `K_file` or its own wrapper, so it's a terminal external key, not a reference to `S[e]`. Only live pins are covered: the manifest lists the blobs those exports still pin, so they aren't released.
    - **Pending, unsent local ops aren't enumerated:** they're local state, not the server's. They are re-sealed under the current head at send time (§7, PR 5), or refused.
    - **Tests:** a mutation per kind (a reference omitted from the manifest) must stop the drop.
    - Devices verify the manifest's root and its counts before the keyring drops the secret.
  - **the limit, unchanged:** compaction protects old data only from someone who never had its old keys or ciphertext. **It isn't unlinkability either:** the server saw the old and new blobs, their sizes and the ref graph, and can link them.
- **What other devices see:** the keyring arrives with the epoch's chain entry. Old ops, entries and blobs keep their epoch, and an op sealed under an epoch older than the authorizing head is refused by §4.1's rule.

### 11.3 Every rotation at a million objects

| Operation | Cost | Bounded by |
| --- | --- | --- |
| Add a device | one wrap (the current epoch) | — |
| Remove a device | a new epoch: one wrap per remaining device plus recovery; the keyring re-encrypted (32 bytes per earlier epoch); the inbox key rotates | devices, and the epoch count (a few KB after a hundred removals) |
| Replace the recovery code | one wrap (the current epoch) | — |
| Explicit compaction (on request) | O(N + B): moved blobs re-encrypted and re-uploaded, entries updated by signed CAS ops, and a coverage manifest before any key is dropped | the person's choice; throttled and resumable |
| Rotate a suite | the next epoch; old data as it is | — |
| Full re-encryption of everything (on request only) | download, decrypt, re-encrypt and upload every byte: O(data size), and roughly double the storage until the old copies are released | the person's choice; it runs throttled and resumable, one blob at a time |

### 11.4 Index size and sync cost

- **The size:** at a million entries, an index entry is about 200 bytes (path, address, `K_file`, codec, size, times, ids), so roughly 200 MB of plaintext index, maybe a third of that compressed.
- **A single sealed snapshot doesn't scale:** every change would re-upload all of it, and a new device would download all of it before showing anything.
- **Fixed in the design: the index snapshot is paged, as a tree of encrypted pages** (about 1 MiB each, keyed by path order).
  - The snapshot's root is bound in the checkpoint (§4.1). Each interior page commits its children's hashes and key ranges, so a device can verify any page it fetches against the root, without fetching the rest. A change re-seals only the pages it touches, plus their path to the root.
  - A new device fetches the root and the pages it needs first, so a phone needn't fetch every page.
  - Page sizes are padded to the page size, so pages don't reveal folder sizes.
  - **Superseded pages are freed** by checkpoint-ordered GC (§3.3), so index churn doesn't grow the quota.
  - **A snapshot cadence:** a new snapshot is written after 10,000 ops or 4 MiB of sealed log since the last one, or at an explicit compaction. Small edits ride the sealed op log, and don't each re-seal 1 MiB pages.
  - The paged index is designed in the sealed-ops PR. Its first tests include a million entries.
- **The local index:** IndexedDB at a million entries is workable on desktops. Phones keep a partial index, through the same pages.

### 11.5 Limits that could force a migration later

| Limit | Value | Assessment |
| --- | --- | --- |
| **Today's index ceilings** | 100,000 entries and 100,000 documents per account, 10,000 entries per folder (sync's protocol limits); 500 ops per message, 2,000 a minute | **a million files is ten times past them.** Under E2E they count opaque entries, so the numbers carry over. Raising them is a limits change (with the separate safety ceiling the sync scale design already plans), paired with the paged index (§11.4) |
| Address and id forms | 64-hex addresses and `ct_sha256`; document ids (a UUID or 12 hex) | **fixed in the design:** an address carries its version, `a1:` + 64 hex, so a later scheme can share the holdings table with no flag day. The id forms are versioned the same way |
| Sealed metadata per batch | at most 8 blob refs per patch envelope, 2 MiB per message | sealing grows each envelope. The limits are re-measured in the sealed-ops PR |
| Chunk index | u32 of 1 MiB chunks: 4 PiB per file | ample |
| Chunk format | whole-file compression, then fixed chunks: reading part of a large file decompresses from its start | a later codec version can add restart points, through §11.1 |
| Sequence numbers (`seq`, `dseq`) | safe integers, 2^53 | ample |
| Signed structure size | canonical bytes up to 64 KiB per signed object (the fleet rule) | **each sealed op is signed on its own**, as §4's table has it; a message of up to 500 ops is transport, not one signed object. Index pages and snapshots are blobs, not signed objects |
| Log growth | the log root is a running hash, and ops before the latest snapshot are dropped | bounded by snapshot frequency |
| Epochs | no hard cap; the keyring grows 32 bytes per epoch (§11.2) | bounded by device removals; compaction is explicit |
| Wrapper ids, addresses, keys | 128 and 256 bits | ample |
| X25519 against quantum attacks | §11.1 | **the one limit agility can't fix for data already stored**: §10 Q12 |

---

*Inputs:*
- SEC (lead and second), in three rounds: key structure, recovery, HPKE context binding, checkpoints, VM custody, recovery, streaming, sizes, deterministic blobs and safe release, metadata, the integrity and browser limits, agents, shares and migration;
- the sync client's owner: blob naming, what the Worker reads, sealed ops, storage, the PR order;
- the sync documents' owner: document opacity, compaction, the metadata the document object sees, sharing's format, the live-collaboration designs that must change, client-side proposal models, and the docs to update;
- design/sync-server.md §1, §3, §4 and §10; design/workspace-files.md §7.4 and §7.9; design/sharing.md; design/agent-endpoint.md;
- sagebrush-agent's lib/fleet/core (HPKE, strict Ed25519, the device chain).
