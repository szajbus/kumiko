// Syntax highlighting for diffs, with Shiki: loaded the first time a diff is shown, and each language when a file of
// it is. Each side of a diff (the old lines, the new ones) is highlighted as one text, so a line is coloured knowing
// the lines before it, then the tokens go back to their rows.

import { useEffect, useState } from "react";
import type { HighlighterCore, LanguageRegistration, ThemeRegistration } from "shiki/core";
import type { DiffRow } from "./diff.ts";

/** A run of a line's text in one colour. `fontStyle` is Shiki's: 1 italic, 2 bold, 4 underline. */
export interface Token {
  content: string;
  color?: string;
  fontStyle?: number;
}

type Grammar = () => Promise<{ default: LanguageRegistration[] }>;

// The languages Kumiko highlights, each its own chunk, loaded when a file of it is shown.
const GRAMMARS: Record<string, Grammar> = {
  astro: () => import("shiki/langs/astro.mjs"),
  bat: () => import("shiki/langs/bat.mjs"),
  c: () => import("shiki/langs/c.mjs"),
  clojure: () => import("shiki/langs/clojure.mjs"),
  cmake: () => import("shiki/langs/cmake.mjs"),
  cpp: () => import("shiki/langs/cpp.mjs"),
  csharp: () => import("shiki/langs/csharp.mjs"),
  css: () => import("shiki/langs/css.mjs"),
  dart: () => import("shiki/langs/dart.mjs"),
  diff: () => import("shiki/langs/diff.mjs"),
  docker: () => import("shiki/langs/docker.mjs"),
  dotenv: () => import("shiki/langs/dotenv.mjs"),
  elixir: () => import("shiki/langs/elixir.mjs"),
  erlang: () => import("shiki/langs/erlang.mjs"),
  fsharp: () => import("shiki/langs/fsharp.mjs"),
  go: () => import("shiki/langs/go.mjs"),
  graphql: () => import("shiki/langs/graphql.mjs"),
  groovy: () => import("shiki/langs/groovy.mjs"),
  haskell: () => import("shiki/langs/haskell.mjs"),
  hcl: () => import("shiki/langs/hcl.mjs"),
  html: () => import("shiki/langs/html.mjs"),
  ini: () => import("shiki/langs/ini.mjs"),
  java: () => import("shiki/langs/java.mjs"),
  javascript: () => import("shiki/langs/javascript.mjs"),
  json: () => import("shiki/langs/json.mjs"),
  jsonc: () => import("shiki/langs/jsonc.mjs"),
  jsx: () => import("shiki/langs/jsx.mjs"),
  julia: () => import("shiki/langs/julia.mjs"),
  kotlin: () => import("shiki/langs/kotlin.mjs"),
  less: () => import("shiki/langs/less.mjs"),
  lua: () => import("shiki/langs/lua.mjs"),
  make: () => import("shiki/langs/make.mjs"),
  markdown: () => import("shiki/langs/markdown.mjs"),
  mdx: () => import("shiki/langs/mdx.mjs"),
  nginx: () => import("shiki/langs/nginx.mjs"),
  nix: () => import("shiki/langs/nix.mjs"),
  "objective-c": () => import("shiki/langs/objective-c.mjs"),
  ocaml: () => import("shiki/langs/ocaml.mjs"),
  perl: () => import("shiki/langs/perl.mjs"),
  php: () => import("shiki/langs/php.mjs"),
  powershell: () => import("shiki/langs/powershell.mjs"),
  prisma: () => import("shiki/langs/prisma.mjs"),
  proto: () => import("shiki/langs/proto.mjs"),
  python: () => import("shiki/langs/python.mjs"),
  r: () => import("shiki/langs/r.mjs"),
  ruby: () => import("shiki/langs/ruby.mjs"),
  rust: () => import("shiki/langs/rust.mjs"),
  scala: () => import("shiki/langs/scala.mjs"),
  scss: () => import("shiki/langs/scss.mjs"),
  shellscript: () => import("shiki/langs/shellscript.mjs"),
  sql: () => import("shiki/langs/sql.mjs"),
  svelte: () => import("shiki/langs/svelte.mjs"),
  swift: () => import("shiki/langs/swift.mjs"),
  toml: () => import("shiki/langs/toml.mjs"),
  tsx: () => import("shiki/langs/tsx.mjs"),
  typescript: () => import("shiki/langs/typescript.mjs"),
  vue: () => import("shiki/langs/vue.mjs"),
  xml: () => import("shiki/langs/xml.mjs"),
  yaml: () => import("shiki/langs/yaml.mjs"),
  zig: () => import("shiki/langs/zig.mjs"),
};

