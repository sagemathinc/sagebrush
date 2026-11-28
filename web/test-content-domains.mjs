// ci: web-runner order=124 runner=bun
import assert from "node:assert/strict";
import { CONTENT_DOMAINS, LEGACY_CONTENT_ROOTS, agentOrigin, checkContentDomains, filesOrigin, filesHost, filesHosts, forbiddenContentRoots } from "./content-domains.mts";
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
  assert(Object.values(CONTENT_DOMAINS).every((c) => Object.values(c).every((v) => v === "" || v === false)), "every role unset and no PSL adoption recorded");
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
it("the agent guest: an exact agent origin under its root, none by default", () => {
  assert.equal(agentOrigin("dev"), "");
  assert.equal(agentOrigin("prod"), "");
  const c = configured(); c.dev.agentOrigin = "https://agent.content-example.dev";
  assert.deepEqual(checkContentDomains(c), []);
  assert.equal(agentOrigin("dev", c), "https://agent.content-example.dev");
  assert.deepEqual(forbiddenContentRoots(c), [...legacy, "content-example.dev", "content-example.com"]);
  for (const bad of ["https://agent.other-example.dev", "http://agent.content-example.dev", "https://x.agent.content-example.dev", "https://agent.content-example.dev/"]) {
    const d = configured(); d.dev.agentOrigin = bad;
    assert.deepEqual(checkContentDomains(d), ["dev: agentOrigin must be the exact https agent origin under its content root"], bad);
  }
});
it("SEC G-O1: no script-running host shares a root with the agent guest until the root's PSL listing is adopted", () => {
  const shared = "dev: agentOrigin can't share its content root with runOrigin or renderOrigin until the root's Public Suffix List listing is adopted";
  for (const role of ["run", "render"]) {
    const c = configured(); c.dev.agentOrigin = "https://agent.content-example.dev"; c.dev[`${role}Origin`] = `https://${role}.content-example.dev`;
    assert.deepEqual(checkContentDomains(c), [shared], role);
    assert.throws(() => agentOrigin("dev", c), /Public Suffix List/);
    c.dev.pslAdopted = true;
    assert.deepEqual(checkContentDomains(c), [], `${role}, the listing adopted`);
  }
  // (run or render on a root without the guest: as before)
  const r = configured(); r.prod.runOrigin = "https://run.content-example.com";
  assert.deepEqual(checkContentDomains(r), []);
  // (the guest on one environment's root, run on the other's: separate roots, allowed)
  const x = configured(); x.dev.agentOrigin = "https://agent.content-example.dev"; x.prod.runOrigin = "https://run.content-example.com";
  assert.deepEqual(checkContentDomains(x), []);
});
