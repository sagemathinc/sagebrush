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
  for (const c of O.approvals) {
    const got = await result(() => core.verifyApproval(enc(c.bytes), { ...ctx, chain: st, now: F.now_ms, expect: c.expect_op, current: c.current, used: (a) => c.used.includes(a) }));
    check("approvals", c.name, got, c.expect);
  }
  return { bad, n };
}
