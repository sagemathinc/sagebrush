// Every case in test/fixtures/fleet-fixtures.json, run against one loaded fleet core (lib/fleet/core/index.mjs with a
// backend and the schemas installed). No Node built-ins, so the same file runs with Node's backend, with WebCrypto in
// Node, and in a browser. Returns the mismatches ({ group, name, got, expect }) and the number of cases run.

export async function checkFixtures(core, F) {
  const { FleetError } = core;
  const enc = (s) => new TextEncoder().encode(s);
  const result = async (fn) => { try { await fn(); return "ok"; } catch (e) { if (e instanceof FleetError) return e.code; throw e; } };
  const ctx = { aud: F.aud, fleet: F.ids.fleet };
  const bad = [];
  let n = 0;
  const check = (group, name, got, expect) => { n++; if (got !== expect) bad.push({ group, name, got, expect }); };

  for (const c of F.canonical) check("canonical", c.name, await result(() => core.parseCanonical(core.unb64(c.bytes_b64))), c.expect);
  for (const c of F.base64url) check("base64url", c.name, await result(() => core.unb64(c.value, c.len)), c.expect);
  for (const c of F.ids_cases) check("ids", c.value, core.isId(c.value) ? "ok" : "bad_form", c.expect);
  for (const c of F.ed25519) check("ed25519", c.name, await core.verifyStrict(core.unb64(c.public, 32), core.unb64(c.msg_b64), core.unb64(c.sig, 64)), c.expect);

  for (const c of F.chain.cases) {
    const got = await result(async () => {
      const st = await core.replayChain(c.entries.map(enc), ctx, c.pin ?? null);
      if (c.append) await core.applyChainEntry(st, enc(c.append), ctx);
    });
    check("chain", c.name, got, c.expect);
  }

  const sk = await core.replayChain(F.service_keys.chain.map(enc), ctx);
  for (const c of F.service_keys.cases) check("service_keys", c.name, await result(() => core.serviceKeyAt(sk, c.signer, c.chain_seq)), c.expect);

  for (const c of F.lease_keys.chain_cases) {
    const got = await result(async () => {
      const st = await core.replayChain(c.entries.map(enc), ctx);
      if (c.append) await core.applyChainEntry(st, enc(c.append), ctx);
    });
    check("lease_chain", c.name, got, c.expect);
  }
  const lk = await core.replayChain(F.lease_keys.chain.map(enc), ctx);
  for (const c of F.lease_keys.cases) {
    const at = c.lookup === "lease" ? core.leaseKeyAt : core.serviceKeyAt;
    check("lease_keys", c.name, await result(() => at(lk, c.signer, c.chain_seq)), c.expect);
  }

  {
    const E = F.leases;
    const lc = await core.replayChain(E.chain.map(enc), ctx);
    const lcert = await core.verifyHostCert(enc(E.host_cert), { ...ctx, chain: lc });
    for (const c of E.requests) {
      let h = null;
      const got = await result(async () => { h = (await core.verifyLeaseRequest(enc(c.bytes), { ...ctx, cert: lcert })).hash; });
      check("lease_requests", c.name, got, c.expect);
      if (c.hash) check("lease_requests", `${c.name}: its hash`, h, c.hash);
    }
    for (const c of E.leases) {
      const got = await result(() => core.verifyExecutionLease(enc(c.bytes), { ...ctx, chain: lc, host: E.host, hostKey: E.host_key, outstanding: c.outstanding }));
      check("leases", c.name, got, c.expect);
    }
  }
  const O = F.objects;
  const st = await core.replayChain(O.chain.map(enc), ctx);
  const cert = await core.verifyHostCert(enc(O.host_cert), { ...ctx, chain: st });
  for (const c of O.envelopes) {
    const got = await result(() => core.open(enc(c.bytes), { ...(c.ctx ?? ctx), resolveKey: (s, t, b) => core.deviceKey(st, s, b.chain_seq).raw }));
    check("envelopes", c.name, got, c.expect);
  }
  for (const c of O.grants) {
    const current = c.current && { gen: c.current.gen, bytes: enc(c.current.bytes), body: JSON.parse(c.current.bytes).body };
    check("grants", c.name, await result(() => core.verifyGrant(enc(c.bytes), { ...ctx, chain: st, cert, current, now: F.now_ms })), c.expect);
  }
  for (const c of O.host_ops) {
    const got = await result(() => core.verifyHostOp(enc(c.bytes), { ...ctx, chain: st, host: F.ids.host, currentGen: c.current_gen, now: F.now_ms, seenOp: () => false }));
    check("host_ops", c.name, got, c.expect);
  }
  for (const c of O.grant_acks) {
    check("grant_acks", c.name, await result(() => core.verifyGrantAck(enc(c.bytes), { ...ctx, cert, currentGen: c.current_gen })), c.expect);
  }
  for (const c of O.approvals) {
    const got = await result(() => core.verifyApproval(enc(c.bytes), { ...ctx, chain: st, now: F.now_ms, expect: c.expect_op, current: c.current, used: (a) => c.used.includes(a) }));
    check("approvals", c.name, got, c.expect);
  }

  // moving an agent (r2.4 §3.7): the receipt pair (checks 1-3), then the host's records (checks 4-6)
  const X = F.transfers;
  const chains = { honest: await core.replayChain(X.chain.map(enc), ctx), removed: await core.replayChain(X.chain_removed.map(enc), ctx) };
  for (const c of X.receipts) {
    const got = await result(() => core.verifyTransferReceipt({ transfer: enc(c.transfer), receipt: enc(c.receipt) }, { ...ctx, chain: chains[c.chain ?? "honest"] }));
    check("transfer_receipts", c.name, got, c.expect);
  }
  const hostOf = (r) => ({
    id: r.id, fingerprint: r.fingerprint,
    grantHashAt: (g) => r.grants[g]?.hash ?? null,
    grantListsAgent: (g, a) => r.grants[g]?.agents.includes(a) ?? false,
    listedSince: (a) => r.listed_since[a] ?? null,
    entryGen: (a) => r.entry_gen[a] ?? null,
    acceptedTransfer: (a) => r.accepted[a] ?? null,
    nonceSeen: (x) => r.nonces[x] ?? null,
  });
  for (const c of X.hosts) {
    let first = null;
    const got = await result(() => { first = core.checkTransferForHost(c.pair, hostOf(c.host)).first; });
    check("transfer_hosts", c.name, got === "ok" ? `ok first=${first}` : got, c.expect === "ok" ? `ok first=${c.first}` : c.expect);
  }
  return { bad, n };
}

