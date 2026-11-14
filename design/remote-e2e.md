# Remote compute: end-to-end encryption between a page and your computer

Status: design note, no code. Nothing here blocks remote compute on the site.

The question: can the relay (the Worker, its Durable Objects, D1) be made to see only ciphertext between a person's
page and their own computer (the runner, `sagebrush remote`)? And what would that protect against, honestly?

**In short.**

- **Today:** whoever controls the relay controls your computer. The runner admits any page key the relay hands it.
- **First, pairing and authenticated messages:** a pairing step done once, in the computer's own terminal, plus
  pinned keys on both ends, plus every later message authenticated in both directions under keys from that pairing.
  Together these take that power away from the relay, and from anyone holding a stolen session cookie. Worth building.
  Pairing alone is not enough: today's messages aren't authenticated end to end, so a relay could still inject them
  (§4.2).
- **Encryption comes with it:** the keyed record layer that authenticates messages can encrypt them for about the
  same cost, which hides content from a relay that only carries and stores messages.
- **The limit:** encryption does not protect against a compromised server that serves the page's JavaScript. On the
  web, that server is the same one. So the site should make **no end-to-end security claim**.
- **The native app:** a claim becomes possible there, once the app has remote compute without loading code from the
  site. That is a product reason to install the app. The app is far from that today (§6).

## 1. What exists today

All file references are to this repository.

- **The runner's leg:** the runner dials out to `/api/remote/v1/runner`. Its upgrade is authenticated by its enrolled
  P-256 key, which signs `"sb-remote-chal/1\n" + challenge` (`relay.py`, `CHAL_TAG`). The challenge is the Worker's.
  The runner checks only that it is 1-600 printable ASCII bytes (`relay.py`, before `key.sign`).
- **A page's leg:** a page's leg (`/api/remote/v1/page`) is admitted by its session cookie: signed in, same site, and
  the account owns the remote (`server.ts`, `pageLeg`).
