// ci: checks.6 order=36 test
// The engine publisher (scripts/engine-publish.mjs) and its S3 signer (scripts/engine-s3.mjs): AWS's published
// signature example; a new engine (lib objects, its files, its manifest LAST, read back); another manifest or a lib
// object of another size refuses before ANY write; an engine already published only gets its missing lib objects; an
// unclear GET stops; validation refuses a tampered file, a symlink, an unsafe key, a bad id; the environment.
//   node --test scripts/test-engine-publish.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { sign } from "./engine-s3.mjs";
import { publishEngine, s3FromEnv, validate, BUCKET } from "./engine-publish.mjs";

const ROOT = mkdtempSync(join(tmpdir(), "engine-publish-test-"));
process.on("exit", () => rmSync(ROOT, { recursive: true, force: true }));
const sha = (b) => createHash("sha256").update(b).digest("hex");
const put = (rel, data) => { mkdirSync(dirname(join(ROOT, rel)), { recursive: true }); writeFileSync(join(ROOT, rel), data); };
let n = 0;

test("s3: AWS's published GET example signs to its published signature", () => {
  const { authorization } = sign({
    method: "GET", host: "examplebucket.s3.amazonaws.com", path: "/test.txt", headers: { range: "bytes=0-9" },
    payloadHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", region: "us-east-1", amzDate: "20130524T000000Z",
  });
  assert.equal(authorization, "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request,SignedHeaders=host;range;x-amz-content-sha256;x-amz-date,Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41");
});

const ID = "0123456789abcdef0123";
function engineDir(files) {
  const rel = `e${n++}`, man = { id: ID, files: {} };
  for (const [f, data] of Object.entries(files)) {
    put(join(rel, f), data);
    man.files[f] = { size: Buffer.byteLength(data), sha256: sha(data), headers: { "Content-Type": "application/octet-stream" } };
  }
  writeFileSync(join(ROOT, rel, "manifest.json"), JSON.stringify(man));
  return { dir: join(ROOT, rel), man };
}
function fakeS3(objects = new Map()) {
  const log = [];
  return {
    log, objects,
    async head(k) { log.push(["HEAD", k]); return objects.has(k) ? { status: 200, size: objects.get(k).length } : { status: 404, size: null }; },
    async get(k) { log.push(["GET", k]); return objects.has(k) ? { status: 200, body: objects.get(k) } : { status: 404, body: null }; },
    async put(k, b) { log.push(["PUT", k]); objects.set(k, Buffer.from(b)); return { status: 200 }; },
  };
}
const quiet = () => {};
const FILES = { "worker.js": "w", "lib/a.chunk": "aaaa", [`lib/tzdata/${"f".repeat(64)}.tzif`]: "tz" };

