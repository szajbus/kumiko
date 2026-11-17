import { memo, useContext, useState, useSyncExternalStore, type ComponentProps } from "react";
import ReactMarkdown, { type Components, type ExtraProps } from "react-markdown";
import remarkGfm from "remark-gfm";
import { codeWrap } from "./codeWrap";
import { Diagram } from "./Diagram";
import { fenceLanguage } from "./highlight";
import { HighlightedCode } from "./Highlighted";
import { imageSource } from "./imageSource";
import { RevealButton } from "./RevealButton";
import { WindowContext } from "./windowContext";

/** The text of a hast node and everything in it. */
type Element = NonNullable<ExtraProps["node"]>;

function textOf(node: Element | undefined): string {
  if (!node) return "";
  return node.children.map((c) => (c.type === "text" ? c.value : c.type === "element" ? textOf(c) : "")).join("");
}

/**
 * A code block, with buttons that show when the pointer is over it: one to copy its text, one to wrap long lines, in this
 * block and every other.
 */
function CodeBlock({ node, className, children, ...props }: ComponentProps<"pre"> & ExtraProps) {
  const [copied, setCopied] = useState(false);
  // The block's <code>, with its language as remark marks it ("language-ts"): drawn here, in its colours.
  const code = node?.children[0]?.type === "element" && node.children[0].tagName === "code" ? node.children[0] : undefined;
  const codeClass = code ? ([] as unknown[]).concat(code.properties.className ?? []).map(String) : [];
  const lang = fenceLanguage(codeClass.find((c) => c.startsWith("language-"))?.slice("language-".length));
  const wrapped = useSyncExternalStore(codeWrap.subscribe, codeWrap.get);
  const copy = () => {
    void navigator.clipboard.writeText(textOf(node).replace(/\n$/, "")).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <div className="md-code">
      <pre {...props} className={wrapped ? `${className ?? ""} md-code-wrapped`.trim() : className}>
        {code ? (
          <code className={codeClass.join(" ") || undefined}>
            <HighlightedCode code={textOf(code).replace(/\n$/, "")} lang={lang} />
          </code>
        ) : (
          children
        )}
      </pre>
      <div className="md-code-actions">
        <button
          type="button"
          className="md-code-btn"
          aria-pressed={wrapped}
          onClick={() => codeWrap.set(!wrapped)}
          title={wrapped ? "Stop wrapping long lines in code blocks" : "Wrap long lines in code blocks"}
        >
          Wrap
        </button>
        <button type="button" className="md-code-btn" onClick={copy} title="Copy the code">
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}

/** Inline code; a path in it that is a file on this Mac gets a button that reveals it in the Finder. */
function InlineCode({ node: _node, children, ...props }: ComponentProps<"code"> & ExtraProps) {
  const ctx = useContext(WindowContext);
  const path = typeof children === "string" ? ctx?.revealable(children) : undefined;
  if (!path) return <code {...props}>{children}</code>;
  return (
    <span className="md-path">
      <code {...props}>{children}</code>
      <RevealButton path={path} className="md-path-btn" />
    </span>
  );
}

// Links open outside the app (the desktop shell sends new windows to the browser). Raw HTML is never rendered. Images
// load only from where `imageSource` lets them; others show their text instead.
const components: Components = {
  a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" />,
  pre: CodeBlock,
  code: InlineCode,
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
