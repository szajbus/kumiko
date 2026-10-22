import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { managedInstructions } from "../src/projects.js";
import { systemPrompt } from "../src/widgets.js";

/** The docs page that shows the agent's instructions word for word; from dist/test, the repo is four up. */
const PAGE = new URL("../../../../apps/docs/src/content/docs/reference/agent-instructions.md", import.meta.url);

describe("the docs' copy of what the agent is told", () => {
  it("is what Kumiko writes", async () => {
    const page = await readFile(PAGE, "utf8");
    const managed = managedInstructions({ id: "web", clonePath: "<clone>", worktreesPath: "<worktrees>", createdAt: "" });
    assert.ok(page.includes("```markdown wrap\n" + managed + "```\n"), "kumiko.md in the docs differs from managedInstructions()");
    assert.ok(page.includes("```text wrap\n" + systemPrompt("<folder>") + "\n```\n"), "the system prompt in the docs differs from systemPrompt()");
  });
});