// The RFC 9180 known-answer vector for r2.3 §7's suite (test/fixtures/hpke-x25519-sha256-aes256gcm.json), through one
// loaded core: both derived key pairs, the encapsulated key, every encryption sealed and opened in sequence, and every
// exported secret from both sides (after the encryptions: an export doesn't depend on the sequence) and single-shot.
export async function checkHpkeVector(core, V) {
  const hex = (h) => Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));
  const toHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  const bad = [];
  const E = await core.deriveKeyPair(hex(V.ikmE)), R = await core.deriveKeyPair(hex(V.ikmR));
  if (toHex(E.raw) !== V.pkEm) bad.push("pkEm");
  if (toHex(R.raw) !== V.pkRm) bad.push("pkRm");
  const S = await core.setupSender(R.raw, hex(V.info), E), O = await core.setupRecipient(R, hex(V.enc), hex(V.info));
  if (toHex(S.enc) !== V.enc) bad.push("enc");
  let n = 0;
  for (const [i, e] of V.encryptions.entries()) {
    if (toHex(await S.seal(hex(e.aad), hex(e.pt))) !== e.ct) bad.push(`seal ${i}`);
    if (toHex(await O.open(hex(e.aad), hex(e.ct))) !== e.pt) bad.push(`open ${i}`);
    n++;
  }
  for (const [i, x] of V.exports.entries()) {
    const ctx = hex(x.exporter_context);
    if (toHex(await S.export(ctx, x.L)) !== x.exported_value) bad.push(`sender export ${i}`);
    if (toHex(await O.export(ctx, x.L)) !== x.exported_value) bad.push(`recipient export ${i}`);
    const one = await core.hpkeSendExport(R.raw, hex(V.info), ctx, x.L, E);
    if (toHex(one.enc) !== V.enc || toHex(one.secret) !== x.exported_value) bad.push(`sendExport ${i}`);
    if (toHex(await core.hpkeReceiveExport(R, hex(V.enc), hex(V.info), ctx, x.L)) !== x.exported_value) bad.push(`receiveExport ${i}`);
    n++;
  }
  // overlapping calls on one context (ruled): the first runs, any other started while it is pending is refused
  // (in_progress) without touching the sequence, so a nonce is never shared; the next call afterwards takes seq + 1
  const [e0, e1, e2] = V.encryptions;
  const refusedNow = (r) => r.status === "rejected" && r.reason?.code === "in_progress";
  const S2 = await core.setupSender(R.raw, hex(V.info), await core.deriveKeyPair(hex(V.ikmE)));
  const seals = await Promise.allSettled([S2.seal(hex(e0.aad), hex(e0.pt)), S2.seal(hex(e1.aad), hex(e1.pt)), S2.seal(hex(e2.aad), hex(e2.pt))]);
  if (seals[0].status !== "fulfilled" || toHex(seals[0].value) !== e0.ct || !refusedNow(seals[1]) || !refusedNow(seals[2])) bad.push("overlapping seals");
  if (toHex(await S2.seal(hex(e1.aad), hex(e1.pt))) !== e1.ct) bad.push("the seal after overlapping ones");
  const O2 = await core.setupRecipient(R, hex(V.enc), hex(V.info));
  const opens = await Promise.allSettled([O2.open(hex(e0.aad), hex(e0.ct)), O2.open(hex(e0.aad), hex(e0.ct))]);
  if (opens[0].status !== "fulfilled" || toHex(opens[0].value) !== e0.pt || !refusedNow(opens[1])) bad.push("the same ciphertext opened twice at once");
  // a refused open leaves the sequence where it was
  let refused = "";
  try { await O2.open(hex(e0.aad), hex(e0.ct)); } catch (x) { refused = x.code; }
  if (refused !== "bad_form") bad.push("seq-0 ciphertext again, alone");
  if (toHex(await O2.open(hex(e1.aad), hex(e1.ct))) !== e1.pt) bad.push("the next ciphertext after a refused one");
  return { bad, n };
}

