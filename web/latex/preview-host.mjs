// The LaTeX editor's preview host (web/build.ts; read by the build script only, never bundled): with
// SAGEBRUSH_LATEX_PREVIEW=1, SAGEBRUSH_PREVIEW_HOST names one more host where the editor may be turned on (the user
// still asks, with ?latex=1). It must be exactly one hostname under sagebrush.cloud; anything else stops the build.
// Unset, or with the flag unset or "test", it is ignored.
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** The extra host for this build: null when there is none; throws on a value that isn't allowed. */
export function previewHost(mode, raw) {
  if (mode !== "1" || raw === undefined || raw === "") return null;
  const h = String(raw);
  const labels = h.split(".");
  const ok = h.length <= 253 && h.endsWith(".sagebrush.cloud") && labels.length >= 3 && labels.every((l) => LABEL.test(l));
  if (!ok) throw new Error(`SAGEBRUSH_PREVIEW_HOST must be one lowercase hostname under .sagebrush.cloud, not ${JSON.stringify(h)}`);
  return h;
}