const EXTENSIONS: Record<string, string> = {
  ts: "typescript", mts: "typescript", cts: "typescript", tsx: "tsx",
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "jsx",
  json: "json", jsonc: "jsonc", json5: "jsonc",
  css: "css", scss: "scss", less: "less", html: "html", htm: "html", vue: "vue", svelte: "svelte", astro: "astro",
  md: "markdown", markdown: "markdown", mdx: "mdx",
  yml: "yaml", yaml: "yaml", toml: "toml", ini: "ini", cfg: "ini", conf: "ini", env: "dotenv",
  sh: "shellscript", bash: "shellscript", zsh: "shellscript", fish: "shellscript", ps1: "powershell", bat: "bat", cmd: "bat",
  py: "python", pyi: "python", rb: "ruby", rake: "ruby", gemspec: "ruby", go: "go", rs: "rust",
  java: "java", kt: "kotlin", kts: "kotlin", groovy: "groovy", gradle: "groovy", scala: "scala", swift: "swift",
  c: "c", h: "c", cc: "cpp", cpp: "cpp", cxx: "cpp", hpp: "cpp", hh: "cpp", m: "objective-c", mm: "objective-c",
  cs: "csharp", fs: "fsharp", fsx: "fsharp", php: "php", sql: "sql", graphql: "graphql", gql: "graphql",
  lua: "lua", ex: "elixir", exs: "elixir", erl: "erlang", hrl: "erlang", hs: "haskell", ml: "ocaml", mli: "ocaml",
  clj: "clojure", cljs: "clojure", edn: "clojure", dart: "dart", nix: "nix", jl: "julia", r: "r", pl: "perl", pm: "perl",
  xml: "xml", svg: "xml", plist: "xml", xsd: "xml", diff: "diff", patch: "diff", zig: "zig",
  tf: "hcl", tfvars: "hcl", hcl: "hcl", proto: "proto", prisma: "prisma", cmake: "cmake", mk: "make",
};

const NAMES: Record<string, string> = {
  dockerfile: "docker", containerfile: "docker", makefile: "make", gnumakefile: "make", "cmakelists.txt": "cmake",
  gemfile: "ruby", rakefile: "ruby", brewfile: "ruby", podfile: "ruby", vagrantfile: "ruby",
  ".bashrc": "shellscript", ".zshrc": "shellscript", ".profile": "shellscript", ".bash_profile": "shellscript",
  ".env": "dotenv", "nginx.conf": "nginx", "tsconfig.json": "jsonc", "jsconfig.json": "jsonc",
};

/** The language Kumiko highlights a file as, from its name; undefined for one it doesn't. */
export function languageOf(path: string): string | undefined {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  if (NAMES[name]) return NAMES[name];
  if (name.startsWith("dockerfile.") || name.endsWith(".dockerfile")) return "docker";
  if (name.startsWith(".env.")) return "dotenv";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? EXTENSIONS[name.slice(dot + 1)] : undefined;
}

