import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { githubInstructions, managedInstructions, setupGuide } from "../src/sandboxes.js";
import { systemPrompt } from "../src/widgets.js";

/** The sandbox's Kumiko folder as the docs show it: at its path on the Mac, as the VM mounts it. */
export const KUMIKO_FOLDER = "/Users/you/.kumiko/sandbox/<sandbox>";

/** The docs page that shows the agent's instructions word for word; from dist/test, the repo is four up. */
const PAGE = new URL("../../../../apps/docs/src/content/docs/reference/agent-instructions.md", import.meta.url);

describe("the docs' copy of what the agent is told", () => {
  it("is what Kumiko writes", async () => {
    const page = await readFile(PAGE, "utf8");
    const sandbox = { name: "<sandbox>", repos: [{ repo: "<owner>/<name>", folder: "<folder>" }] };
    const mounts = [{ hostPath: "<folder on your Mac>", writable: true }];
    const kumiko = KUMIKO_FOLDER;
    assert.ok(page.includes("```markdown wrap\n" + managedInstructions(sandbox, mounts, kumiko) + "```\n"), "kumiko.md in the docs differs from managedInstructions()");
    assert.ok(managedInstructions(sandbox, mounts, kumiko).endsWith(githubInstructions(false)), "the GitHub section ends kumiko.md");
    assert.ok(page.includes("```markdown wrap" + githubInstructions(true) + "```\n"), "kumiko.md's GitHub section for several repos in the docs differs from githubInstructions()");
    const guide = setupGuide({ provision: "…", env: ["GITHUB_TOKEN", "NPM_TOKEN"] }, kumiko);
    assert.ok(page.includes("```markdown wrap\n" + guide + "```\n"), "the setup guide in the docs differs from setupGuide()");
    assert.ok(page.includes("```text wrap\n" + systemPrompt("<folder>") + "\n```\n"), "the system prompt in the docs differs from systemPrompt()");
  });
});

describe("the system prompt", () => {
  it("says Markdown artifacts can't show local images, and how to show one", () => {
    const prompt = systemPrompt("<folder>");
    assert.match(prompt, /Images in a Markdown artifact load only from https addresses: local files and relative paths aren't shown/);
    assert.match(prompt, /open its file as an artifact of its own, or put it in an HTML artifact as a data: URI/);
  });
});
