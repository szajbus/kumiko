#!/usr/bin/env node
// Stands in for `ssh -N -R <guest>:<host> <vm>`: listens on the guest socket path and connects each connection to the
// host one, until it is killed. Like sshd without StreamLocalBindUnlink, it fails if the guest path is taken.
import { connect, createServer } from "node:net";

const at = process.argv.indexOf("-R");
const spec = process.argv[at + 1] ?? "";
const colon = spec.indexOf(":");
const [guest, host] = [spec.slice(0, colon), spec.slice(colon + 1)];
if (at < 0 || colon <= 0 || !host) {
  console.error(`fake ssh: can't read the forward ${spec}`);
  process.exit(255);
}
// Half-open, as ssh's channels are: git's side finishing its request mustn't cut off the answer.
const server = createServer({ allowHalfOpen: true }, (c) => {
  const up = connect({ path: host, allowHalfOpen: true });
  c.pipe(up).pipe(c);
  up.on("error", () => c.destroy());
  c.on("error", () => up.destroy());
});
server.on("error", (err) => {
  console.error(`Error: remote port forwarding failed for listen path ${guest}: ${err.message}`);
  process.exit(255);
});
server.listen(guest);
// As ssh does when killed: connections under way go with it.
const stop = () => process.exit(0);
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
