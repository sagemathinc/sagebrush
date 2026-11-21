#!/usr/bin/env node
// TCP readiness only: retry a refused connection, bound each probe and the whole
// wait, and close every socket. No shell sleep or HTTP body can hang this check.
import { createConnection } from "node:net";
import { pathToFileURL } from "node:url";
import { waitFor } from "../web/test-deadline.mjs";

export const waitForPort = (port, ms, host = "127.0.0.1") => waitFor("waitForPort", `${host}:${port} listening`, (remaining) => new Promise((resolve) => {
  const socket = createConnection({ host, port });
  const done = (ready) => { socket.destroy(); resolve(ready); };
  socket.setTimeout(Math.min(1000, remaining), () => done(false));
  socket.once("error", () => done(false));
  socket.once("connect", () => done(true));
}), ms);

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.argv[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("usage: wait-for-port.mjs PORT [TIMEOUT_MS]");
  await waitForPort(port, process.argv[3] === undefined ? undefined : Number(process.argv[3]));
  console.log(`waitForPort(127.0.0.1:${port} listening): ready`);
}