// The fleet HPKE vectors (test/fixtures/fleet-hpke-fixtures.json): the X25519 key id, every sealed-package case (the
// host's §7 checks, then opening), and every capability-mint case, through one loaded core. The host's key is
// deriveKeyPair(host_enc_ikm).
export async function checkHpkeFixtures(core, F) {
  const { FleetError } = core;
  const enc = (s) => new TextEncoder().encode(s);
  const hex = (h) => Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));
  const result = async (fn) => { try { await fn(); return "ok"; } catch (e) { if (e instanceof FleetError) return e.code; throw e; } };
  const bad = [];
  let n = 0;
  const check = (group, name, got, expect) => { n++; if (got !== expect) bad.push({ group, name, got, expect }); };
  for (const c of F.key_ids) check("key_ids", c.name, await core.keyId(c.alg, core.unb64(c.raw, 32)), c.key_id);
  const ctx = { aud: F.aud, fleet: F.ids.fleet };
  const chain = await core.replayChain(F.chain.map(enc), ctx);
  const cert = await core.verifyHostCert(enc(F.host_cert), { ...ctx, chain });
  const encKey = await core.deriveKeyPair(hex(F.host_enc_ikm));
  for (const c of F.packages) {
    let opened = null;
    const v = { ...ctx, chain, cert, hostRevoked: () => c.ctx.host_revoked, encKey, currentGen: c.ctx.current_gen, grant: F.grant, now: c.ctx.now_ms, revoked: (p) => c.ctx.revoked.includes(p), opened: (p) => c.ctx.opened.includes(p) };
    const got = await result(async () => { opened = await core.verifyPackage(enc(c.bytes), v); });
    check("packages", c.name, got, c.expect);
    if (c.plaintext) check("packages", `${c.name}: its plaintext`, opened && core.canonText(opened.plaintext), core.canonText(c.plaintext));
  }
  for (const c of F.caps) {
    let p = null;
    const got = await result(async () => { p = await core.openCap(c.response, { ...c.ctx, now: c.ctx.now_ms, encKey }); });
    check("caps", c.name, got, c.expect);
    if (c.token) check("caps", `${c.name}: its token`, p?.token, c.token);
  }
  return { bad, n };
}
