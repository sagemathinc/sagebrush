// ci: web-runner order=124 runner=bun
import assert from "node:assert/strict";
import { CONTENT_DOMAINS, LEGACY_CONTENT_ROOTS, checkContentDomains, filesOrigin, filesHost, filesHosts, forbiddenContentRoots } from "./content-domains.mts";
import { SITES, checkSites } from "./output-shell/sites.mts";
const it = (name, f) => { f(); console.log("ok   " + name); };
{
  it("keeps the deployed files origins and all hosted shells unchanged", () => {
    assert.deepEqual(checkContentDomains(), []);
    assert.equal(filesOrigin("dev"), `https://files.${LEGACY_CONTENT_ROOTS[1]}`);
    assert.equal(filesHost("prod"), `files.${LEGACY_CONTENT_ROOTS[0]}`);
    assert.deepEqual(filesHosts("dev"), [`files.${LEGACY_CONTENT_ROOTS[1]}`]);
    assert.deepEqual(filesHosts("prod"), [`files.${LEGACY_CONTENT_ROOTS[0]}`]);
    assert(Object.values(CONTENT_DOMAINS).every((c) => Object.values(c).every((v) => v === "")));
    assert(Object.values(SITES).every((s) => s.shell === ""));
    assert.deepEqual(checkSites(), []);
  });
  it("refuses misdirected, non-origin and cross-environment settings", () => {
    const good = { dev: { root: "content-example.dev", filesOrigin: "https://files.content-example.dev", runOrigin: "", renderOrigin: "" }, prod: { root: "content-example.com", filesOrigin: "https://files.content-example.com", runOrigin: "", renderOrigin: "" } };
    assert.deepEqual(checkContentDomains(good), []);
    for (const filesOrigin of ["http://files.content-example.dev", "https://files.content-example.com", "https://files.content-example.dev/", "https://files.content-example.dev/x", "https://files.content-example.dev?key=1", "https://user@files.content-example.dev", "https://files.content-example.dev:443"]) {
      assert(checkContentDomains({ ...good, dev: { ...good.dev, filesOrigin } }).length > 0);
    }
    for (const root of ["content-example.com", "*.content-example.dev", "sagebrush.space", "cocalcusercontent.dev"]) assert(checkContentDomains({ ...good, dev: { ...good.dev, root } }).length > 0);
  });
  it("continues rejecting legacy content roots for hosted rendering", () => {
    for (const root of forbiddenContentRoots()) assert(checkSites({ ...SITES, dev: { ...SITES.dev, shell: `https://render.${root}/` } }).length > 0);
  });
}