// The app's own colours, as a TextMate theme: muted, so the diff's green and red still read under them.
const THEME: ThemeRegistration = {
  name: "kumiko",
  type: "dark",
  fg: "#c9ced6",
  bg: "#0b0d10",
  tokenColors: [
    { settings: { foreground: "#c9ced6" } },
    { scope: ["comment", "punctuation.definition.comment", "string.comment"], settings: { foreground: "#6b7383", fontStyle: "italic" } },
    { scope: ["keyword", "storage", "storage.type", "storage.modifier", "keyword.control", "keyword.operator.new", "keyword.operator.expression", "keyword.operator.logical.python", "variable.language"], settings: { foreground: "#c49cf0" } },
    { scope: ["keyword.operator", "punctuation.separator", "punctuation.terminator", "punctuation.accessor"], settings: { foreground: "#9aa1ad" } },
    { scope: ["string", "punctuation.definition.string", "string.quoted", "string.template", "markup.inline.raw"], settings: { foreground: "#e6c07b" } },
    { scope: ["string.regexp", "constant.character.escape", "constant.other.placeholder"], settings: { foreground: "#79c5d8" } },
    { scope: ["constant.numeric", "constant.language", "constant.character", "support.constant", "constant.other.color", "keyword.other.unit"], settings: { foreground: "#f0a37a" } },
    { scope: ["entity.name.function", "support.function", "meta.function-call.generic", "variable.function"], settings: { foreground: "#8fb5f0" } },
    { scope: ["entity.name.type", "entity.name.class", "entity.name.namespace", "support.type", "support.class", "entity.other.inherited-class", "storage.type.java", "storage.type.cs"], settings: { foreground: "#79c5d8" } },
    { scope: ["entity.name.tag", "punctuation.definition.tag", "support.type.property-name.css"], settings: { foreground: "#e88ba8" } },
    { scope: ["entity.other.attribute-name", "support.type.property-name", "meta.object-literal.key", "entity.name.tag.yaml", "support.type.property-name.json", "variable.other.key.toml", "keyword.other.definition.ini"], settings: { foreground: "#a8c3e8" } },
    { scope: ["entity.other.attribute-name.class.css", "entity.other.attribute-name.id.css", "entity.other.attribute-name.pseudo-class.css"], settings: { foreground: "#e6c07b" } },
    { scope: ["markup.heading", "entity.name.section", "punctuation.definition.heading"], settings: { foreground: "#8fa6f0", fontStyle: "bold" } },
    { scope: ["markup.bold"], settings: { fontStyle: "bold" } },
    { scope: ["markup.italic"], settings: { fontStyle: "italic" } },
    { scope: ["markup.underline.link", "string.other.link"], settings: { foreground: "#8fa6f0" } },
    { scope: ["markup.inserted", "punctuation.definition.inserted"], settings: { foreground: "#7fd3a6" } },
    { scope: ["markup.deleted", "punctuation.definition.deleted"], settings: { foreground: "#f29b8f" } },
    { scope: ["meta.diff.range", "meta.diff.header"], settings: { foreground: "#8fa6f0" } },
    { scope: ["invalid"], settings: { foreground: "#f07a6a" } },
  ],
};

let core: Promise<HighlighterCore> | undefined;
const grammars = new Map<string, Promise<void>>();

/** Shiki with the language loaded, both loaded once; undefined if it can't be. */
async function highlighterFor(lang: string): Promise<HighlighterCore | undefined> {
  core ??= Promise.all([import("shiki/core"), import("shiki/engine/javascript")]).then(([{ createHighlighterCore }, { createJavaScriptRegexEngine }]) =>
    // Forgiving: a grammar's pattern the JavaScript engine can't run matches nothing, rather than failing the file.
    createHighlighterCore({ themes: [THEME], langs: [], engine: createJavaScriptRegexEngine({ forgiving: true }) }),
  );
  const h = await core;
  if (!grammars.has(lang)) grammars.set(lang, GRAMMARS[lang]().then((m) => h.loadLanguage(...m.default)));
  await grammars.get(lang);
  return h;
}

/** Past this many lines, a side of a diff isn't highlighted: it would hold up the page. */
const MAX_LINES = 5000;
/** Lines longer than this (minified code, say) are left as they are. */
const MAX_LINE_LENGTH = 1000;

