// A `board open --edit` server in its own process, for test/board-edit-corr153.test.ts (CORR-153-7: a snapshot
// that once threw out of the request callback must leave the server alive).  It edits the board at argv[2],
// listens on 127.0.0.1, prints its port, and runs until it is killed.
import * as http from "http";
import type { AddressInfo } from "net";
import { EditServer, startEdit } from "../src/board-edit-serve";
import { defaultLimits } from "../src/board-edit-limits";


async function main() {
  const L = defaultLimits();
  const started = await startEdit(process.argv[2], L, { now: Date.now });
  if (!("hub" in started)) { console.error(started.why); process.exit(2); }
  const es = new EditServer(started.hub, L, {}, Date.now);
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (!es.handle(req, res, url)) res.writeHead(404).end();
  });
  server.listen(0, "127.0.0.1", () => console.log(`port ${(server.address() as AddressInfo).port}`));
}
void main();
