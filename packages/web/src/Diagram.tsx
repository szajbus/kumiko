import { useEffect, useState } from "react";

/** The SVG Mermaid draws, as an image: an <img> never runs scripts or loads anything, whatever the source says. */
const asImage = (svg: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

let mermaid: Promise<typeof import("mermaid").default> | undefined;
let drawn = 0;

/** Loads Mermaid the first time a diagram is drawn: it's large, and most windows never show one. */
function loadMermaid() {
  mermaid ??= import("mermaid").then(({ default: m }) => {
    // Strict: no scripts or click handlers. Labels as SVG text rather than HTML, which an image wouldn't show.
    m.initialize({ startOnLoad: false, securityLevel: "strict", theme: "dark", htmlLabels: false, flowchart: { htmlLabels: false } });
    return m;
  });
  return mermaid;
}

/** A Mermaid diagram drawn from its source; the source and Mermaid's error if it doesn't parse. */
export function Diagram({ source }: { source: string }) {
  const [out, setOut] = useState<{ svg?: string; error?: string }>({});
  useEffect(() => {
    let current = true;
    const id = `km-diagram-${++drawn}`;
    void loadMermaid()
      .then(async (m) => {
        // Checked first: a source that doesn't parse makes render draw its error into the page, and leave it there.
        await m.parse(source);
        return m.render(id, source);
      })
      .then(
        ({ svg }) => current && setOut({ svg }),
        (err: unknown) => current && setOut({ error: err instanceof Error ? err.message : String(err) }),
      )
      // Whatever render left in the page to measure the diagram by.
      .finally(() => {
        for (const leftover of [document.getElementById(id), document.getElementById(`d${id}`)]) leftover?.remove();
      });
    return () => {
      current = false;
    };
  }, [source]);
  if (out.error) {
    return (
      <div className="diagram-error">
        <div className="banner banner-warn">This diagram doesn't draw: {out.error.split("\n")[0]}</div>
        <pre className="mono">{source}</pre>
      </div>
    );
  }
  return out.svg ? <img className="diagram" src={asImage(out.svg)} alt="Diagram" /> : <div className="diagram-wait">Drawing…</div>;
}