test("publish: a new engine: lib objects, its files, its manifest LAST, then read back", async () => {
  const { dir } = engineDir(FILES), s3 = fakeS3();
  const r = await publishEngine({ dir, s3, log: quiet });
  const puts = s3.log.filter(([m]) => m === "PUT").map(([, k]) => k);
  assert.equal(puts.at(-1), `engine/${ID}/manifest.json`);
  assert.ok(puts.includes("lib/a.chunk") && puts.includes(`engine/${ID}/worker.js`) && puts.includes(`engine/${ID}/lib/a.chunk`));
  assert.ok(!puts.includes(`engine/${ID}/lib/tzdata/${"f".repeat(64)}.tzif`), "the zone data only at lib/tzdata/");
  assert.equal(s3.log[0][0], "GET", "the published manifest is read first");
  assert.deepEqual(s3.log.at(-1), ["GET", `engine/${ID}/manifest.json`], "and read back last");
  assert.equal(r.uploaded, puts.length);
});
test("publish: a manifest that doesn't read back as written fails", async () => {
  const { dir } = engineDir(FILES), s3 = fakeS3();
  const put0 = s3.put;
  s3.put = async (k, b) => put0(k, k.endsWith("manifest.json") ? Buffer.from("{}") : b);
  await assert.rejects(publishEngine({ dir, s3, log: quiet }), /didn't read back/);
});
test("publish: another manifest already published refuses before ANY write", async () => {
  const { dir } = engineDir(FILES), s3 = fakeS3(new Map([[`engine/${ID}/manifest.json`, Buffer.from('{"id":"x"}')]]));
  await assert.rejects(publishEngine({ dir, s3, log: quiet }), /ANOTHER manifest/);
  assert.equal(s3.log.filter(([m]) => m === "PUT").length, 0);
});
test("publish: a lib object there with another size refuses, never overwritten, and nothing is written", async () => {
  const { dir } = engineDir(FILES), s3 = fakeS3(new Map([["lib/a.chunk", Buffer.from("different")]]));
  await assert.rejects(publishEngine({ dir, s3, log: quiet }), /ANOTHER size/);
  assert.equal(s3.log.filter(([m]) => m === "PUT").length, 0);
});
test("publish: already published with this manifest: only missing lib objects", async () => {
  const { dir } = engineDir(FILES);
  const s3 = fakeS3(new Map([[`engine/${ID}/manifest.json`, readFileSync(join(dir, "manifest.json"))]]));
  await publishEngine({ dir, s3, log: quiet });
  assert.deepEqual(s3.log.filter(([m]) => m === "PUT").map(([, k]) => k).sort(), ["lib/a.chunk", `lib/tzdata/${"f".repeat(64)}.tzif`]);
});
test("publish: a GET that is neither 200 nor 404, or a PUT that isn't 200, stops", async () => {
  const a = engineDir(FILES), s3 = fakeS3();
  s3.get = async () => ({ status: 403, body: null });
  await assert.rejects(publishEngine({ dir: a.dir, s3, log: quiet }), /couldn't tell/);
  const b = engineDir(FILES), t = fakeS3();
  t.put = async () => ({ status: 403 });
  await assert.rejects(publishEngine({ dir: b.dir, s3: t, log: quiet }), /PUT .*: 403/);
});
test("publish: validation refuses a file that doesn't match, a symlink, an unsafe key, a bad id", () => {
  const a = engineDir(FILES);
  writeFileSync(join(a.dir, "worker.js"), "tampered");
  assert.throws(() => validate(a.dir), /doesn't match/);
  const b = engineDir(FILES);
  rmSync(join(b.dir, "worker.js"));
  symlinkSync("/etc/hostname", join(b.dir, "worker.js"));
  assert.throws(() => validate(b.dir), /regular file/);
  const c = engineDir(FILES);
  writeFileSync(join(c.dir, "manifest.json"), JSON.stringify({ ...c.man, files: { ...c.man.files, "../x": c.man.files["worker.js"] } }));
  assert.throws(() => validate(c.dir), /unsafe/);
  const d = engineDir(FILES);
  writeFileSync(join(d.dir, "manifest.json"), JSON.stringify({ ...d.man, id: "ZZ" }));
  assert.throws(() => validate(d.dir), /id/);
});
test("environment: the wasm-publish environment's three names, an account id, the one bucket; a failure names the variable only", async () => {
  const ok = { R2_ACCOUNT_ID: "a".repeat(32), AWS_ACCESS_KEY_ID: "k", AWS_SECRET_ACCESS_KEY: "s" };
  for (const k of Object.keys(ok)) assert.throws(() => s3FromEnv({ ...ok, [k]: "" }), new RegExp(`${k} isn't set`));
  assert.throws(() => s3FromEnv({ ...ok, R2_ACCOUNT_ID: "not-an-account" }), /isn't an account id/);
  assert.equal(BUCKET, "sagebrush-releases");
  // (the request goes to the account's R2 endpoint, path-style in that bucket, signed; the secret never in a header)
  const seen = [];
  const s3 = s3FromEnv(ok, async (url, init) => { seen.push([url, init]); return new Response(null, { status: 404 }); });
  await s3.head("engine/x/manifest.json");
  assert.equal(seen[0][0], `https://${"a".repeat(32)}.r2.cloudflarestorage.com/sagebrush-releases/engine/x/manifest.json`);
  assert.ok(!JSON.stringify(seen[0][1].headers).includes('"s"') && /^AWS4-HMAC-SHA256 Credential=k\//.test(seen[0][1].headers.authorization));
});
