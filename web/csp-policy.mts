// The site's Content-Security-Policy, for every HTML page: a second line of
// defense (design/security.md).  Were something ever to slip markup past
// web/safe-html.ts and the other checks, no script it brought could run:
// scripts only from this site, and a page's own inline scripts by their
// hashes; no plugins, no <base>, no forms; and Cloudflare's Web Analytics
// beacon, which the site's host adds to its pages.  (Images and fetches may
// come from elsewhere: Markdown's images, ?doc= boards.  The Python worker,
// which compiles to JavaScript, has its own response and so its own policy:
// none.)  Static pages get it from _headers (web/csp.ts writes them), the
// atlas's pages, which its Worker renders, from web/atlas/server.ts.
export function pagePolicy(scriptHashes: string[] = []): string {
  return [
    "default-src 'self'",
    ["script-src 'self' 'wasm-unsafe-eval' https://static.cloudflareinsights.com", ...scriptHashes].join(" "),
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https: http:",
    "font-src 'self' data:",
    // (and the agent pairing's socket to sagebrush-mcp on this computer, design/workspace-agent-protocol.md §2: the
    // loopback addresses only; `http:` doesn't admit ws:, so without these Chrome refuses the connection)
    "connect-src 'self' data: blob: https: http: ws://127.0.0.1:* ws://localhost:*",
    "worker-src 'self' blob:",
    "media-src 'self' data: blob:",
    "frame-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "manifest-src 'self'",
  ].join("; ");
}

// The shell worker's (web/shell/worker-boot.js; plan-bash-shell r3 §6): a
// dedicated worker gets the policy of its own script's response, so this one
// is the shell's, not the page's.  Its scripts: the bootstrap, from this
// site, and the shell's module, which the bootstrap imports from a blob: URL
// made of bytes the page checked against their package set's pins.  No eval
// (the module needs none: a test runs every command under this policy), no
// network of any kind, no further workers, no forms.
export function shellWorkerPolicy(): string {
  return [
    "default-src 'none'",
    "script-src 'self' blob:",
    "connect-src 'none'",
    "worker-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
}

// The runner's (web/runner/index.html; design/runner.md): Python's
// interpreter in an opaque-origin sandboxed frame, whose worker (a blob:)
// inherits this policy.  It may run compiled Python (eval) and WebAssembly;
// it has no network at all (the page fetches what it needs and hands it over),
// no frames, no forms.
export function runnerPolicy(scriptHashes: string[] = []): string {
  return [
    "default-src 'none'",
    ["script-src 'unsafe-eval' 'wasm-unsafe-eval' blob:", ...scriptHashes].join(" "),
    "worker-src blob:",
    "connect-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'self'",
  ].join("; ");
}

// The frame other sites show a board in (/frame/board/; design/frame.md): a
// downloaded board's page, served by this site, sandboxed without
// allow-same-origin, so that it has an opaque origin however a page embeds
// it (with the iframe's sandbox attribute or without): a board another site
// posts to it can never run as this site, nor reach its storage.  That, not
// this policy, is what keeps others' code from the site.  Its scripts are
// what a downloaded file runs: its own inline ones by their hashes, the
// engine's and KaTeX's modules from blob: URLs, and the runner's files-mode
// frame (a srcdoc, which inherits this policy) with its one inline script by
// its hash (`runnerScriptHash`), whose interpreter compiles Python to
// JavaScript (eval).  Popups (its links) open unsandboxed; downloads
// (Download as HTML) are allowed.  Any page may show it.
export function framePolicy(scriptHashes: string[] = [], runnerScriptHash = ""): string {
  return [
    "default-src 'self'",
    ["script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval' blob:", ...scriptHashes, runnerScriptHash].filter(Boolean).join(" "),
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https: http:",
    "font-src 'self' data:",
    "connect-src 'self' data: blob: https: http:",
    "worker-src 'self' blob:",
    "media-src 'self' data: blob:",
    "frame-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox allow-downloads",
    "frame-ancestors *",
  ].join("; ");
}
