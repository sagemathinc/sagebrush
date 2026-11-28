// Deep linking (plan-lti-r5 §4): the picker and the signed response.  The
// response is built only from the stored deep-link transaction; the browser
// sends nothing but the transaction's reference, the chosen assignment ids and
// the target.

import { pinDeepLinks, placeableByAid, visibleAssignments, type Placeable } from "./content.ts";
import { getRegistration } from "./db.ts";
import type { Env } from "./env.ts";
import { signRs256, type Jwk } from "./jwt.ts";
import { page } from "./pages.ts";
import type { DeepLinkTx } from "./shard.ts";
import { byteLength, escapeHtml, fail, LtiError, randomHex, readBounded } from "./util.ts";

type DlEnv = Env & Required<Pick<Env, "LTI_ORIGIN" | "LTI_DB" | "LTI_SHARD">>;

export const MAX_ITEMS = 50;
export const MAX_RESPONSE = 64 * 1024;
const TARGETS = ["iframe", "window"];
const C = {
  deployment: "https://purl.imsglobal.org/spec/lti/claim/deployment_id",
  messageType: "https://purl.imsglobal.org/spec/lti/claim/message_type",
  version: "https://purl.imsglobal.org/spec/lti/claim/version",
  items: "https://purl.imsglobal.org/spec/lti-dl/claim/content_items",
  data: "https://purl.imsglobal.org/spec/lti-dl/claim/data",
};

export type Assignment = Placeable;

function splitDl(ref: string | null): { rid: string; digit: string; id: string } | null {
  const m = ref ? /^([0-9a-f]{32}):([0-9a-f]):([0-9a-f]{32})$/.exec(ref) : null;
  return m ? { rid: m[1], digit: m[2], id: m[3] } : null;
}

/** A same-origin form POST (the picker's own pages), small. */
async function sameOriginForm(req: Request, env: DlEnv): Promise<URLSearchParams> {
  if (req.headers.get("sec-fetch-site") !== "same-origin" || req.headers.get("origin") !== env.LTI_ORIGIN) throw new LtiError(403, "same_origin");
  if (!(req.headers.get("content-type") ?? "").startsWith("application/x-www-form-urlencoded")) throw new LtiError(415, "content_type");
  const body = await readBounded(req, 8192);
  if (body === null) throw new LtiError(413, "too_large");
  return new URLSearchParams(body);
}

const offeredTargets = (dl: DeepLinkTx) => dl.targets.filter((t) => TARGETS.includes(t));

/** POST /lti/deeplink/pick: the picker for one live deep-link transaction. */
export async function pick(req: Request, env: DlEnv): Promise<Response> {
  const f = await sameOriginForm(req, env);
  const ref = splitDl(f.get("dl"));
  if (!ref) return fail(400, "params");
  const reg = await getRegistration(env.LTI_DB, ref.rid);
  if (!reg || reg.state !== "approved" || !reg.policy) return fail(400, "registration");
  const fa = reg.policy.framing_origins;
  const dl = await env.LTI_SHARD.get(env.LTI_SHARD.idFromName(`${ref.rid}:${ref.digit}`)).dlGet(ref.id);
  if (!dl) return page({ title: "Sagebrush", body: "<p>This request has expired. Start again from your course.</p>", frameAncestors: fa, status: 400 });
  const cancelForm = `<form method="post" action="/lti/deeplink/respond"><input type="hidden" name="dl" value="${escapeHtml(f.get("dl")!)}"><input type="hidden" name="cancel" value="1"><button>Cancel</button></form>`;
  if (!dl.accept_types.includes("ltiResourceLink")) return page({ title: "Sagebrush", body: `<p>This placement can't take Sagebrush assignments.</p>${cancelForm}`, frameAncestors: fa });
  const targets = offeredTargets(dl);
  if (!targets.length) return page({ title: "Sagebrush", body: `<p>This placement can't show Sagebrush (it offers neither a frame nor a window).</p>${cancelForm}`, frameAncestors: fa });
  if (!env.LTI_CONTENT) return fail(503, "not_configured");
  const list = await visibleAssignments(env, reg.owner_ref);
  const kind = dl.accept_multiple ? "checkbox" : "radio";
  const rows = list.map((a) => `<label><input type="${kind}" name="aid" value="${a.aid}"> ${escapeHtml(a.title)} <small>(rev ${a.rev}${a.visibility === "public" ? ", public" : ""})</small></label><br>`).join("");
  const sel = targets.map((t) => `<option value="${t}">${t === "iframe" ? "in the course page" : "in a new window"}</option>`).join("");
  return page({
    title: "Sagebrush: add assignments",
    body: `<h1 style="font-size:18px">Add Sagebrush ${dl.accept_multiple ? "assignments" : "an assignment"}</h1>
<form method="post" action="/lti/deeplink/respond"><input type="hidden" name="dl" value="${escapeHtml(f.get("dl")!)}">${rows || "<p>No assignments are available to your institution yet.</p>"}
<p>Open <select name="target">${sel}</select></p><button>Add</button></form>${cancelForm}`,
    frameAncestors: fa,
  });
}

