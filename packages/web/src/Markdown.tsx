import { memo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Diagram } from "./Diagram";

// Links open outside the app (the desktop shell sends new windows to the browser). Raw HTML is never rendered.
const components: Components = {
  a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" />,
};

/** The same, with ```mermaid blocks drawn as diagrams. */
const withDiagrams: Components = {
  ...components,
  pre: ({ node, ...props }) => {
    const code = node?.children[0];
    const lang = code?.type === "element" && code.tagName === "code" ? code.properties.className : undefined;
    if (Array.isArray(lang) && lang.includes("language-mermaid")) {
      const text = code?.type === "element" ? code.children.map((c) => (c.type === "text" ? c.value : "")).join("") : "";
      return <Diagram source={text} />;
    }
    return <pre {...props} />;
  },
};

/**
 * Claude's text as markdown; memoised so finished messages don't re-render while a later one streams. With `diagrams`,
 * ```mermaid blocks are drawn: for artifacts, not the chat, where they would redraw at every delta.
 */
export const Markdown = memo(function Markdown({ text, diagrams = false }: { text: string; diagrams?: boolean }) {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={diagrams ? withDiagrams : components}>
        {text}
      </ReactMarkdown>
    </div>
  );
});
