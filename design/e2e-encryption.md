# End-to-end encryption for private synced data

*Status: draft design r2, for William's decision, with SEC review. r2 adds William's principle (Nov 23) and the class-work exception (§5.2); his answers to the other questions in §10 are folded in as they come. Nothing here is built. Sync, sharing and the agent endpoint are DEV-only, and no paying customer has data yet, which is why this is being decided now.*

## 0. The decision

Today private synced data is encrypted **at rest by Cloudflare** ((a), decided Oct 18: design/workspace-files.md §7.4, design/sync-server.md §10). The server, Cloudflare, an insider or a legal demand can read paths and content.

**Proposal: switch, before any paying customer, to one mode: end-to-end encryption for all private synced data.** Only the person's devices hold the keys. The server stores and orders ciphertext. There is one mode, not two.

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

Each section below gives the options, a recommendation, and what it costs. §10 lists the questions only William can answer.

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

  A passkey with the WebAuthn PRF extension as an extra unlock factor is §10 Q2.

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
- **New writes use the new epoch.** The live epochs are bounded by retiring old ones, which carries their keys forward in the index with no blob re-upload (§11.2). Old objects keep their keys unless the person asks for a background re-encryption.
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
- **At the wire boundary, one function:** `wireAddress(sha) = HMAC-SHA256(K_addr[e], "sagebrush.blob.v1" ‖ sha)` (the sync client's proposal).
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
- **The index carries each blob's key** (§11.2): a sealed index entry holds the blob's address, codec and `K_file`. So a device reads any blob from the index alone, whatever epoch wrote it, and an old epoch's secret is needed only until its entries are carried forward.
  - **Dedup across epochs, within the account:** the device keeps plaintext hashes locally. A file whose hash its index already knows references the existing blob, under the entry's recorded address and `K_file`, instead of re-uploading it. The server sees that reference, as it sees the ref graph already.
  - Only bytes that the index no longer names (deleted, then released) are uploaded again under the current epoch.
- **Releasing blobs safely** (SEC): the refs that signed envelopes add and release must not let a stale, concurrent client free a blob that is still referenced elsewhere.
  - So physical deletion waits for a grace window **and** a signed, client-made compaction checkpoint covering the release.
  - Until those exist, r1 defers physical garbage collection: released blobs are kept and counted. That is the simplest safe start, and its cost is bounded by the quota.
- **What the server learns:** equality of plaintext within one account and one epoch, never across accounts.
  - A new epoch gets a new `K_addr` (SEC), so a removed device can't test the addresses of new uploads. Dedup across epochs comes back only through the index's own hashes (above).
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

Size padding to buckets would hide exact sizes, at a storage cost: §10 Q5.

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
  - An encrypted link share's preview is the generic card, because the server doesn't know the title (§10 Q7).
- **Proposals:**
  - **The format:** a canonical, signed envelope `{proposal id, target owner and inbox-key id, share or snapshot id, base manifest hash, result manifest hash, expiry, ops}`, with the ops bounded in size. It is encrypted and wrapped to the owner's inbox key (§3.4).
  - **Checks:** the owner's client verifies the proposer's signature against their currently pinned chain before showing the proposal, and refuses it once expired.
  - **Applying it:** the owner's client checks the base, applies the diff with merge3, and shows a per-file accept or reject before anything is kept, as agents' branches and Delegate tasks already do in the workspace.
- **The public-key directory:** each account publishes its inbox and signing public keys, signed under its key chain.
  - **TOFU:** a sender pins them at first use and shows their fingerprint (20 base32 characters, as the fleet's).
  - **A change** is a loud warning that can't be clicked through without comparing fingerprints.
  - **Inbox records expire after 30 days,** and a sender refuses an expired one. That bounds, but doesn't remove, the window in which a withheld rotation sends a new share to a removed device's old key (§2).
  - **The limit:** TOFU can't stop a substitution at first use. Transparency comes later: §10 Q6.
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
  - deletion and retention enforced, by the rules §10 Q10 sets.

  Q10 (who may read, and how long the store keeps it) must be answered before any class-store code is built.
- **The threat model differs:** a breach, an insider or a legal demand can read class-store files, as with the LMS itself. **The server, or an insider, can also alter, delete or roll back class work, and could change a grade it sends through AGS.** Nothing in this design detects that (§8).

## 6. Agents

- **An Autonomous VM is a full, trusted device.** It is added through the same approval as any device and holds `S[e]` on the person's machine. It syncs and decrypts like a browser.
- **The person's own agents on their own computer** (the sagebrush CLI, the MCP adapter, the desktop app) also become devices.
- **Scope is about behavior, not confidentiality** (SEC). A device holding `S[e]` can read every object in that epoch.
  - A grant's scope is enforced by the device acting for the agent: it controls what the agent does, not what that device could read.
  - Hiding files from an agent cryptographically would need per-folder keys, with no index key on that VM: §10 Q4.
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

- **Agent logs:** the cloud agent-log mirror (web/cloud/mirror) is encrypted under a key held in a Worker secret, so the server can read it. Whether agent logs count as private synced data is §10 Q8.
- **The relay to one of your computers:** web/docs/storage.md tells users it is "encrypted on the way but not end to end". Whether E2E covers it too is §10 Q9.

## 7. Migration and the order of PRs

**Recommendation: wipe DEV synced data and re-enroll** at the cutover, since sync is DEV-only. A shadow migration is the fallback if William wants DEV data kept (§10 Q1): upload a v2 copy, verify the ciphertext inventory, cut over atomically, then refuse plaintext.

| # | PR | What it changes |
| --- | --- | --- |
| 0 | docs and the decision | rewrite workspace-files §7.4 and §7.9, sync-server §10, agent-endpoint §4 and §9, web/docs/storage.md and sharing.md, and PRODUCT.md; remove phase-3 live collaboration (the sync documents' owner offers to draft these) |
| 1 | crypto core in web | port the fleet core's HPKE, strict Ed25519 and fixtures (shared with the page's fleet verifier); add the chunked AEAD (§3.2), the HKDF labels, an `@hpke/core` interop test, and the browser-floor check |
| 2 | keys and devices | epochs, device enrollment (QR or short code), the recovery code, the key chain, and the Settings UI. The desktop app gains `keyring`. No sync change |
| 3 | blobs | `wireAddress`; the pinned codec, then deterministic chunked AEAD with per-chunk keys; every table keyed by address instead of plaintext sha256 (holdings, pins, `files`, doc.ts `releases`, account.ts `reservations` and `finalized`; `ops.sha256` until PR 5 seals it), checking `ct_sha256`; physical GC deferred (§3.3) |
| 4 | document payloads | patches and the Clear-history root encrypted, and presence `state` sealed (sync carries no outputs). Small: doc.ts never parses a body (moved ahead of sealed ops, as the sync documents' owner recommends) |
| 5 | sealed ops | sealed, signed op envelopes with visible ref adds and releases. The Worker loses `indexApply` and entries.ts, gains log caps, and keeps a form-only `checkOp`. Client-side index snapshots, paged and carrying each blob's key (§11.4, §3.3); retention and Trash as client ops; the two-client agreement fuzz test |
| 6 | the agent endpoint | relay to an online device; Autonomous VMs, the CLI and the desktop app as devices; grant scopes sealed to devices, and the access log written by devices |
| 7 | chunked files | encrypted chunk manifests (with the chunked-files work) |
| 8 | shares | private shares, link-fragment shares, proposals, the key directory and its warnings; decrypt-and-publish into the existing collections |
| 9 | support bundles | per-ticket key, with expiry |
| 10 | the cutover | the server refuses plaintext ops and unkeyed addresses; a check that no table column or log line holds a plaintext sha256; DEV is wiped and re-enrolled |

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
- **For the web:** signed releases with a public log, or a verifier extension, are possible later (§10 Q3).

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

## 10. Questions for William

1. **DEV data:** wipe synced data and re-enroll at the cutover (recommended), or migrate it?
2. **Recovery:** the recovery code only (recommended), or also a passkey (WebAuthn PRF) as an extra way to unlock? A synced passkey puts recovery in Apple's or Google's hands.
3. **The browser's limit (§8):** accept it, and recommend the desktop app for the strongest guarantee? Also plan signed releases with a public log?
4. **Agents:**
   - Autonomous VMs and agents as full trusted devices, with scope enforced only by the acting device (recommended for v1)?
   - or per-folder keys now, so a grant is cryptographically limited to its folders, at the cost of a split index and more complex sharing?
5. **Sizes:** pad ciphertext to size buckets, to hide exact file sizes, at a storage cost? Recommended: no in v1, and the threat model says so.
6. **Key transparency:** TOFU with loud change warnings in v1 (recommended), with a transparency log or device gossip later?
7. **Link previews:** encrypted link shares show the generic card, with no title. Is that acceptable?
8. **Agent logs:** are they private synced data, and so under end-to-end encryption too? Today their mirror uses a server-held key.
9. **The relay to your own computers** (today "encrypted on the way but not end to end"): bring it under end-to-end encryption too?
10. **Class work (§5.2):** is the class store, readable by the server and filed under (course, assignment, student), with no sync or recovery code and submission through LTI AGS, the right exception? Who may read it beyond the instructor and graders, and for how long is it kept? (This must be answered before any class-store code is built.)
11. **Post-quantum (§11.1):** accept X25519 now, with a hybrid suite in a later epoch when WebCrypto has ML-KEM (recommended), or ship a hybrid KEM sooner as a small library?


## 11. Scale and later change (millions of files)

William asked for this review because a mistake found later, with millions of files per account, would be costly. Each finding is either fixed in the design or stated as a limit.

### 11.1 Crypto agility: no flag day

- **Everything is versioned:** every envelope (`v`, `alg`), key wrapper (HPKE suite ids in `info`), derivation (the `…v1` in every HKDF label), codec, chunk format, canonical encoding and checkpoint names its version.
  - A client refuses a version it doesn't know.
  - A new version is added beside the old, never in its place, and old ones stay readable.
- **Rotation is per epoch:** each epoch's chain entry names its suite (§2). A new suite starts at the next epoch, which any device can start: everything written afterwards uses it, and old data stays readable under its own suite.
  - Moving old data to a new suite is the carry-forward of §11.2 for keys and wrappers, and full re-encryption for content.
- **Post-quantum, stated as a limit:**
  - X25519 (in HPKE and in device and inbox keys) can be broken by a future quantum computer. Ciphertext stored today, epoch secrets wrapped to X25519 included, could then be opened by whoever kept a copy.
  - AES-256 and HMAC-SHA256 hold up.
  - WebCrypto has no ML-KEM yet. A hybrid suite (X25519 + ML-KEM, for example X-Wing) comes in a later epoch through this agility, and protects only what is written after it.
  - Whether to ship a hybrid KEM sooner, as a library, is §10 Q11.

### 11.2 The epoch cap (William's question)

**Recommendation: a soft cap of 10 live epochs, kept by retiring the oldest epoch in the background, and made cheap by the key-carrying index (§3.3).**
- **What an epoch costs while it's live:**
  - one 80-byte wrap per device and one for the recovery key;
  - every device and every recovery must hold its secret;
  - every device add and every recovery replacement re-wraps every live epoch.
  - With no cap, after years of device changes, those costs grow with the account's history. Each one is small, but nothing bounds them.
- **What moving the oldest epoch forward costs:**

  | Object | Under the old epoch | Moving it forward |
  | --- | --- | --- |
  | Blobs (the bulk of the data) | address from `K_addr[e]`, key `K_file` from `K_blob[e]` | **nothing moves.** The blob stays at its address with its ciphertext; the index entry already carries its address, codec and `K_file` |
  | Documents | random CEK, wrapped under `K_wrap[e]` | re-wrap each CEK under the current epoch: 80 bytes each |
  | Index entries | sealed under `K_index[e]` | re-sealed in the next index snapshot, which happens anyway |
  | Shares already sent | carry their files' `K_file`s, not epoch keys | nothing (their pins keep the blobs) |

  So retirement re-uploads no blob bytes, and re-encrypts no content. With a million entries, it's one re-sealed index snapshot (§11.4) and one re-wrap per document.
- **The order:**
  1. a device writes a new index snapshot, under the current epoch, that carries every entry of the old epoch;
  2. it re-wraps the old epoch's document CEKs;
  3. it signs a chain entry, "epoch e retired at checkpoint c".
  - After that entry, the old secret is no longer wrapped to new devices or to a replaced recovery key.
- **Crash safety and resuming:**
  - each step is idempotent and checkpointed. A crash resumes from the last committed snapshot page or re-wrap;
  - the retirement entry is written only after verifying that the snapshot covers every entry, and every document of the epoch is re-wrapped;
  - until then, nothing changes for anyone.
- **What other devices see:** before the retirement entry, the old snapshot and epoch, both valid. After it, the new snapshot.
  - **An op sealed under a retired epoch is refused:** epochs change only with chain entries, and §4.1's rule already refuses ops bound to an old head. The writing device rebases it under the current epoch.
  - Devices keep the old secret locally until they've processed the retirement.
- **Recovery:**
  - a recovery key needs only the live epochs, since retired ones' keys live in the index;
  - a recovery-code replacement re-wraps at most 10 epochs;
  - a retirement and a replacement are ordered by the chain like any two entries.
- **The limit, unchanged:** retirement isn't re-encryption. Anyone who held a retired epoch's secret, or a blob's `K_file`, can still open that blob's old ciphertext. Protecting old data from a removed device takes full re-encryption (§11.3).

### 11.3 Every rotation at a million objects

| Operation | Cost | Bounded by |
| --- | --- | --- |
| Add a device | one wrap per live epoch (at most 10) | the cap |
| Remove a device | a new epoch: one wrap per remaining device, plus recovery; the inbox key rotates | devices |
| Replace the recovery code | one wrap per live epoch | the cap |
| Retire an epoch | one re-sealed index snapshot plus a re-wrap per document; no blob bytes | index size (§11.4) |
| Rotate a suite | the next epoch; old data as it is | — |
| Full re-encryption (on request only) | download, decrypt, re-encrypt and upload every byte: O(data size), and roughly double the storage until the old copies are released | the person's choice; it runs throttled and resumable, one blob at a time |

### 11.4 Index size and sync cost

- **The size:** at a million entries, an index entry is about 200 bytes (path, address, `K_file`, codec, size, times, ids), so roughly 200 MB of plaintext index, maybe a third of that compressed.
- **A single sealed snapshot doesn't scale:** every change, and every retirement, would re-upload all of it, and a new device would download all of it before showing anything.
- **Fixed in the design: the index snapshot is paged, as a tree of encrypted pages** (about 1 MiB each, keyed by path order).
  - The snapshot's root is bound in the checkpoint (§4.1). A change re-seals only the pages it touches, plus their path to the root.
  - A new device fetches the root and the pages it needs first, so a phone needn't fetch every page.
  - Page sizes are padded to the page size, so pages don't reveal folder sizes.
  - The paged index is designed in the sealed-ops PR. Its first tests include a million entries.
- **The local index:** IndexedDB at a million entries is workable on desktops. Phones keep a partial index, through the same pages.

### 11.5 Limits that could force a migration later

| Limit | Value | Assessment |
| --- | --- | --- |
| Chunk index | u32 of 1 MiB chunks: 4 PiB per file | ample |
| Chunk format | whole-file compression, then fixed chunks: reading part of a large file decompresses from its start | a later codec version can add restart points, through §11.1 |
| Sequence numbers (`seq`, `dseq`) | safe integers, 2^53 | ample |
| Signed structure size | canonical bytes up to 64 KiB per signed object (the fleet rule) | op batches stay below it; index pages and snapshots are blobs, not signed objects |
| Log growth | the log root is a running hash, and ops before the latest snapshot are dropped | bounded by snapshot frequency |
| Live epochs | soft cap 10 (§11.2) | bounded |
| Wrapper ids, addresses, keys | 128 and 256 bits | ample |
| X25519 against quantum attacks | §11.1 | **the one limit agility can't fix for data already stored**: §10 Q11 |

---

*Inputs:*
- SEC (lead and second), in three rounds: key structure, recovery, HPKE context binding, checkpoints, VM custody, recovery, streaming, sizes, deterministic blobs and safe release, metadata, the integrity and browser limits, agents, shares and migration;
- the sync client's owner: blob naming, what the Worker reads, sealed ops, storage, the PR order;
- the sync documents' owner: document opacity, compaction, the metadata the document object sees, sharing's format, the live-collaboration designs that must change, client-side proposal models, and the docs to update;
- design/sync-server.md §1, §3, §4 and §10; design/workspace-files.md §7.4 and §7.9; design/sharing.md; design/agent-endpoint.md;
- sagebrush-agent's lib/fleet/core (HPKE, strict Ed25519, the device chain).
