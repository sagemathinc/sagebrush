// sagebrush-selftest.js's entry (web/build.ts): the app self-test's lazily loaded module, imported by selftest()
// in web/index.html only when the app's self-test runs.  The COI diagnosis (selftest-diagnose.js, whose source
// app/selftest/test-diagnose.mjs also runs as a plain script, so it holds no re-export) and the Terminal's checks
// of its shell worker in the real app (selftest-terminal.js).
export * from "./selftest-diagnose.js";
export { terminalChecks, TERMINAL_CHECKS } from "./selftest-terminal.js";
