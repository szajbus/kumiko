#!/usr/bin/env node
// A stand-in for limactl, for tests and UI development without real VMs.
// State lives in $FAKE_LIMA_DIR/<name>.json; every invocation is appended to $FAKE_LIMA_DIR/calls.log.
// $FAKE_LIMA_DELAY (ms) slows down create/start/stop to make progress visible.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.env.FAKE_LIMA_DIR;
if (!dir) {
  console.error("FAKE_LIMA_DIR is not set");
  process.exit(2);
}
mkdirSync(dir, { recursive: true });
const args = process.argv.slice(2);
appendFileSync(join(dir, "calls.log"), JSON.stringify(args) + "\n");

const delay = Number(process.env.FAKE_LIMA_DELAY ?? 0);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const GiB = 1024 ** 3;
const file = (name) => join(dir, `${name}.json`);
const read = (name) => (existsSync(file(name)) ? JSON.parse(readFileSync(file(name), "utf8")) : undefined);
const write = (inst) => writeFileSync(file(inst.name), JSON.stringify(inst));
const info = (msg) => console.error(`time="${new Date().toISOString()}" level=info msg="${msg.replace(/"/g, '\\"')}"`);
const fatal = (msg) => {
  console.error(`time="${new Date().toISOString()}" level=fatal msg="${msg.replace(/"/g, '\\"')}"`);
  process.exit(1);
};
const flag = (name) => args.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
const positional = args.slice(1).filter((a) => !a.startsWith("-"));

switch (args[0]) {
  case "list": {
    for (const f of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
      const inst = JSON.parse(readFileSync(join(dir, f), "utf8"));
      process.stdout.write(JSON.stringify({ ...inst, sshConfigFile: `/fake/${inst.name}/ssh.config` }) + "\n");
    }
    if (!readdirSync(dir).some((f) => f.endsWith(".json"))) info("No instance found.");
    break;
  }
  case "create": {
    if (args.includes("--list-templates")) {
      console.log(["alpine", "archlinux", "debian", "debian-12", "default", "fedora", "ubuntu", "ubuntu-24.04"].join("\n"));
      break;
    }
    const name = flag("name");
    if (read(name)) fatal(`instance "${name}" already exists`);
    if (process.env.FAKE_LIMA_FAIL_CREATE) fatal("simulated create failure");
    const mounts = args.filter((a) => a.startsWith("--mount-only=")).map((a) => a.slice("--mount-only=".length));
    info(`Using the template ${positional.at(-1)}`);
    await sleep(delay);
    write({
      name,
      status: "Stopped",
      cpus: Number(flag("cpus") ?? 4),
      memory: Number(flag("memory") ?? 4) * GiB,
      disk: Number(flag("disk") ?? 100) * GiB,
      template: positional.at(-1),
      mounts,
      mountNone: args.includes("--mount-none"),
    });
    info(`Created instance "${name}"`);
    break;
  }
  case "start": {
    const inst = read(positional[0]) ?? fatal(`instance "${positional[0]}" does not exist`);
    info(`Starting the instance "${inst.name}"`);
    for (let i = 1; i <= 3; i++) {
      await sleep(delay / 3);
      info(`[hostagent] Waiting for the essential requirement ${i} of 3`);
    }
    write({ ...inst, status: "Running" });
    info(`READY. Run \`limactl shell ${inst.name}\` to open the shell.`);
    break;
  }
  case "stop": {
    const inst = read(positional[0]) ?? fatal(`instance "${positional[0]}" does not exist`);
    info(`Sending SIGINT to hostagent process`);
    await sleep(delay);
    write({ ...inst, status: "Stopped" });
    info("Stopped");
    break;
  }
  case "delete": {
    if (!read(positional[0])) fatal(`instance "${positional[0]}" does not exist`);
    rmSync(file(positional[0]));
    info(`Deleted "${positional[0]}"`);
    break;
  }
  default:
    fatal(`unknown command ${args[0]}`);
}
