// ci: web-sync.1 order=13
// The fleet database's text CHECKs (web/cloud/fleet/migrations): every bound is in stored BYTES and every text column
// refuses a NUL. SQLite's length() and GLOB stop at a NUL, so `length(x) = 26 AND x NOT GLOB …` alone would admit 26
// valid characters, a NUL and anything after them. Each constraint family is driven with, for every column:
//   - a valid row (accepted: the control);
//   - a NUL inside the nominal length (the right byte count, one byte a NUL);
//   - the valid value, then a NUL, then a suffix;
//   - where the grammar allows non-ASCII text, a multibyte value whose character count passes and whose byte count
//     doesn't, with the byte-exact boundary on both sides.
// The same rows run on SQLite (node:sqlite) and on D1 itself (Miniflare), with the migrations applied as the deploy does.
//   node web/cloud/fleet/test-fleet-schema.mjs
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(here, "../../site/package.json"));
const { Miniflare, convertV4MiniflareOptions } = require("miniflare");

let failures = 0, count = 0;
const ok = (c, what, detail) => { count++; if (!c) { failures++; console.log("FAIL", what, detail === undefined ? "" : JSON.stringify(detail).slice(0, 300)); } };
const MIGRATIONS = ["0001_fleet_leases.sql", "0002_fleet_writers_chain_hosts.sql"];
const statements = MIGRATIONS.flatMap((m) => readFileSync(join(here, "migrations", m), "utf8").replace(/--[^\n]*/g, "").split(";").map((s) => s.trim()).filter(Boolean));

const ID = "abcdefghijklmnopqrstuvwxy2", B43 = "A".repeat(42) + "w", B22 = "A".repeat(21) + "w";
// Each table's valid row, and for each text column its family: "id" (26, base32), "b43" (43, base64url), "b22" (22,
// base64url), or "utf8" with its byte bounds (the chain entry's text, the bucket key).
const TABLES = {
  fleet_hosts: { row: { host: ID, fleet: ID, sign_key: B43, fingerprint: B43, revoked: 0 }, text: { host: "id", fleet: "id", sign_key: "b43", fingerprint: "b43" } },
  fleet_agents: { row: { agent: ID, fleet: ID, host: ID, entry_gen: 1, revoked: 0 }, text: { agent: "id", fleet: "id", host: "id" } },
  fleet_chain_entries: { row: { fleet: ID, seq: 0, bytes: "{}" }, text: { fleet: "id", bytes: { min: 1, max: 65536 } } },
  lease_pending: { row: { agent: ID, from_host: ID, to_host: ID, transfer: B43, acked: 0 }, text: { agent: "id", from_host: "id", to_host: "id", transfer: "b43" } },
  lease_nonces: { row: { host: ID, nonce: B22, lease_id: ID, decided: "ok", created_ms: 0 }, text: { host: "id", nonce: "b22", lease_id: "id", decided: "enum" } },
  lease_clock: { row: { agent: ID, host: ID, expires_at: 0, lease_id: ID, gen: 1, request: B43 }, text: { agent: "id", host: "id", lease_id: "id", request: "b43" } },
  fleet_bucket_hits: { row: { key: "lease-src:198.51.100.7", t: 0, id: ID }, text: { key: { min: 1, max: 200 }, id: "id" } },
  fleet_chain_hashes: { row: { fleet: ID, seq: 0, hash: B43 }, text: { fleet: "id", hash: "b43" } },
  fleet_host_certs: { row: { fleet: ID, host: ID, cert: B43 }, text: { fleet: "id", host: "id", cert: "b43" } },
  fleet_revocations: { row: { fleet: ID, kind: "host", id: ID }, text: { fleet: "id", kind: "enum", id: "id" } },
};
const VALID = { id: ID, b43: B43, b22: B22 };

