/**
 * Turning what the chat drew back into Markdown, to copy a selection with its formatting. It reads the DOM through
 * `MdNode`, the little of it that it needs, so it runs in Node's tests without a browser.
 */
export interface MdNode {
  /** 1 for an element, 3 for text, 11 for a fragment. */
  readonly nodeType: number;
  readonly nodeName: string;
  readonly textContent: string | null;
  readonly childNodes: ArrayLike<MdNode>;
  getAttribute?(name: string): string | null;
  /** A checkbox's state, which cloning keeps though it isn't an attribute. */
  readonly checked?: boolean;
}

const ELEMENT = 1;
const TEXT = 3;

/** Elements that start a block of their own; anything else flows within the text around it. */
const BLOCKS = new Set([
  "ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "DD", "DETAILS", "DIV", "DL", "DT", "FIELDSET", "FIGCAPTION", "FIGURE",
  "FOOTER", "FORM", "H1", "H2", "H3", "H4", "H5", "H6", "HEADER", "HR", "LI", "MAIN", "NAV", "OL", "P", "PRE", "SECTION",
  "SUMMARY", "TABLE", "UL",
]);

/** A code fence for `code`: longer than any run of backticks in it, so none of them closes it. */
export function fence(code: string, lang = ""): string {
  const longest = Math.max(0, ...(code.match(/`+/g) ?? []).map((run) => run.length));
  const bar = "`".repeat(Math.max(3, longest + 1));
  return `${bar}${lang}\n${code}\n${bar}`;
}

/** The language a `<code>` is marked as, "language-ts" in its class. */
function langOf(node: MdNode | undefined): string {
  return node?.getAttribute?.("class")?.match(/language-(\S+)/)?.[1] ?? "";
}

const kids = (node: MdNode): MdNode[] => Array.from(node.childNodes);
const tag = (node: MdNode) => node.nodeName.toUpperCase();
const attr = (node: MdNode, name: string) => node.getAttribute?.(name) ?? null;

/** What isn't content: buttons, icons and anything drawn only for the eye. */
function skipped(node: MdNode): boolean {
  return ["BUTTON", "SVG", "STYLE", "SCRIPT"].includes(tag(node)) || attr(node, "aria-hidden") === "true";
}

/** `inner` between `mark`s, with the spaces at its ends left outside, where Markdown wants them. */
function wrap(inner: string, mark: string): string {
  const m = inner.match(/^(\s*)([\s\S]*?)(\s*)$/)!;
  return m[2] ? `${m[1]}${mark}${m[2]}${mark}${m[3]}` : inner;
}

function inlineCode(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const ticks = "`".repeat(longest + 1);
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return text ? `${ticks}${pad}${text}${pad}${ticks}` : "";
}

function inline(node: MdNode): string {
  if (node.nodeType === TEXT) return node.textContent ?? "";
  if (node.nodeType !== ELEMENT && node.nodeType !== 11) return "";
  if (skipped(node)) return "";
  const inner = () => kids(node).map(inline).join("");
  switch (tag(node)) {
    case "STRONG":
    case "B":
      return wrap(inner(), "**");
    case "EM":
    case "I":
      return wrap(inner(), "*");
    case "DEL":
    case "S":
      return wrap(inner(), "~~");
    case "CODE":
      return inlineCode(node.textContent ?? "");
    case "BR":
      return "\n";
    case "A": {
      const text = inner();
      const href = attr(node, "href");
      if (!href || !text.trim() || text === href) return text;
      return wrap(`[${text.trim()}](${href})`, "");
    }
    case "IMG": {
      const src = attr(node, "src");
      const alt = attr(node, "alt") ?? "";
      return src ? `![${alt}](${src})` : alt;
    }
    case "INPUT":
      return attr(node, "type") === "checkbox" ? (node.checked || attr(node, "checked") !== null ? "[x]" : "[ ]") : "";
    default:
      return inner();
  }
}

/** The Markdown of `nodes`, block by block: text between blocks makes a paragraph of its own. */
function blocks(nodes: MdNode[]): string[] {
  const out: string[] = [];
  let run = "";
  const flush = () => {
    // Whitespace between blocks is only the layout of the HTML.
    if (run.trim()) out.push(run.replace(/^\s*\n/, "").trimEnd().replace(/^[ \t]+/, ""));
    run = "";
  };
  for (const node of nodes) {
    if (node.nodeType === ELEMENT && BLOCKS.has(tag(node))) {
      if (skipped(node)) continue;
      flush();
      const b = block(node);
      if (b.trim()) out.push(b);
    } else if (node.nodeType === 11) {
      flush();
      out.push(...blocks(kids(node)));
    } else {
      run += inline(node);
    }
  }
  flush();
  return out;
}

const join = (parts: string[]) => parts.join("\n\n");

/** Every line of `text` after `first` on the first, and `rest` before each line after it, but blank ones. */
function prefix(text: string, first: string, rest: string): string {
  return text
    .split("\n")
    .map((l, i) => (i === 0 ? first + l : l ? rest + l : rest.trimEnd()))
    .join("\n");
}

function list(node: MdNode): string {
  const ordered = tag(node) === "OL";
  let n = Number(attr(node, "start") ?? 1) || 1;
  const items = kids(node).filter((k) => k.nodeType === ELEMENT && tag(k) === "LI");
  return items
    .map((li) => {
      const marker = ordered ? `${n++}. ` : "- ";
      const body = join(blocks(kids(li))) || "";
      return prefix(body, marker, " ".repeat(marker.length));
    })
    .join("\n");
}

function table(node: MdNode): string {
  const rows: MdNode[] = [];
  const collect = (n: MdNode) => {
    for (const k of kids(n)) {
      if (k.nodeType !== ELEMENT) continue;
      if (tag(k) === "TR") rows.push(k);
      else if (["THEAD", "TBODY", "TFOOT"].includes(tag(k))) collect(k);
    }
  };
  collect(node);
  const cells = rows.map((r) =>
    kids(r)
      .filter((c) => c.nodeType === ELEMENT && (tag(c) === "TH" || tag(c) === "TD"))
      .map((c) => inline(c).replace(/\s*\n\s*/g, " ").trim().replace(/\|/g, "\\|")),
  );
  if (!cells.length) return "";
  const width = Math.max(...cells.map((r) => r.length));
  const line = (r: string[]) => `| ${Array.from({ length: width }, (_, i) => r[i] ?? "").join(" | ")} |`;
  return [line(cells[0]!), `|${" --- |".repeat(width)}`, ...cells.slice(1).map(line)].join("\n");
}

function block(node: MdNode): string {
  const t = tag(node);
  if (/^H[1-6]$/.test(t)) return `${"#".repeat(Number(t[1]))} ${inline(node).replace(/\s*\n\s*/g, " ").trim()}`;
  switch (t) {
    case "PRE": {
      const code = kids(node).find((k) => k.nodeType === ELEMENT && tag(k) === "CODE");
      return fence((node.textContent ?? "").replace(/\n$/, ""), langOf(code));
    }
    case "BLOCKQUOTE":
      return prefix(join(blocks(kids(node))), "> ", "> ");
    case "UL":
    case "OL":
      return list(node);
    case "TABLE":
      return table(node);
    case "HR":
      return "---";
    default:
      return join(blocks(kids(node)));
  }
}

/** `node`, a fragment of the chat as a rule, as Markdown, without blank lines around it. */
export function markdownOf(node: MdNode): string {
  return join(blocks([node]))
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Elements a selection inside them keeps, though they aren't in what it copies: they say how its text is formatted. */
const FORMATS = new Set(["PRE", "CODE", "STRONG", "B", "EM", "I", "DEL", "S", "A"]);
/** Elements a selection keeps when it starts in them: it spans their items or cells, and needs them to lay those out. */
const STRUCTURES = new Set(["UL", "OL", "TABLE", "THEAD", "TBODY", "TFOOT", "TR"]);

/**
 * Which of the elements around a selection, from the one that holds all of it outwards, to wrap what it copies in.
 * The formats always, as a selection within a code block is still code. Lists and tables only from where the selection
 * starts: across items of a list it is a list, while text in one item is just text.
 */
export function keptAround<T extends MdNode>(ancestors: T[]): T[] {
  let structural = true;
  return ancestors.filter((a) => {
    structural &&= STRUCTURES.has(tag(a));
    return structural || FORMATS.has(tag(a));
  });
}
