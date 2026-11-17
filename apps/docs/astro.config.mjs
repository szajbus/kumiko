// The Kumiko docs site: Starlight, built to static HTML in dist/.
//   npm run docs:dev     (from the repo root)
//   npm run docs:build
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import mermaid from "astro-mermaid";

export default defineConfig({
  // Mermaid is one big chunk, loaded only on pages with a diagram.
  vite: { build: { chunkSizeWarningLimit: 4000 } },
  integrations: [
    // Before Starlight, so its code blocks don't claim the mermaid fences.
    mermaid({
      theme: "dark",
      autoTheme: true,
      // Sequence diagrams are wide; at their own size they scroll sideways instead of shrinking to unreadable.
      mermaidConfig: { sequence: { useMaxWidth: false, wrap: true, width: 130, actorMargin: 24, messageFontSize: 13, actorFontSize: 13, noteFontSize: 12 } },
    }),
    starlight({
      title: "Kumiko",
      description: "A desktop app for running Claude Code on your GitHub repositories, in Lima sandboxes of their own.",
      logo: { light: "./src/assets/logo-light.svg", dark: "./src/assets/logo-dark.svg" },
      favicon: "/favicon.svg",
      customCss: ["@fontsource/ibm-plex-sans/400.css", "@fontsource/ibm-plex-sans/600.css", "@fontsource/ibm-plex-mono/400.css", "./src/styles/custom.css"],
      // Read top to bottom: why and how Kumiko is built, what it does, how to use it, then how to work on it.
      sidebar: [
        { label: "Overview", items: ["overview/introduction", "overview/concepts", "overview/principles", "overview/decisions"] },
        { label: "Architecture", items: [{ autogenerate: { directory: "architecture" } }] },
        { label: "Features", items: [{ autogenerate: { directory: "features" } }] },
        { label: "User guide", items: [{ autogenerate: { directory: "guide" } }] },
        { label: "Reference", items: [{ autogenerate: { directory: "reference" } }] },
        { label: "Development", items: [{ autogenerate: { directory: "development" } }] },
      ],
    }),
  ],
});
