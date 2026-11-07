# Content-host configuration

William chose a fresh Sagebrush-only production `.com` / staging `.dev` content pair plus a submission to the PRIVATE section of the Public Suffix List (November 7, 2026). Names remain unconfirmed. Only William checks availability, purchases domains, changes DNS, submits to the PSL or deploys.

`web/content-domains.mts` is the configuration source. Pending roots and role origins are empty. The files Worker’s routes and the DEV API’s `FILES_ORIGIN` binding continue using the existing compatibility origins. Production sharing stays disabled. No hosted runner or renderer is enabled.

When William supplies names, set the corresponding root and exact `https://files.<root>` origin in a reviewed configuration change. The files Worker derives its hostname list from the same value that supplies the site’s `FILES_ORIGIN`. Its legacy hostname remains alongside the new one for old raw links. No path, query, signature, bucket, database or key changes here. Raw links and exported URLs require an explicit retention decision before removing compatibility hosting.

Dynamic consumers already use the binding: collection responses in `web/share/server.ts` expose `files_origin`; shared viewers read that response; signed sync reads in `web/sync/server.ts` use `FILES_ORIGIN` for the no-store 303. Their authentication, signatures, paths and environment data stay unchanged. Local test origins remain injectable.

`runOrigin` and `renderOrigin` are reserved configuration, both empty. They do not supply runner frame URLs or output-shell URLs. Existing `web/output-shell/sites.mts` URLs remain empty, and its denial list includes legacy and pending content roots. The two-label site heuristic is deliberately not relaxed for a PRIVATE suffix. A later activation review must establish PSL adoption in supported browsers, actual role site boundaries, exact-host CSP/ancestors, cookie-free hosting and the existing real-host isolation gates. If PSL acceptance or rollout fails, keep the packaged variants and choose a separately reviewed domain layout.

The migration inventory originally found 17 references in 13 files before the output renderer landed. Those references now name this configuration or the `FILES_ORIGIN` binding. The two legacy root literals are centralized here to preserve current routes and existing output-shell rejections. Historical notes are not rewritten. Tests derive their legacy-host rejection controls from the same compatibility list.