- **The page's key:** the page makes a fresh non-extractable P-256 key for each leg (`remote-client.js`,
  `agent-relay.ts`) and sends its public key in the hello. On the relay the runner accepts that key as is: "the page's
  session was checked by the relay, so a code or session hello is refused here" (`relay.py`, `hello`). Every later
  proof (the kernel's DPoP, the terminal's open proof, the agent envelope's per-message ES256) is checked against that
  same relay-supplied key.
- **Contents:** the relay never parses application messages (`relay.ts`, header comment), but it could. They are
  plaintext JSON. That includes terminal keystrokes and output, kernel code and outputs, agent chat, and the agent's
  sign-in messages, which travel as agent-channel payloads that the runner forwards to the agent child as bytes.
  Runner-to-page messages are not signed at all.
- **The runner's public key:** the page learns it from `/api/remote/v1/peers`, which reads D1. D1 is not a root of
  trust.
- **The pairing precedent:** loopback pairing (`pair.py`) already has the ceremony this note reuses. A 128-bit code is
  shown by the runner, single use, valid for 5 minutes, compared in constant time, and retired after 5 wrong tries.

## 2. Adversaries

- **(a) The relay and storage:** an active adversary in full control of the Worker's request handling, the Durable
  Objects, D1 and the relay's traffic. It can read, drop, reorder, replay and inject messages, admit any leg, and
  answer the peers list with any keys. It does **not** change the JavaScript that the site serves to pages. (A
  relay/DO/D1 compromise, an insider with data access but no deploy rights, a misrouting bug, a D1 leak.)
- **(b) Full server compromise:** (a), plus it serves the page's JavaScript.
- **(c) The native app under (b):** the person uses the native app, built from signed artifacts that the server does
  not distribute.
- **(d) Outside any claim:** a compromised endpoint (the computer, the browser, the person's OS account) or a
  compromised release signing chain.

A stolen session cookie is a weaker form of (a): it can open page legs.

## 3. What is protected (assets × adversaries)

"Yes" means confidentiality and integrity both hold, if §4 is built.

| Asset                                                      | Today, under (a)                   | (a) with §4         | (b) on the web | (c) the app, conditional (§6) | (d)        |
| ---------------------------------------------------------- | ---------------------------------- | ------------------- | -------------- | ----------------------------- | ---------- |
| Command authority (who may run anything on the computer)   | **Lost**: relay chooses page key   | Yes (pinning)       | **No**         | Yes                           | No         |
| Terminal keystrokes and output                             | Exposed                            | Yes                 | **No**         | Yes                           | No         |
| Kernel code and outputs                                    | Exposed                            | Yes                 | **No**         | Yes                           | No         |
| Agent chat                                                 | Exposed                            | Yes                 | **No**         | Yes, once agent chat is bundled | No       |
| Pasted sign-in codes (the agent CLI's own login)           | Exposed                            | Yes                 | **No**         | Yes, once sign-in is bundled  | No         |
| Metadata: which computer, which channel, when, sizes       | Exposed                            | Exposed             | Exposed        | Exposed                       | Exposed    |
| Availability (dropping, closing, forged revoked)           | Lost                               | Lost                | Lost           | Lost                          | Lost       |

## 4. The design, if built

### 4.1 Pairing, once per browser profile (or app install) and computer

This is the step that removes the relay from the trust path (gate 2). Without it, any encryption is circumventable:
the relay would just substitute keys.

- **The device key:** the browser makes a long-lived device key, P-256 ECDSA and non-extractable, kept in IndexedDB
  (the app: the OS keystore).
- **The runner's E2E key:** the runner makes a new **E2E identity key**, separate from its enrolled key. The enrolled
  key stays the Worker's credential. The E2E key is never sent to D1.
- **The code:** `sagebrush remote pair`, run in the computer's own terminal, prints a pairing code with the loopback
  rules (128 bits, single use, 5 minutes, 5 tries). The person types it into the page. The relay never sees the code.
- **Mutual proof, one per role:** the transcript P is `"sb-remote-pair/1"` followed by origin, remote_id, the device
  public key, the runner's E2E public key and both nonces. Each field is length-prefixed, so no two different field
  lists encode to the same bytes. The page sends HMAC(code, `"page"` ‖ P), and the runner answers with HMAC(code,
  `"runner"` ‖ P). Each side checks only the other role's label, in constant time. Without the role labels, the relay
  could reflect the page's proof back as the runner's and make the page pin a key of its choosing without knowing the
  code. A 128-bit single-use code can't be guessed offline from the MACs.
- **What each side keeps:** the runner pins the device key's thumbprint in a pins file next to `key.json` (0600 in the
  same 0700 folder), with a label and a date. `sagebrush remote pins` lists and removes pins. The page pins the
  runner's E2E key for that remote_id. From then on, D1's copy of any key is never consulted for trust.

### 4.2 Every leg: an authenticated key exchange

- **Page → runner:** a fresh ephemeral ECDH key, a nonce, and its device key's thumbprint.
- **Runner → page:** a fresh ephemeral ECDH key, a nonce, and a signature with its **E2E** key over the transcript
  T = `"sb-remote-e2e/1\n"` ‖ version ‖ origin ‖ remote_id ‖ channel ‖ generation ‖ runner incarnation ‖ both
  ephemerals ‖ both nonces ‖ device thumbprint, each field length-prefixed as in §4.1. The page verifies it against
  its **pin**.
- **Page → runner:** a signature with the device key over T ‖ `"page"`. The runner verifies it against its **pins**.
- **Keys:** HKDF-SHA256 (RFC 5869) over the ECDH secret, salted with both nonces, with info = `"sb-remote-e2e/1 keys"`
  ‖ SHA-256(T). That yields one key per direction, plus key-confirmation values. Both sides confirm before anything
  else is accepted.
- **Records:** AES-256-GCM (RFC 5116). The nonce is a per-direction counter, so nonces never repeat under a key. The
  associated data is version ‖ channel ‖ generation ‖ direction ‖ sequence. A sequence that isn't exactly the next one
  closes the leg, which stops replay, reordering, and moving a record to another channel or leg.
- **Reconnect:** every leg does a new exchange; there is no session resumption. The agent's resume secret moves inside
  the encrypted channel and binds to the device key.
- **Every record, both ways:** after confirmation, every message in both directions is an AEAD record under that
  leg's keys and sequence numbers. That is what removes the relay's command control. The handshake alone doesn't: the
  kernel's DPoP proof covers the method, URI and token but not the request body, and the runner's replies are not
  signed at all. So a relay could keep an authenticated leg open and still rewrite its plaintext.
- **Inside the tunnel:** the existing protocols run unchanged (hello, tokens, DPoP, agent envelopes), so the kernel,
  terminal and agent code stays as it is. Removing the per-message ES256 later is an optimization, not part of the
  claim.
- **What the relay still sees:** the relay keeps its controls (`{"relay":...}`), the generation prefix and the byte
  accounting, all in plaintext. That is the metadata row in §3.
- **Primitives:** WebCrypto has ECDH P-256, HKDF and AES-GCM in every browser the site supports. The runner gets them
  from the native module, which already links `p256` 0.13 for ES256 (`engine/py/Cargo.toml`). It needs the `ecdh`
  feature plus `hkdf` and `aes-gcm`, all RustCrypto crates. Python itself takes no crypto dependency. X25519 (RFC 7748)
  would do as well where every browser supports it, but P-256 avoids a second curve.

### 4.3 No downgrade (gate 4)

- **The runner:** once a runner has any pin, it refuses every hello that is not an E2E hello, on every channel, from
  then on. There is no flag, environment variable or legacy path that skips this. Removing the last pin is a local
  command, not a relay operation.
- **The page:** once a page has pinned a remote, it refuses a plaintext answer for it. Under (b), served JavaScript
  can skip this check, which is exactly why (b) is "No" on the web.

## 5. Every runner operation the relay can reach (gate 3)

**The rule:** before pairing proof or key confirmation, nothing signs, decrypts or exports caller-chosen bytes. Nothing
echoes or logs plaintext, and nothing reaches the gateway, a terminal or an agent.

| Operation                                    | Before auth?  | What it may do                                                                                                                                                                        |
| -------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Upgrade challenge signing (`CHAL_TAG`)       | yes, by design | Signs `"sb-remote-chal/1\n"` + printable ASCII without newlines, with the **enrolled** key only. The E2E key signs only `"sb-remote-e2e/1\n"` transcripts it built itself, so the tags and keys separate the domains. |
| Pairing (`sagebrush remote pair`)            | yes           | Answers only a proof made with the code; single use; 5 tries; error text fixed, never echoing input.                                                                                   |
| page-open, page-close, receipt, ping, dropped | yes          | Bookkeeping only (generations, windows). Availability, never content.                                                                                                                  |
| revoked, close 4403/4009                     | yes           | Stops kernels and ends the command: availability only (§3).                                                                                                                            |
| E2E hello and key confirmation               | yes           | Signs only T, which contains the runner's own fresh ephemeral and nonce, so it is never an arbitrary-message signer. A failure closes with a fixed reason.                               |
| Kernel, terminal and agent dispatch          | no            | Only after confirmation. Decrypts only under that leg's keys.                                                                                                                           |
| Agent sign-in (start, code, status, cancel)  | no            | Payloads inside the agent channel. The code exists in plaintext only in the page and on the computer.                                                                                  |
| Reconnect, resume                            | no            | A fresh exchange every time. The resume secret is only inside the channel.                                                                                                             |
| Errors, reports to the site (`agents` list)  | n/a           | Fixed words and the kinds offered. Never message content.                                                                                                                              |
| Logs (`AgentLog`, the runner's stderr)       | n/a           | Must hold no decrypted message bodies. The agent child's stderr log is redacted for tokens today; it needs an audit for bodies.                                                         |

**A mistakenly admitted session:**
- A paired device that is itself compromised gets what any shell as that user gets. It can read `key.json` and the
  pins file and add its own pin.
- So can the person's own agents: they run as that user, and an agent talked into it can read or add pins.
- Nothing on the computer can tell that apart from the person, so it is outside the claim (d).
- Recovery is local: remove the pins, enroll again (`sagebrush remote login --force`), and pair the person's devices
  again.

## 6. Served JavaScript, and the native app (gate 5)

**On the web:** the code that holds the device key and does the exchange comes from the same server. A server that
serves modified JavaScript reads everything and can command the computer through an already paired device.
- Non-extractable keys don't help: the code uses them; it doesn't need to export them.
- Pinning doesn't help: the pinned device is the attacker's tool.
- Subresource integrity from the same server doesn't help: the server writes the hashes.
- Only client code distributed independently of the server would help. For this product that means the native app.

**In the app (column (c)):** the claim holds only if all of these become true. Today, none of the remote features
exist in the app.

- **What the app has today:**
  - It serves its pages from its own files on `http://127.0.0.1:<port>` (`app/src-tauri/src/lib.rs`, `frontendDist
    "../dist"`).
  - It has no sign-in.
  - It doesn't bundle the agent chat or the review code (`app/build-frontend.mjs`, `SITE_ONLY`).
  - It has no updater plugin (`app/src-tauri/Cargo.toml`: dialog, fs, localhost).
  - Its `security.csp` is `null` (`tauri.conf.json`).
- **Sign-in and legs:** sign-in, and page legs from the app's origin, authenticated without a same-site cookie.
- **Bundling:** agent chat and the agent's sign-in, bundled in the app, never fetched from the site.
- **A strict CSP:** no remote script, connections only to the relay endpoints, no Worker-hosted pages loaded or
  navigated to in the WebView.
- **An inventory:** every fetch, dynamic import, navigation, update and auth step, written down and pinned by a test.
  None of them may load code.
- **Updates:** signed by keys the server never holds, verified by the OS or the updater before running.
- **Untrusted output:** remote output (terminal escapes, kernel HTML) stays untrusted data in the app, sandboxed as it
  is on the site.

A native-only claim is acceptable as an outcome: "end-to-end encrypted when you use the Sagebrush app" is a real
reason to install it.

## 7. Cost and tests

- **Size:** the security review's estimate is 400-800 production lines and 500-1000 test lines for §4-§5 across the
  page, the runner and its native module. The app work in §6 is separate and is not estimated here.
- **Round trips:** 1-2 more per leg.
- **Byte accounting:** the relay is text-only. Ciphertext then travels as base64url, which is 4/3 of the size, and
  the 16-byte tag and the record header are expanded too. Base64url is workable if each channel states exact limits
  for both the wire bytes and the decoded plaintext, and its frame cap and the relay's windows (`relay-caps.ts`,
  `PEER_WINDOW`, the receipt allowance) are worked out again from them. Binary frames would avoid the expansion but
  change the relay's text-only rule.
- **Tests:**
  - a malicious relay, key substitution at the peers list and in the hello, a wrong or missing pin;
  - replay, reorder, a record moved to another channel or leg, reconnect, downgrade to a plaintext hello;
  - a wrong pairing code 5 times, quota and caps with ciphertext;
  - three browsers, and an install with `pip install` (the native module).

## 8. Recommendation (gate 6)

1. **Pairing, pinning and authenticated records first (§4.1-§4.3).** This closes the hole that matters most today:
   the relay, a relay bug, or a stolen session cookie can each get a shell on your computer. It has to include the
   per-record authentication, since a pinned handshake followed by plaintext still leaves the relay able to inject
   commands. Using AEAD for those records gives encryption at about the same cost.
2. **No end-to-end claim on the web.** Encryption there hides content from (a); it is defense in depth, not a promise
   against (b).
3. **A native-only claim** once §6 is met, stated as such.
4. **Nothing here blocks the site's remote compute.** Implementation would follow the cross-computer access work.
