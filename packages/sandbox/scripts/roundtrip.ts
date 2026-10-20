// Build step 1 check: create, provision, stop, start and delete one sandbox against real Lima.
//
//   node packages/sandbox/dist/scripts/roundtrip.js [--name rt] [--template template:debian-12] [--keep]
//
// Done when the provisioning command writes a forwarded variable into a writable mount on the host.
// The folder is mounted twice: writable at /workspace/out and read-only under the VM user's home.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { LimaProvider, type Log } from "../src/index.js";

const { values } = parseArgs({
  options: {
    name: { type: "string", default: "roundtrip" },
    template: { type: "string", default: "template:debian-12" },
    cpus: { type: "string", default: "2" },
    memory: { type: "string", default: "2" },
    disk: { type: "string", default: "10" },
    keep: { type: "boolean", default: false },
  },
});

const name = values.name!;
const token = `secret-${Math.random().toString(36).slice(2)}`;
process.env.KUMIKO_ROUNDTRIP_TOKEN = token;

const provider = new LimaProvider();
const log: Log = (line, kind) => console.log(`${kind ? `[${kind}] ` : ""}${line}`);
const step = (s: string) => console.log(`\n=== ${s} ===`);
const status = async () => (await provider.list()).find((s) => s.name === name);

const dir = await mkdtemp(join(tmpdir(), "kumiko-roundtrip-"));
let ok = false;
try {
  step(`create km-${name} with ${dir} at /workspace/out (writable) and ~/.kumiko-ro (read-only)`);
  await provider.create(
    {
      name,
      template: values.template,
      cpus: Number(values.cpus),
      memoryGiB: Number(values.memory),
      diskGiB: Number(values.disk),
      mounts: [
        { hostPath: dir, writable: true, guestPath: "/workspace/out" },
        { hostPath: dir, writable: false, guestPath: "~/.kumiko-ro" },
      ],
      env: ["KUMIKO_ROUNDTRIP_TOKEN"],
      provision: [
        `echo "provisioning as $(whoami) on $(hostname)"`,
        "sudo true",
        "test -d ~/.kumiko-ro",
        "! touch ~/.kumiko-ro/should-fail 2>/dev/null",
        `printf '%s' "$KUMIKO_ROUNDTRIP_TOKEN" > /workspace/out/token`,
      ].join("\n"),
    },
    log,
  );
  const written = await readFile(join(dir, "token"), "utf8");
  if (written !== token) throw new Error(`token mismatch: wrote ${JSON.stringify(written)}`);
  console.log("forwarded variable reached the host mount ✓");
  const info = await status();
  if (info?.status !== "running" || info.meta?.setup !== "ready") throw new Error(`unexpected state ${JSON.stringify(info)}`);

  step("exec: stdin after the preamble reaches the command");
  const child = provider.exec(name, "cat", []);
  let out = "";
  child.stdout!.on("data", (c) => (out += c));
  child.stdin!.end("hello through stdin\n");
  await new Promise((r) => child.on("close", r));
  if (out.trim() !== "hello through stdin") throw new Error(`exec stdin mismatch: ${JSON.stringify(out)}`);
  console.log("exec stdin ✓");

  step("stop");
  await provider.stop(name, log);
  if ((await status())?.status !== "stopped") throw new Error("not stopped");

  step("start (provisioning must not run again)");
  await rm(join(dir, "token"));
  await provider.start(name, log);
  if ((await status())?.status !== "running") throw new Error("not running");
  if (await readFile(join(dir, "token"), "utf8").then(() => true, () => false)) throw new Error("provisioning ran twice");
  ok = true;
} finally {
  if (!values.keep) {
    step("delete");
    await provider.delete(name, log).catch((e) => console.error(String(e)));
  }
  await rm(dir, { recursive: true, force: true });
}
console.log(ok ? "\nround trip OK" : "\nround trip FAILED");
process.exit(ok ? 0 : 1);