/** The cases for one column: [what, value, accepted?]. */
function cases(col, fam, valid) {
  if (fam === "enum") return [["the value + NUL", valid + "\0", false], ["NUL + the value", "\0" + valid, false]];
  if (typeof fam === "string") {
    const v = VALID[fam];
    return [
      ["a NUL inside the nominal length", v.slice(0, -1) + "\0", false],
      ["the valid value + NUL + suffix", v + "\0EVIL", false],
      ["a NUL first, then the valid value", "\0" + v.slice(1), false],
      ["one byte short", v.slice(1), false],
      ["one byte long", v + v[0], false],
    ];
  }
  // (UTF-8 text with byte bounds: é is 2 bytes, 𝄞 is 4; the boundary at exactly max and max + 1 bytes)
  const at = (n, ch) => ch.repeat(Math.floor(n / Buffer.byteLength(ch))) + "a".repeat(n % Buffer.byteLength(ch));
  return [
    ["a NUL inside the bounds", "a\0b", false],
    ["valid text + NUL + suffix", valid + "\0EVIL", false],
    ["a NUL first, then valid text", "\0" + valid, false],
    [`exactly ${fam.max} bytes of 2-byte characters`, at(fam.max, "é"), true],
    [`${fam.max + 1} bytes of 2-byte characters (${Math.ceil((fam.max + 1) / 2)} characters)`, at(fam.max + 1, "é"), false],
    [`exactly ${fam.max} bytes of 4-byte characters`, at(fam.max, "𝄞"), true],
    [`${fam.max + 1} bytes of 4-byte characters`, at(fam.max + 1, "𝄞"), false],
    [`${fam.max} characters, more than ${fam.max} bytes`, "é".repeat(fam.max), false],
    ["empty", "", fam.min === 0],
  ];
}

/** Every TEXT column of every table, as the schema itself declares them: the census must be exactly TABLES'. */
async function census(label, all) {
  const tables = (await all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name")).map((r) => r.name);
  ok(JSON.stringify(tables) === JSON.stringify(Object.keys(TABLES).sort()), `${label}: the tables are exactly the ones driven here`, tables);
  for (const t of tables) {
    const text = (await all(`PRAGMA table_info(${t})`)).filter((c) => String(c.type).toUpperCase() === "TEXT").map((c) => c.name).sort();
    ok(JSON.stringify(text) === JSON.stringify(Object.keys(TABLES[t]?.text ?? {}).sort()), `${label}: ${t}: every TEXT column is driven`, text);
  }
}

async function run(label, exec) {
  for (const [table, { row, text }] of Object.entries(TABLES)) {
    const cols = Object.keys(row);
    const insert = (r) => exec(`INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map((_, i) => `?${i + 1}`).join(", ")})`, cols.map((c) => r[c]));
    const clear = () => exec(`DELETE FROM ${table}`, []);
    await clear();
    let accepted = true;
    try { await insert(row); } catch { accepted = false; }
    ok(accepted, `${label}: ${table}: the valid row is accepted (the control)`);
    await clear();
    for (const [col, fam] of Object.entries(text)) {
      for (const [what, value, want] of cases(col, fam, row[col])) {
        let got = true;
        try { await insert({ ...row, [col]: value }); } catch (e) { got = false; if (!/CHECK constraint failed/i.test(String(e?.message ?? e))) ok(false, `${label}: ${table}.${col}: ${what}: refused by something other than a CHECK`, String(e?.message)); }
        await clear();
        ok(got === want, `${label}: ${table}.${col}: ${what}: ${want ? "accepted" : "refused"}`, { got });
      }
    }
  }
}

// ---- SQLite, through node:sqlite
const lite = new DatabaseSync(":memory:");
for (const s of statements) lite.exec(s);
await census("sqlite", async (sql) => lite.prepare(sql).all());
await run("sqlite", async (sql, v) => { lite.prepare(sql).run(...v); });

// ---- D1 itself, through Miniflare
const mf = new Miniflare(convertV4MiniflareOptions({ workers: [{ name: "fleet", modules: true, script: "export default { fetch() { return new Response('') } }", compatibilityDate: "2026-10-01", d1Databases: ["FLEET_DB"] }] }));
const db = await mf.getD1Database("FLEET_DB");
for (const s of statements) await db.prepare(s).run();
await census("d1", async (sql) => (await db.prepare(sql).all()).results);
await run("d1", (sql, v) => db.prepare(sql).bind(...v).run());
// (the stored bytes are what was sent: D1 keeps a NUL-free value byte for byte)
await db.prepare("INSERT INTO fleet_bucket_hits (key, t, id) VALUES (?1, 0, ?2)").bind("é".repeat(100), ID).run();
const back = (await db.prepare("SELECT key, length(CAST(key AS BLOB)) AS n FROM fleet_bucket_hits").all()).results[0];
ok(back.key === "é".repeat(100) && back.n === 200, "d1: a 200-byte multibyte key round-trips byte for byte", back);
await mf.dispose();

console.log(`${count - failures}/${count} passed`);
if (failures) process.exit(1);
