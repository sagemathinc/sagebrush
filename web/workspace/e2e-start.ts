// End-to-end sync's code for the page, a chunk of its own (sagebrush-e2e.js, built by web/build.ts): this browser's E2E
// device (e2e/device-keys.ts) and the sealing kit the sync client takes (sync-seal.ts). Fetched only for an account whose
// sync is end-to-end encrypted (sync-e2e.ts), so a page without it carries none of this code.
export { DeviceKeys, DeviceKeysError, resetDevice } from "./e2e/device-keys";
export { sealOps, sopsItem, envHashOf, verifyRow, PULL_START, SealedHalt, sealFile, openFile, sealedSize } from "./sync-seal";
