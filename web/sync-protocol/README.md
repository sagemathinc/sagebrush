# web/sync-protocol

The document sync protocol's contract (doc-protocol.ts, protocol.ts), its vectors (doc-vectors.json, made by
gen-doc-vectors.py; doc-claim-vectors.json) and core's reference server (reference-server.ts).

## doc-vectors.json's `refusals`: comparing a refusal with a case

Each case of `refusals` gives a refusal's `code` and its `detail`: the refusal's own fields (`why`, `limit`,
`retry_after_*`, `latest_at_seq`).

On a document socket a refusal arrives as `{t: "error", req, code, detail: {message, ...the refusal's own fields}}`, as
every socket error has since slice 1. So `detail` may also carry a human-readable `message`.

`detail.message` is **not part of a case**. A strict comparison with a vector leaves it out, and everything else must
match: the code, the detail's keys and strings, and each number's zero or non-zero (the server's test of 2b-7 does
exactly this). The client's `refusalOf` (protocol.ts) keeps `detail` as it arrived, so the extra `message` changes
nothing there; the client decides on the code and the refusal's own fields.

An accepted snapshot is acknowledged as `{t: "ack", req, snapshot: {}}`.

## doc-vectors.json's `answers`: comparing an answer with its shape

Each case of `answers` names a request (`for`), the situation (`when`) and the `shape` of the frame a server sends for it.
`shapeMismatch(frame, shape)` (doc-protocol.ts) returns null when the frame matches, or the first path where it doesn't:
- an object in a shape has exactly those keys, no more and no fewer;
- `{"*": s}` is a map whose every value is `s` (a batch ack's `resent`, by patch id);
- `[s]` is an array whose every element is `s`;
- `"number"`, `"string"`, `"boolean"`, `"null"`, `"string|null"` and `"array"` are a value of that type;
- `"=x"` is exactly the string `x`.

Pinned so far:
- pull's page: no `snapshot` key, and every item carries `device`;
- a batch's ack: `seq` only when a patch was new, and `resent` as an object;
- the cleared history's refusal on batch and pull (`epoch`), as against a claim's `stale_epoch`.

The reference server is checked against them in test-reference-server.mjs, and cloud's server in its test-sync.
