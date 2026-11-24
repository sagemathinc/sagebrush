// End-to-end against the real Canvas on VM 2 (plan-lti-r5 §12), inside the
// lti-vmtest network.  Synthetic users only.  Canvas sends lti_storage_target,
// so its launches exercise the platform-storage binding (postMessage through
// Canvas's post_message_forwarding frame) and the same-origin verify.
//   node e2e-canvas.mjs register
//   node e2e-canvas.mjs launch <course_id> <tool_id>
import { chromium } from "playwright";
import { createHmac, randomUUID } from "node:crypto";

const TOOL = "https://lti.vmtest", C = "https://canvas.vmtest";
const { LTI_KEY, CANVAS_ADMIN_PASSWORD, SEED_PW } = process.env;
const results = [];
const ok = (cond, what, extra = "") => {
  results.push({ ok: !!cond, what });
  console.log(cond ? "PASS" : "FAIL", what, extra ? `(${String(extra).slice(0, 600)})` : "");
};
async function admin(path, body) {
  const b = JSON.stringify({ request_id: randomUUID().replace(/-/g, ""), ...body });
  const t = String(Date.now());
  const sig = createHmac("sha256", LTI_KEY).update(`POST\n${path}\n${t}\n${b}`).digest("hex");
  const r = await fetch(TOOL + path, { method: "POST", headers: { "content-type": "application/json", "x-lti-time": t, "x-lti-signature": sig }, body: b });
  return { status: r.status, body: await r.json().catch(() => null) };
}
async function login(browser, email, pw) {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  await page.goto(`${C}/login/canvas`, { timeout: 120000 });
  await page.fill("#pseudonym_session_unique_id", email);
  await page.fill("#pseudonym_session_password", pw);
  await Promise.all([page.waitForLoadState("load"), page.click("button[type=submit], input[type=submit]")]);
  await page.waitForTimeout(1500);
  return { ctx, page };
}

const browser = await chromium.launch();
const phase = process.argv[2];
try {
  if (phase === "register") {
    const c = await admin("/lti/admin/codes", { owner_ref: "vmtest-canvas", owner_kind: "organization", actor_ref: "e2e", preset: "canvas-self", bootstrap_hosts: ["canvas.vmtest"] });
    ok(c.status === 200 && c.body?.url, "the tool issues a registration code", c.status);
    const { page } = await login(browser, "admin@example.invalid", CANVAS_ADMIN_PASSWORD);
    ok(!page.url().includes("/login"), "Canvas admin signed in", page.url());
    // what Canvas's "LTI Registration" UI does: a registration token, then the tool's page with it
    const tok = await page.evaluate(async (u) => {
      const r = await fetch(`/api/lti/accounts/self/registration_token?registration_url=${encodeURIComponent(u)}`, { credentials: "same-origin" });
      return JSON.parse((await r.text()).replace(/^while\(1\);/, ""));
    }, c.body.url);
    ok(tok?.token && tok?.oidc_configuration_url, "Canvas issues a registration token", JSON.stringify(Object.keys(tok ?? {})));
    await page.goto(`${c.body.url}&openid_configuration=${encodeURIComponent(tok.oidc_configuration_url)}&registration_token=${encodeURIComponent(tok.token)}`);
    await page.waitForLoadState("load");
    ok(/Sagebrush is registered/.test((await page.textContent("body")) ?? ""), "Canvas's dynamic registration reaches the tool and completes", page.url());
    const list = await admin("/lti/admin/registrations", { owner_ref: "vmtest-canvas" });
    const reg = list.body?.registrations?.find((r) => r.state === "pending");
    ok(reg, "the registration is pending", JSON.stringify(reg?.policy ?? list.body));
    if (reg) {
      const a = await admin("/lti/admin/approve", { owner_ref: "vmtest-canvas", rid: reg.rid, policy_version: reg.policy_version, policy_digest: reg.policy_digest, actor_ref: "e2e" });
      ok(a.status === 200, "the preset-exact policy is approved", JSON.stringify(a.body));
    }
  } else if (phase === "launch") {
    const [courseId, toolId] = process.argv.slice(3).map(Number);
    for (const [user, want] of [["student1", "learner"], ["teacher1", "instructor"]]) {
      const { ctx, page } = await login(browser, `${user}@example.invalid`, SEED_PW);
      await page.goto(`${C}/courses/${courseId}/external_tools/${toolId}`, { timeout: 120000 });
      let text = "";
      for (let i = 0; i < 60 && !/Signed in as|isn't set up|couldn't be completed|blocked/.test(text); i++) {
        await page.waitForTimeout(500);
        const f = page.frames().find((fr) => fr.url().startsWith(TOOL));
        text = f ? ((await f.textContent("body").catch(() => "")) ?? "") : "";
      }
      const diag = text ? text.trim().slice(0, 160) : `no tool frame; page ${page.url()}; frames ${page.frames().map((f) => f.url().slice(0, 90)).join(" | ")}; text ${((await page.textContent("main, body").catch(() => "")) ?? "").replace(/\s+/g, " ").slice(0, 200)}`;
      ok(text.includes(`Signed in as ${want}`), `${user}: an embedded Canvas launch (platform storage) signs in as ${want}`, diag);
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
