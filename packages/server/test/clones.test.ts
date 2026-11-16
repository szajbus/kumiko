import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { describe, it } from "node:test";
import { Clones } from "../src/clones.js";

describe("clones", () => {
  it("lets a repo's removal wait for the cloning under way, and leaves it out of the run still to come", async () => {
    const scripts: string[] = [];
    const finished: string[] = [];
    // Stands in for the VM: each run takes a moment, then says every repo it was given is cloned.
    const exec = (_name: string, cmd: string) => {
      scripts.push(cmd);
      const folders = ["api", "web"].filter((f) => cmd.includes(`acme/${f}`));
      const child = spawn("bash", ["-c", `sleep 0.2; ${folders.map((f) => `echo "ok ${f}"`).join("; ")}`]);
      child.on("exit", () => finished.push(folders.join(",")));
      return child;
    };
    const clones = new Clones(exec as never, () => {});
    const api = { repo: "acme/api", folder: "api" };
    const web = { repo: "acme/web", folder: "web" };
    clones.sync("s", [api]);
    clones.sync("s", [api, web]);
    await clones.settled("s", ["web"]);
    assert.deepEqual(finished, ["api", "api"], "both runs finished before the removal goes on");
    assert.ok(!scripts.some((s) => s.includes("acme/web")), "the queued run left web out");
    assert.deepEqual(clones.view("s", [api]).map((r) => r.state), ["cloned"]);
    await clones.settled("s");
  });
});