/** POST /lti/deeplink/respond: check the selection, consume the transaction once, and post the signed response (§4.3–4.5). */
export async function respond(req: Request, env: DlEnv): Promise<Response> {
  const f = await sameOriginForm(req, env);
  const ref = splitDl(f.get("dl"));
  if (!ref) return fail(400, "params");
  const reg = await getRegistration(env.LTI_DB, ref.rid);
  if (!reg || reg.state !== "approved" || !reg.policy || !reg.client_id || !reg.iss) return fail(400, "registration");
  const fa = reg.policy.framing_origins;
  const shard = env.LTI_SHARD.get(env.LTI_SHARD.idFromName(`${ref.rid}:${ref.digit}`));
  const dl = await shard.dlGet(ref.id);
  if (!dl) return page({ title: "Sagebrush", body: "<p>This request has expired or was already used. Start again from your course.</p>", frameAncestors: fa, status: 400 });
  if (!env.TOOL_KEY) return fail(503, "not_configured");
  const cancel = f.get("cancel") === "1";
  let items: Record<string, unknown>[] = [];
  const pins: { item: string; aid: string; rev: number }[] = [];
  if (!cancel) {
    if (!env.LTI_CONTENT) return fail(503, "not_configured");
    const aids = [...new Set(f.getAll("aid"))];
    if (!dl.accept_types.includes("ltiResourceLink")) return fail(400, "type_not_accepted");
    if (aids.length < 1 || aids.length > (dl.accept_multiple ? MAX_ITEMS : 1) || !aids.every((a) => /^[0-9a-f]{32}$/.test(a))) return fail(400, "selection");
    const target = f.get("target") ?? "";
    if (!offeredTargets(dl).includes(target)) return fail(400, "target");
    // (amendment 3 r15 §4: visible to the registration's owner now, at the current rev)
    const byAid = new Map((await placeableByAid(env, aids)).map((a) => [a.aid, a]));
    for (const aid of aids) {
      const a = byAid.get(aid);
      // (another institution's private assignment is refused exactly like a missing one)
      if (!a || (a.owner_ref !== reg.owner_ref && a.visibility !== "public")) return fail(400, "assignment");
      items.push({
        type: "ltiResourceLink",
        title: a.title,
        url: `${env.LTI_ORIGIN}/lti/app`,
        custom: { sb_assignment: a.aid, sb_rev: String(a.rev), sb_item: pinFor(pins, a) },
        ...(target === "window" ? { window: { targetName: "_blank" } } : { iframe: { height: 800 } }),
        ...(dl.accept_lineitem && a.max_points > 0 ? { lineItem: { scoreMaximum: a.max_points, label: a.title, resourceId: a.aid, tag: "sagebrush" } } : {}),
      });
    }
  }
  // only now, with the selection checked, is the transaction consumed (single use)
  const used = await shard.dlConsume(ref.id);
  if (!used) return page({ title: "Sagebrush", body: "<p>This request was already used.</p>", frameAncestors: fa, status: 400 });
  // (amendment 3 r15 §4: the deep-link pins, before the response is signed; after the single use, so a replay makes none)
  if (pins.length) {
    const p = await pinDeepLinks(env, ref.rid, pins);
    if (!p.ok) return page({ title: "Sagebrush", body: p.code === "pin_quota" ? "<p>Too many Sagebrush items in this course haven't been opened yet. Open some, then add more.</p>" : "<p>This assignment isn't available here.</p>", frameAncestors: fa, status: p.code === "pin_quota" ? 429 : 400 });
  }
  const now = Math.floor(Date.now() / 1000);
  const payload: Record<string, unknown> = {
    iss: reg.client_id, aud: [reg.iss], iat: now, exp: now + 300, nonce: randomHex(16),
    [C.deployment]: used.deployment,
    [C.messageType]: "LtiDeepLinkingResponse",
    [C.version]: "1.3.0",
    [C.items]: items,
    ...(used.data_json !== undefined ? { [C.data]: JSON.parse(used.data_json) } : {}),
  };
  const jwt = await signRs256(payload, JSON.parse(env.TOOL_KEY) as Jwk & { kid: string });
  if (byteLength(jwt) > MAX_RESPONSE) return fail(413, "response_too_large");
  const returnOrigin = new URL(used.return_url).origin;
  return page({
    title: "Sagebrush",
    body: `<p>Returning to your course…</p><form id="f" method="post" action="${escapeHtml(used.return_url)}"><input type="hidden" name="JWT" value="${escapeHtml(jwt)}"><noscript><button>Continue</button></noscript></form>`,
    script: `document.getElementById("f").submit();`,
    frameAncestors: fa,
    formAction: returnOrigin,
  });
}

/** A deep-link item's random id, `sb_item` (r5 §4.4), and its pin (§4). */
function pinFor(pins: { item: string; aid: string; rev: number }[], a: Placeable): string {
  const item = randomHex(16);
  pins.push({ item, aid: a.aid, rev: a.rev });
  return item;
}
