// ci: web-runner order=124 runner=bun
import assert from "node:assert/strict";
import { CONTENT_DOMAINS, LEGACY_CONTENT_ROOTS, checkContentDomains, filesOrigin, filesHost, filesHosts, forbiddenContentRoots } from "./content-domains.mts";
import { SITES, checkSites } from "./output-shell/sites.mts";
const it = (name, f) => { f(); console.log("ok   " + name); };
const legacy = ["cocalcusercontent.com", "cocalcusercontent.dev"];
const empty = () => ({ dev: { root: "", filesOrigin: "", runOrigin: "", renderOrigin: "" }, prod: { root: "", filesOrigin: "", runOrigin: "", renderOrigin: "" } });
const configured = () => ({ dev: { root: "content-example.dev", filesOrigin: "https://files.content-example.dev", runOrigin: "", renderOrigin: "" }, prod: { root: "content-example.com", filesOrigin: "https://files.content-example.com", runOrigin: "", renderOrigin: "" } });
const rootProblem = "dev: choose a dedicated .dev content root";
const originProblem = "dev: filesOrigin must be the exact https files origin under its content root";
it("keeps deployed files routes and all hosted roles unchanged", () => {
  assert.deepEqual(checkContentDomains(), []);
  assert.deepEqual(LEGACY_CONTENT_ROOTS, legacy);
  for (const [env, root] of [["dev", legacy[1]], ["prod", legacy[0]]]) {
    assert.equal(filesOrigin(env), `https://files.${root}`);
    assert.equal(filesHost(env), `files.${root}`);
    assert.deepEqual(filesHosts(env), [`files.${root}`]);
  }
  assert(Object.values(CONTENT_DOMAINS).every((c) => Object.values(c).every((v) => v === "")));
  assert(Object.values(SITES).every((s) => s.shell === ""));
  assert.deepEqual(checkSites(), []);
});
it("rejects the wrong environment suffix without another broken rule", () => {
  const c = empty(); c.dev.root = "content-example.com";
  assert.deepEqual(checkContentDomains(c), [rootProblem]);
});
it("rejects a legacy root with the correct environment suffix", () => {
  const c = empty(); c.dev.root = "cocalcusercontent.dev";
  assert.deepEqual(checkContentDomains(c), [rootProblem]);
});
it("rejects extra labels after a superficially valid root", () => {
  const c = empty(); c.dev.root = "content-example.dev.extra.dev";
  assert.deepEqual(checkContentDomains(c), [rootProblem]);
});
it("requires exact role origins, with a valid corresponding root", () => {
  assert.deepEqual(checkContentDomains(configured()), []);
  for (const value of ["http://files.content-example.dev", "https://files.content-example.com", "https://files.content-example.dev/", "https://files.content-example.dev/x", "https://files.content-example.dev?key=1", "https://user@files.content-example.dev", "https://files.content-example.dev:443"]) {
    const c = configured(); c.dev.filesOrigin = value;
    assert.deepEqual(checkContentDomains(c), [originProblem], value);
  }
});
it("refuses an origin whose root has not been configured", () => {
  for (const origin of ["https://files.content-example.dev", "https://files."]) {
    const c = empty(); c.dev.filesOrigin = origin;
    assert.deepEqual(checkContentDomains(c), [originProblem], origin);
  }
});
it("reports a shared environment root as well as the suffix mismatch", () => {
  const c = empty(); c.dev.root = c.prod.root = "content-example.com";
  assert.deepEqual(checkContentDomains(c), [rootProblem, "dev and prod must use different content roots"]);
});
it("filesOrigin refuses an invalid configuration before returning a route", () => {
  const c = empty(); c.dev.root = "cocalcusercontent.dev";
  assert.throws(() => filesOrigin("dev", c), { message: rootProblem });
});
it("configured routes retain each environment's legacy host alongside its new one", () => {
  const c = configured();
  assert.equal(filesOrigin("dev", c), "https://files.content-example.dev");
  assert.equal(filesHost("prod", c), "files.content-example.com");
  assert.deepEqual(filesHosts("dev", c), ["files.cocalcusercontent.dev", "files.content-example.dev"]);
  assert.deepEqual(filesHosts("prod", c), ["files.cocalcusercontent.com", "files.content-example.com"]);
});
it("legacy and pending content roots stay forbidden for hosted rendering", () => {
  assert.deepEqual(forbiddenContentRoots(), legacy);
  assert.deepEqual(forbiddenContentRoots(configured()), [...legacy, "content-example.dev", "content-example.com"]);
  for (const root of legacy) {
    const problems = checkSites({ ...SITES, dev: { ...SITES.dev, shell: `https://render.${root}/` } });
    assert.deepEqual(problems, [`dev: the shell may not share the app's or the user-content site (${root})`]);
  }
});
