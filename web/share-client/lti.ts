// An assignment opened from a course: the share page's `lti` source.  After a
// launch, the course tool's page sends the student here as
// `/s/#lti=<its link>`, the link escaped; the link is in the fragment, so no
// server sees it.  The link is the tool's file list for this assignment
// (`<tool>/lti/f/<capability>/manifest`), good for 10 minutes.  It is
// accepted only on the tool's origin paired with this site's, and every file
// it lists must be on that origin too.  The page then reads each file from
// its address there and checks it against its SHA-256, as it does a share's.

/** This site's origin and its course tool's: a link from any other origin is refused. */
export const LTI_ORIGINS: Record<string, string> = {
  "https://dev.sagebrush.space": "https://lti-dev.sagebrush.space",
};

export interface LtiFile { path: string; sha256: string; size: number }
export interface LtiLoaded {
  /** the reader's copies are keyed by it: "lti:" and the copy's id (course, student, placement), never the link */
  id: string;
  version: string;
  latest: string;
  manifest: { title: string; created: string; files: LtiFile[] };
  fileUrl: (f: LtiFile) => string;
}

const BAD_LINK = "This assignment link isn't valid. Open the assignment again from your course.";

/** What the page says for each refusal of the file list; anything else is said with its HTTP status. */
export const LTI_REFUSALS: Record<string, string> = {
  heavy_busy: "Sagebrush is busy opening other assignments. Try again in a minute.",
  rate: "Too many requests came from your network just now. Try again in a minute.",
  folder_budget: "This assignment link has been used up. Open the assignment again from your course.",
  expired: "This assignment link has expired. Open the assignment again from your course.",
  gone: "This assignment's files are no longer available. Ask your instructor.",
  bundle_invalid: "This assignment's files can't be opened. Ask your instructor.",
};

const PATH = /^\/lti\/f\/[A-Za-z0-9_.-]{1,1100}\/manifest$/;
const HEX64 = /^[0-9a-f]{64}$/;

/**
 * The collection a `#lti=` link names, or why not (a sentence for the page).  `hash` is location.hash, `site` this
 * page's origin.
 */
export async function loadLti(hash: string, site: string, fetchFn: typeof fetch, origins: Record<string, string> = LTI_ORIGINS): Promise<LtiLoaded | string> {
  if (!hash.startsWith("#lti=")) return "This is not a link to a shared collection.";
  const tool = Object.hasOwn(origins, site) ? origins[site] : null;
  let link: URL;
  try {
    link = new URL(decodeURIComponent(hash.slice(5)));
  } catch {
    return BAD_LINK;
  }
  if (!tool || link.origin !== tool || !PATH.test(link.pathname) || link.search || link.hash || link.username || link.password) return BAD_LINK;
  let r: Response;
  try {
    r = await fetchFn(link.href, { credentials: "omit", redirect: "error", referrerPolicy: "no-referrer" });
  } catch {
    return "Sagebrush couldn't reach your course's files. Check your connection, then open the assignment again from your course.";
  }
  if (!r.ok) {
    let code = "";
    try {
      code = String(((await r.json()) as { error?: unknown }).error ?? "");
    } catch {}
    return Object.hasOwn(LTI_REFUSALS, code) ? LTI_REFUSALS[code] : `Your course's files couldn't be loaded (HTTP ${r.status}). Open the assignment again from your course.`;
  }
  let m: { copy?: unknown; title?: unknown; created?: unknown; sha256?: unknown; files?: unknown };
  try {
    m = await r.json();
  } catch {
    return BAD_LINK;
  }
  const base = `${link.origin}${link.pathname.slice(0, -"manifest".length)}`;
  const files: LtiFile[] = [];
  const urls = new Map<string, string>();
  if (typeof m.copy !== "string" || !/^[0-9a-f]{32}$/.test(m.copy) || typeof m.title !== "string" || !Number.isSafeInteger(m.created) || typeof m.sha256 !== "string" || !HEX64.test(m.sha256) || !Array.isArray(m.files)) return BAD_LINK;
  for (const f of m.files as { path?: unknown; size?: unknown; sha256?: unknown; url?: unknown }[]) {
    // (each file under this same link, on the tool's origin: nothing the list names may send the page elsewhere)
    if (typeof f?.path !== "string" || !f.path || urls.has(f.path) || !Number.isSafeInteger(f.size) || (f.size as number) < 0 || typeof f.sha256 !== "string" || !HEX64.test(f.sha256) || typeof f.url !== "string") return BAD_LINK;
    let u: URL;
    try {
      u = new URL(f.url);
    } catch {
      return BAD_LINK;
    }
    if (u.href !== f.url || !f.url.startsWith(base) || !/^\d{1,9}-\d{1,9}\.[0-9a-f]{32}$/.test(f.url.slice(base.length))) return BAD_LINK;
    urls.set(f.path, f.url);
    files.push({ path: f.path, size: f.size as number, sha256: f.sha256 });
  }
  return {
    id: `lti:${m.copy}`,
    // (one revision, never "a newer version": that link is a share's)
    version: m.sha256,
    latest: m.sha256,
    manifest: { title: m.title, created: new Date(m.created as number).toISOString(), files },
    fileUrl: (f) => urls.get(f.path) ?? "",
  };
}
