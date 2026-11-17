# Kumiko

The docs are the place to learn the project: start at `apps/docs/src/content/docs/overview/`, and read
`development/` before changing code. The README is only the pitch and the commands.

## Docs

- Pages are Markdown in `apps/docs/src/content/docs`, built with Starlight (`npm run docs:dev`, `npm run docs:build`).
- Write and restructure pages with `.claude/skills/documentation/SKILL.md`, then edit the text with every rule in
  `.claude/skills/unslop/SKILL.md`. Read both before docs work.
- Update the docs in the same commit as the change they describe. A changed decision changes
  `overview/decisions.md`.
- `reference/agent-instructions.md` quotes Kumiko's instructions to the agent word for word, and
  `packages/server/test/docs.test.ts` checks it. Change those blocks only through the code.
- When the UI changes visibly, retake the screenshots: `npm run build && node apps/docs/scripts/screenshots.mjs`.

The skills are copied from upstream: `documentation` from `anthropics/knowledge-work-plugins`
(`engineering/skills/documentation`, Apache-2.0) and `unslop` from `cursor/plugins` (`pstack/skills/unslop`).
