// End-to-end against the real Moodle 5.3 on VM 2 (plan-lti-r5 §12), inside
// the lti-vmtest network.  Synthetic users only.  Two phases, because
// activity creation runs as PHP in the Moodle container between them:
//   node e2e-moodle.mjs register      dynamic registration + approval
//   node e2e-moodle.mjs launch <cmid-embed> <cmid-window>
import { chromium } from "playwright";
import { createHmac, randomUUID } from "node:crypto";

const TOOL = "https://lti.vmtest", M = "https://moodle.vmtest";
const { LTI_KEY, MOODLE_PASSWORD, SEED_PW } = process.env;
const results = [];
const ok = (cond, what, extra = "") => {
  results.push({ ok: !!cond, what, ...(extra ? { extra: String(extra).slice(0, 200) } : {}) });
  console.log(cond ? "PASS" : "FAIL", what, extra ? `(${String(extra).slice(0, 200)})` : "");
};
async function admin(path, body) {
  const b = JSON.stringify({ request_id: randomUUID().replace(/-/g, ""), ...body });
  const t = String(Date.now());
  const sig = createHmac("sha256", LTI_KEY).update(`POST\n${path}\n${t}\n${b}`).digest("hex");
  const r = await fetch(TOOL + path, { method: "POST", headers: { "content-type": "application/json", "x-lti-time": t, "x-lti-signature": sig }, body: b });
  return { status: r.status, body: await r.json().catch(() => null) };
}
async function login(browser, user, pw) {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  await page.goto(`${M}/login/index.php`);
  await page.fill("#username", user);
  await page.fill("#password", pw);
  await Promise.all([page.waitForLoadState("load"), page.click("#loginbtn")]);
  return { ctx, page };
}

const browser = await chromium.launch();
const phase = process.argv[2];
try {
  if (phase === "register") {
    const c = await admin("/lti/admin/codes", { owner_ref: "vmtest-moodle", owner_kind: "organization", actor_ref: "e2e", preset: "moodle", bootstrap_hosts: ["moodle.vmtest"], expected_issuer: M });
    ok(c.status === 200 && c.body?.url, "the tool issues a registration code", c.status);
    const { page } = await login(browser, "admin", MOODLE_PASSWORD);
    const sesskey = await page.evaluate(() => globalThis.M?.cfg?.sesskey);
    ok(!!sesskey, "Moodle admin signed in");
    await page.goto(`${M}/mod/lti/startltiadvregistration.php?url=${encodeURIComponent(c.body.url)}&sesskey=${sesskey}`);
    await page.waitForLoadState("load");
    const text = await page.textContent("body");
    ok(/Sagebrush is registered/.test(text ?? ""), "Moodle's dynamic registration reaches the tool and completes", page.url());
    const list = await admin("/lti/admin/registrations", { owner_ref: "vmtest-moodle" });
    const reg = list.body?.registrations?.find((r) => r.state === "pending");
    ok(reg && reg.iss === M, "the registration is pending with Moodle's issuer", JSON.stringify(reg?.policy ?? {}));
    if (reg) {
      const a = await admin("/lti/admin/approve", { owner_ref: "vmtest-moodle", rid: reg.rid, policy_version: reg.policy_version, policy_digest: reg.policy_digest, actor_ref: "e2e" });
      ok(a.status === 200, "the preset-exact policy is approved", JSON.stringify(a.body));
    }
  } else if (phase === "launch") {
    const [cmEmbed, cmWindow] = process.argv.slice(3).map(Number);
    for (const [user, want] of [["student1", "learner"], ["teacher1", "instructor"]]) {
      const { ctx, page } = await login(browser, user, SEED_PW);
      // embedded: Moodle's iframe, a cross-site frame (lti.vmtest inside moodle.vmtest), cookie mode with a partitioned cookie
      await page.goto(`${M}/mod/lti/view.php?id=${cmEmbed}`);
      let frameText = "";
      for (let i = 0; i < 30 && !/Signed in as|isn't set up|couldn't be completed|blocked/.test(frameText); i++) {
        await page.waitForTimeout(500);
        const f = page.frames().find((fr) => fr.url().startsWith(TOOL));
        frameText = f ? ((await f.textContent("body").catch(() => "")) ?? "") : "";
      }
      ok(frameText.includes(`Signed in as ${want}`), `${user}: an embedded launch in Moodle signs in as ${want}`, frameText.trim().slice(0, 160));
      // new window: top-level, first-party
      const [popup] = await Promise.all([ctx.waitForEvent("page", { timeout: 15000 }).catch(() => null), page.goto(`${M}/mod/lti/view.php?id=${cmWindow}`)]);
      let p2 = popup ?? page;
      let t2 = "";
      for (let i = 0; i < 30 && !/Signed in as|couldn't be completed/.test(t2); i++) {
        await p2.waitForTimeout(500);
        const pages = ctx.pages();
        const target = pages.find((pg) => pg.url().startsWith(TOOL)) ?? p2;
        p2 = target;
        t2 = (await target.textContent("body").catch(() => "")) ?? "";
        const f = target.frames().find((fr) => fr.url().startsWith(TOOL));
        if (!/Signed in as/.test(t2) && f) t2 = (await f.textContent("body").catch(() => "")) ?? "";
      }
      ok(t2.includes(`Signed in as ${want}`), `${user}: a new-window launch in Moodle signs in as ${want}`, t2.trim().slice(0, 160));
      await ctx.close();
    }
  }
} catch (e) {
  ok(false, "the run threw", e?.stack ?? e);
} finally {
  await browser.close();
  const failed = results.filter((r) => !r.ok).length;
  console.log(JSON.stringify({ phase, passed: results.length - failed, failed }));
  process.exit(failed ? 1 : 0);
}
