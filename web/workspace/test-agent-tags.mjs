// ci: web-runner order=172 runner=bun
// Pinned agent #23 vectors; schema mirror and upstream vector bytes are checked offline below.
import assert from "node:assert/strict";
const pendingTests = [];
const test = (name, run) => pendingTests.push(Promise.resolve().then(run).then(() => console.log(`ok: ${name}`)));
import { readFileSync } from "node:fs";
import { validTagId, validTagName, parseTag, parseEnabledTags, parseMemoryGrant, encodeTag, encodeMemoryGrant, encodeBoundedGrant, GLOBAL_TAG_NAME, TAG_LIMITS } from "./agent-tags.ts";

const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
const ids = Array.from({ length: 17 }, (_, i) => "a".repeat(24) + alphabet[i] + "a");
const refuses = (f) => assert.throws(f, /invalid tags v1 value/);
test("opaque IDs and display slugs are separate; global is only an opt-in name", () => {
  assert.equal(validTagId("global"), false);
  assert.equal(validTagId(ids[0].toUpperCase()), false);
  assert.equal(validTagId("a".repeat(32)), false); // old hex shape is not an ID
  assert.equal(validTagId("a".repeat(26) + "\n"), false);
  assert.equal(validTagName("global"), true);
  assert.equal(GLOBAL_TAG_NAME, "global");
  assert.deepEqual(parseMemoryGrant({ tags: [] }), { tags: [] });
  refuses(() => parseMemoryGrant({ tags: ["global"] }));
  refuses(() => parseTag({ id: "my-project", name: ids[0] }));
  const original = parseTag({ id: ids[0], name: "global" });
  assert.equal(parseTag({ ...original, name: "renamed" }).id, original.id);
  assert.notEqual(parseTag({ id: ids[1], name: "global" }).id, original.id);
});
test("RFC 4648 base32 IDs have exactly 128 bits plus two zero bits, no type prefix", () => {
  assert.equal(validTagId("a".repeat(26)), true); // all-zero encoding, syntax fixture only
  assert.equal(validTagId("7".repeat(25) + "4"), true); // 16 bytes of ff
  for (let i = 0; i < alphabet.length; i++) {
    assert.equal(validTagId("a".repeat(25) + alphabet[i]), i % 4 === 0, `last symbol ${alphabet[i]}`);
    assert.equal(validTagId(alphabet[i] + "a".repeat(25)), true);
  }
  for (const id of ["a".repeat(25), "a".repeat(27), "0" + "a".repeat(25), "1" + "a".repeat(25), "a".repeat(26) + "=", `sb-${ids[0]}`, `sbt-${ids[0]}`]) assert.equal(validTagId(id), false);
  assert.equal(`sb-${ids[0]}`.length, 29);
  assert.equal(`sbt-${ids[0]}`.length, 30);
});
test("slug grammar and reserved names are platform-independent", () => {
  for (const name of ["a", "course-1", "a".repeat(32), "global"]) assert.equal(validTagName(name), true);
  for (const name of ["", "a".repeat(33), "../x", "-x", "Upper", "a_b", "é", "x\n", "own", "con", "prn", "aux", "nul", "com1", "lpt9"]) assert.equal(validTagName(name), false, name);
});
test("closed values, sorted unique enabled IDs, no widening by normalization", () => {
  assert.deepEqual(parseEnabledTags(ids.slice(0, 16)), ids.slice(0, 16));
  for (const value of [ids, [ids[1], ids[0]], [ids[0], ids[0]], ["global"], "", [null]]) refuses(() => parseEnabledTags(value));
  for (const value of [{}, { tags: [], global: true }, { tags: [], names: [] }, null]) refuses(() => parseMemoryGrant(value));
  refuses(() => parseTag({ id: ids[0], name: "valid", extra: 1 }));
  let touched = false;
  refuses(() => parseTag({ get id() { touched = true; return ids[0]; }, name: "valid" }));
  assert.equal(touched, false);
  refuses(() => parseEnabledTags(new Array(1)));
  const input = { tags: [ids[0]] }, result = parseMemoryGrant(input);
  input.tags[0] = ids[1];
  assert.equal(result.tags[0], ids[0]);
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.tags));
});
test("canonical encoding and the complete 4 KiB record bound", () => {
  assert.equal(encodeTag({ name: "global", id: ids[0] }), `{"id":"${ids[0]}","name":"global"}`);
  const memory = { tags: ids.slice(0, 16) };
  const encoded = encodeMemoryGrant(memory);
  assert.equal(Buffer.byteLength(encoded), 474);
  assert.ok(Buffer.byteLength(`{"memory":${encoded}}`) < 700);
  const record = { grant: { memory }, padding: "" };
  record.padding = "x".repeat(4096 - Buffer.byteLength(encodeBoundedGrant(record)));
  assert.equal(Buffer.byteLength(encodeBoundedGrant(record)), 4096);
  record.padding += "x";
  refuses(() => encodeBoundedGrant(record));
  record.padding = "é".repeat(4096);
  refuses(() => encodeBoundedGrant(record));
});
test("self-contained schema agrees with runtime bounds and reserved names", () => {
  const s = JSON.parse(readFileSync(new URL("./agent-tags.schema.json", import.meta.url)));
  assert.equal(s.$defs.enabled.maxItems, TAG_LIMITS.enabled);
  assert.equal(s.$defs.name.maxLength, TAG_LIMITS.name);
  assert.equal(s.$defs.tag.additionalProperties, false);
  assert.equal(s.$defs.memory.additionalProperties, false);
  assert.equal(s.$defs.enabled.uniqueItems, true);
  for (const name of s.$defs.name.not.enum) assert.equal(validTagName(name), false);
  assert.ok(!JSON.stringify(s).match(/"\$ref":"(?!#)/));
});

// PARITY CHECKS BELOW; upstream vectors above differ only in import paths and the standalone Bun test adapter.
test("page schema and vectors are byte-pinned to agent #23 e826c5a7438c9e5189856391e5dba15037f9a6c1", async () => {
  const { createHash } = await import("node:crypto");
  const { TAG_ID_PATTERN, TAG_NAME_PATTERN, TAG_RESERVED_NAMES } = await import("./agent-tags.ts");
  const hash = (s) => createHash("sha256").update(s).digest("hex");
  const bytes = readFileSync(new URL("./agent-tags.schema.json", import.meta.url));
  assert.equal(hash(bytes), "0ad97f7edbeba0365cdc3517523f5e39290cfc6090a8bd5b4df6165ed82ed6a4");
  const schema = JSON.parse(bytes);
  assert.equal(schema.$defs.id.pattern, TAG_ID_PATTERN);
  assert.equal(schema.$defs.id.maxLength, 26);
  assert.equal(schema.$defs.name.pattern, TAG_NAME_PATTERN);
  assert.deepEqual(schema.$defs.name.not.enum, TAG_RESERVED_NAMES);
  // Reconstruct upstream test bytes: no hidden alterations of cases/expected results in the page mirror.
  const own = readFileSync(new URL("./test-agent-tags.mjs", import.meta.url), "utf8");
  const vectors = own.slice(own.indexOf('import assert'), own.indexOf('\n// PARITY CHECKS BELOW;'))
    .replace('const pendingTests = [];\nconst test = (name, run) => pendingTests.push(Promise.resolve().then(run).then(() => console.log(`ok: ${name}`)));', 'import { test } from "node:test";')
    .replace('"./agent-tags.ts"', '"../lib/tags.mjs"')
    .replace('"./agent-tags.schema.json"', '"../schema/tags.schema.json"');
  assert.equal(hash(vectors), "2cdacc890128f599856cffd0114956d49cde9244f79d6abb4664d6005a5f0230");
});
await Promise.all(pendingTests);
