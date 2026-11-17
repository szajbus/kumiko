import { Fragment } from "react";
import { pieces, useCodeTokens, type Token } from "./highlight";

/**
 * A diff line's text: in its syntax's colours once they are known, with the part that changed in it marked by
 * `markClass`.
 */
export function Highlighted({ text, tokens, mark, markClass }: { text: string; tokens?: Token[]; mark?: [number, number]; markClass: string }) {
  if (!text) return <>{" "}</>;
  if (!tokens && !mark) return <>{text}</>;
  return (
    <>
      {pieces(text, tokens, mark).map((p, i) => {
        const style = p.color || p.fontStyle ? { color: p.color, fontStyle: p.fontStyle && p.fontStyle & 1 ? "italic" : undefined, fontWeight: p.fontStyle && p.fontStyle & 2 ? 600 : undefined } : undefined;
        return (
          <span key={i} className={p.marked ? markClass : undefined} style={style}>
            {p.text}
          </span>
        );
      })}
    </>
  );
}

/** A code block's text, line by line, in the colours of `lang` once they are known; plain before, or with no language. */
export function HighlightedCode({ code, lang }: { code: string; lang: string | undefined }) {
  const tokens = useCodeTokens(code, lang);
  if (!tokens) return <>{code}</>;
  const lines = code.split("\n");
  return (
    <>
      {lines.map((line, i) => (
        <Fragment key={i}>
          {line && <Highlighted text={line} tokens={tokens[i]} markClass="" />}
          {i < lines.length - 1 && "\n"}
        </Fragment>
      ))}
    </>
  );
}
