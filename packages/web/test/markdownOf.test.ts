import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { keptAround, markdownOf, type MdNode } from "../src/markdownOf.ts";

/** Enough of a DOM node for `markdownOf`: an element with attributes and children, or text. */
type Child = MdNode | string;
const text = (t: string): MdNode => ({ nodeType: 3, nodeName: "#text", textContent: t, childNodes: [] });
function h(name: string, attrs: Record<string, string> | Child, ...children: Child[]): MdNode {
  if (typeof attrs === "string" || "nodeType" in attrs) [attrs, children] = [{}, [attrs as Child, ...children]];
  const childNodes = children.map((c) => (typeof c === "string" ? text(c) : c));
  const a = attrs as Record<string, string>;
  return {
    nodeType: name === "#fragment" ? 11 : 1,
    nodeName: name.toUpperCase(),
    get textContent() {
      return childNodes.map((c) => c.textContent).join("");
    },
    childNodes,
    getAttribute: (n) => a[n] ?? null,
  };
}
const frag = (...children: Child[]) => h("#fragment", {}, ...children);

describe("markdownOf", () => {
  it("keeps paragraphs apart and inline formatting", () => {
    const md = frag(h("p", "Some ", h("strong", "bold"), ", ", h("em", "slanted"), " and ", h("code", "code"), "."), "\n", h("p", h("del", "gone")));
    assert.equal(markdownOf(md), "Some **bold**, *slanted* and `code`.\n\n~~gone~~");
  });

  it("writes links, but a bare address as it is", () => {
    assert.equal(markdownOf(frag(h("p", "See ", h("a", { href: "https://x.dev" }, "the docs"), " or ", h("a", { href: "https://y.dev" }, "https://y.dev")))), "See [the docs](https://x.dev) or https://y.dev");
  });

  it("writes headings, rules and quotes", () => {
    const md = frag(h("h2", "Plan"), h("hr", {}), h("blockquote", "\n", h("p", "one"), "\n", h("p", "two"), "\n"));
    assert.equal(markdownOf(md), "## Plan\n\n---\n\n> one\n>\n> two");
  });

  it("fences a code block with its language, and leaves out its buttons", () => {
    const md = frag(h("div", { class: "md-code" }, h("pre", h("code", { class: "language-ts" }, h("span", "const a = 1;"), "\n")), h("div", h("button", "Wrap"), h("button", "Copy"))));
    assert.equal(markdownOf(md), "```ts\nconst a = 1;\n```");
  });

  it("numbers ordered lists from their start, and indents what an item holds", () => {
    const md = frag(h("ol", { start: "3" }, "\n", h("li", "three"), "\n", h("li", h("p", "four"), h("ul", h("li", "a"), h("li", "b"))), "\n"));
    assert.equal(markdownOf(md), "3. three\n4. four\n\n   - a\n   - b");
  });

  it("ticks done tasks", () => {
    const done: MdNode = { ...h("input", { type: "checkbox" }), checked: true };
    assert.equal(markdownOf(frag(h("ul", h("li", done, " done"), h("li", h("input", { type: "checkbox" }), " not")))), "- [x] done\n- [ ] not");
  });

  it("lays out tables, escaping pipes in cells", () => {
    const md = frag(h("table", h("thead", h("tr", h("th", "a"), h("th", "b"))), h("tbody", h("tr", h("td", "1|2"), h("td", h("code", "x"))))));
    assert.equal(markdownOf(md), "| a | b |\n| --- | --- |\n| 1\\|2 | `x` |");
  });

  it("keeps the lines of plain text, as a message the user sent", () => {
    assert.equal(markdownOf(frag(h("div", { class: "msg-user-text" }, "first\nsecond"))), "first\nsecond");
  });

  it("leaves out icons and what is hidden from readers", () => {
    assert.equal(markdownOf(frag(h("p", h("span", { "aria-hidden": "true" }, "•"), h("svg", "x"), "Text"))), "Text");
  });

  it("leaves spaces outside the marks, and drops empty ones", () => {
    assert.equal(markdownOf(frag(h("p", "a", h("strong", " b "), "c", h("em", " ")))), "a **b** c");
  });
});

describe("keptAround", () => {
  const el = (name: string) => h(name, {});

  it("keeps formats wherever they are", () => {
    assert.deepEqual(keptAround([el("span"), el("code"), el("pre"), el("div")]).map((e) => e.nodeName), ["CODE", "PRE"]);
  });

  it("keeps a list only when the selection spans its items", () => {
    assert.deepEqual(keptAround([el("ul"), el("li"), el("ol")]).map((e) => e.nodeName), ["UL"]);
    assert.deepEqual(keptAround([el("li"), el("ul")]).map((e) => e.nodeName), []);
    assert.deepEqual(keptAround([el("tbody"), el("table"), el("div")]).map((e) => e.nodeName), ["TBODY", "TABLE"]);
  });
});
