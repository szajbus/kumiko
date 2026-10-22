import { memo, useState, type ComponentProps } from "react";
import ReactMarkdown, { type Components, type ExtraProps } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Diagram } from "./Diagram";
import { imageSource } from "./imageSource";

/** The text of a hast node and everything in it. */
type Element = NonNullable<ExtraProps["node"]>;

function textOf(node: Element | undefined): string {
  if (!node) return "";
  return node.children.map((c) => (c.type === "text" ? c.value : c.type === "element" ? textOf(c) : "")).join("");
}

/** A code block, with a button to copy its text that shows when the pointer is over it. */
function CodeBlock({ node, ...props }: ComponentProps<"pre"> & ExtraProps) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard.writeText(textOf(node).replace(/\n$/, "")).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <div className="md-code">
      <pre {...props} />
      <button type="button" className="md-code-copy" onClick={copy} title="Copy the code">
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

// Links open outside the app (the desktop shell sends new windows to the browser). Raw HTML is never rendered. Images
// load only from where `imageSource` lets them; others show their text instead.
const components: Components = {
  a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" />,
  pre: CodeBlock,
  img: ({ node: _node, src, alt, ...props }) => {
    const shown = imageSource(src);
    if (shown) return <img {...props} src={shown} alt={alt} />;
    return (
      <span className="md-image-blocked" title={typeof src === "string" ? `Not loaded: ${src}` : undefined}>
        {alt || "image"}
      </span>
    );
  },
};

/** The same, with ```mermaid blocks drawn as diagrams. */
const withDiagrams: Components = {
  ...components,
  pre: ({ node, ...props }) => {
    const code = node?.children[0];
    const lang = code?.type === "element" && code.tagName === "code" ? code.properties.className : undefined;
    if (Array.isArray(lang) && lang.includes("language-mermaid")) {
      return <Diagram source={textOf(node)} />;
    }
    return <CodeBlock node={node} {...props} />;
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
