import { pieces, type Token } from "./highlight";

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