/** The tokens of each line of `lines`, highlighted as `lang`; undefined when it can't or shouldn't be. */
export async function tokenize(lines: string[], lang: string): Promise<Token[][] | undefined> {
  if (!lines.length || lines.length > MAX_LINES || !GRAMMARS[lang]) return undefined;
  const h = await highlighterFor(lang).catch(() => undefined);
  if (!h) return undefined;
  try {
    const out = h.codeToTokensBase(lines.join("\n"), { lang, theme: "kumiko", tokenizeMaxLineLength: MAX_LINE_LENGTH, tokenizeTimeLimit: 500 });
    return out.map((line) => line.map((t) => ({ content: t.content, ...(t.color ? { color: t.color } : {}), ...(t.fontStyle ? { fontStyle: t.fontStyle } : {}) })));
  } catch {
    return undefined;
  }
}

/**
 * Which line a row is, for its tokens: its kind, line numbers and text. Rows are made anew as a diff changes (a gap
 * opened), so the tokens are kept by this rather than by row, and the lines that were there keep their colours.
 */
export const rowKey = (r: DiffRow) => `${r.kind}:${r.old ?? ""}:${r.new ?? ""}:${r.text}`;

/** The tokens of each row's line, by `rowKey`: each side of the diff highlighted on its own, gaps left out. */
export async function rowTokens(rows: readonly DiffRow[], lang: string): Promise<Map<string, Token[]>> {
  const old = rows.filter((r) => r.kind === "context" || r.kind === "remove");
  const neu = rows.filter((r) => r.kind === "context" || r.kind === "add");
  const [a, b] = await Promise.all([tokenize(old.map((r) => r.text), lang), tokenize(neu.map((r) => r.text), lang)]);
  const map = new Map<string, Token[]>();
  if (a) old.forEach((r, i) => r.kind === "remove" && a[i] && map.set(rowKey(r), a[i]));
  if (b) neu.forEach((r, i) => b[i] && map.set(rowKey(r), b[i]));
  return map;
}

const NONE: ReadonlyMap<string, Token[]> = new Map();

/**
 * The tokens of the rows of the file at `path`, by `rowKey`, once highlighted; none for a language Kumiko doesn't
 * know. While new rows are highlighted, the last ones' tokens stay.
 */
export function useRowTokens(path: string, rows: readonly DiffRow[]): ReadonlyMap<string, Token[]> {
  const lang = languageOf(path);
  const [tokens, setTokens] = useState<{ lang: string; map: ReadonlyMap<string, Token[]> }>();
  useEffect(() => {
    if (!lang) return;
    let gone = false;
    void rowTokens(rows, lang).then((map) => !gone && setTokens({ lang, map }));
    return () => {
      gone = true;
    };
  }, [rows, lang]);
  return tokens && tokens.lang === lang ? tokens.map : NONE;
}

/** A piece of a line to draw: a token's text, or part of it, with whether it is in the line's changed part. */
export interface Piece {
  text: string;
  color?: string;
  fontStyle?: number;
  marked: boolean;
}

/**
 * The line `text` as pieces: its tokens, split where the changed part `mark` starts and ends. Tokens that don't spell
 * the line (from another version of it) are left out, and the line is one piece per side of the mark.
 */
export function pieces(text: string, tokens: Token[] | undefined, mark?: [number, number]): Piece[] {
  const runs = tokens && tokens.map((t) => t.content).join("") === text ? tokens : [{ content: text }];
  const out: Piece[] = [];
  let pos = 0;
  for (const t of runs) {
    const start = pos;
    const end = pos + t.content.length;
    pos = end;
    const cuts = [start, ...(mark ? [mark[0], mark[1]].filter((c) => c > start && c < end) : []), end];
    for (let k = 0; k < cuts.length - 1; k++) {
      if (cuts[k] === cuts[k + 1]) continue;
      out.push({
        text: text.slice(cuts[k], cuts[k + 1]),
        ...(t.color ? { color: t.color } : {}),
        ...(t.fontStyle ? { fontStyle: t.fontStyle } : {}),
        marked: Boolean(mark && cuts[k] >= mark[0] && cuts[k] < mark[1]),
      });
    }
  }
  return out;
}
