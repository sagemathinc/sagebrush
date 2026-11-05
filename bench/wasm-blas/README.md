# Wasm BLAS reference: browser driver

`driver.mjs` runs one benchmark page in a freshly launched headless Chrome with
a fresh profile, and writes the page's result plus a ledger of the bytes it
fetched. It is the driver of the Wasm BLAS reference (emscripten-forge NumPy
with OpenBLAS vs the Sagebrush engine, Nov 4, 2026).

```sh
node bench/wasm-blas/driver.mjs URL OUT.json [timeout_s=600]
```

- Before any navigation, the cache is disabled and service workers are
  bypassed.
- The page reports by logging `SBRESULT <json>` to the console; the driver
  never polls it.
- A readiness page (`/ready.html` on the same server) loads first. Only the
  navigation after it is measured, because a fresh Chrome can hold its first
  request for about 25 s.
- `SBWR_CHROME` overrides the browser binary. The default is
  `/usr/bin/google-chrome`, then `/usr/bin/chromium`.

## No Chrome outlives the driver

Chrome runs under a small watchdog shell in a process group of its own. As
soon as the driver or Chrome is gone, the watchdog SIGKILLs the rest of that
group and removes the profile dir. This covers the exits no handler sees:
SIGKILL of the driver, or of the driver's whole process group (Nov 4: a Chrome
tree outlived its killed driver on VM1). Every exit the driver does see
(normal, error, SIGINT, SIGTERM, SIGHUP) also kills the group and removes the
profile itself.

Chrome's crash handlers (`chrome_crashpad_handler`) daemonize into sessions of
their own, out of the group's reach. The profile dir is a fresh `mkdtemp`
path unique to the run, and every process of that Chrome names it in its
arguments. So the watchdog and the driver also SIGKILL exactly the processes
whose arguments name that dir, never by a program name or a pattern.

Both use one matcher. The watchdog has none of its own; it runs
`node driver.mjs --kill-naming DIR SKIP_PID`, which refuses anything but a
`sbwr-udd-` dir. The matcher splits each `/proc/PID/cmdline` at its NUL
argument boundaries, so a newline inside one argument is never a boundary. An
argument names the dir if it is the dir, `--flag=` the dir, or a path that
stays inside the dir after `.` and `..` are resolved. `<dir>/../elsewhere` does
not count. `node driver.mjs --classify DIR < CMDLINE` applies the same test to
a NUL-separated argument list and sends no signal. The test runs one shared
case list through `--classify` and through `--kill-naming` on real processes.

One case remains: a supervisor that SIGKILLs every process at once, the
watchdog included. It leaves no process behind, but nothing is left to remove
the profile dir.

`test/wasm-blas-driver.test.ts` checks every exit path with a stand-in Chrome.
