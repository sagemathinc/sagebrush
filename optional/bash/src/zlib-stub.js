// node:zlib, for just-bash's browser bundle (which imports it for gzip, gunzip
// and tar): not available in the shell worker.  gzip, gunzip and tar are
// deferred (plan-bash-shell r3 §8), so these refuse in words.
const unavailable = () => {
  throw new Error("gzip isn't available in this shell");
};
export const gunzipSync = unavailable;
export const gzipSync = unavailable;
export const constants = {};
