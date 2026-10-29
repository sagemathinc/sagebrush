// Cloudflare deploy entry: helper exports (including the null-prototype MIME table)
// stay in worker.mjs for tooling/tests and never become runtime Worker exports.
import worker from './worker.mjs';
export default worker;
