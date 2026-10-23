import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { SessionEvent } from "@kumiko/shared";
import { ArtifactContent } from "../src/content.js";

describe("artifacts' content", () => {
  let dir: string;
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "kumiko-content-test-"));
  });
  after(() => rm(dir, { recursive: true, force: true }));

  it("keeps each version once, by its hash", async () => {
    const store = new ArtifactContent(join(dir, "once"));
    const a = await store.put(Buffer.from("# A\n"));
    assert.equal(await store.put(Buffer.from("# A\n")), a);
    assert.equal((await store.get(a))?.toString(), "# A\n");
    assert.equal(await store.get("../secret"), undefined);
    assert.deepEqual(await readdir(store.dir), [a]);
  });

  it("sweeps the versions no window names, wherever its ops name them", async () => {
    const store = new ArtifactContent(join(dir, "sweep"));
    const [added, updated, synced, gone] = await Promise.all(["1", "2", "3", "4"].map((t) => store.put(Buffer.from(t))));
    const op = (o: unknown, seq: number) => ({ seq, kind: "window", payload: { op: o } }) as SessionEvent;
    await store.sweep([
      op({ type: "add", widget: "w2", kind: "artifact", state: { path: "/a.md", type: "markdown", title: "A", content: added } }, 1),
      op({ type: "update", widget: "w2", op: { content: updated } }, 2),
      op({ type: "sync", widgets: { w2: { kind: "artifact", state: { path: "/a.md", type: "markdown", title: "A", content: synced } } } }, 3),
      { seq: 4, kind: "user_prompt", payload: { text: `content ${gone}`, id: "p1" } },
    ]);
    assert.deepEqual((await readdir(store.dir)).sort(), [added, updated, synced].sort());
  });
});
