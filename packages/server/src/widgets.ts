import { cpSync, existsSync, mkdirSync, realpathSync, watch, type FSWatcher } from "node:fs";
import { realpath } from "node:fs/promises";
import { basename, dirname, join, posix, relative, sep } from "node:path";
import {
  CLAUDE_HOME_IN_VM,
  KUMIKO_HOME_IN_VM,
  applyWindowOp,
  isExternalUrl,
  urlHost,
  urlOrigin,
  isPreviewUrl,
  ARTIFACT_FILES,
  artifactTypeOf,
  MAX_IMAGE_BYTES,
  CHAT,
  artifactsOf,
  MAX_ARTIFACT_BYTES,
  nextId,
  paneIds,
  paneOf,
  WindowError,
  type ArtifactState,
  type ArtifactType,
  type Layout,
  type Place,
  type PaneId,
  type WidgetId,
  type SessionEvent,
  type SessionInfo,
  type WindowOp,
  type WindowState,
  LIVE_SESSION_STATUSES,
  isWaiting,
  chatWindow,
} from "@kumiko/shared";
import type { AgentMessage, ToolHost, ToolResult, ToolSpec } from "@kumiko/agent";
import { contentHash, type ArtifactContent } from "./content.js";
import { openIn, removeIn, writeIn } from "./files.js";
import type { SessionWidgets, Sessions } from "./sessions.js";

/** Where a project's files are, for mapping the paths Claude names in its VM to the host. */
export interface WidgetHome {
  /** The project's Claude home on the host, which is `~/.claude` in the VM. */
  claudeHome: string;
  /** The project's Kumiko folder on the host, which is `~/.kumiko` in the VM. */
  kumikoHome: string;
  /** Folders mounted at the same path in the VM and on the host: the clone and its worktrees. */
  roots: string[];
}

/** A window's answer about a pane: the picture asked for, and a note when its page didn't load. */
export interface PaneAnswer {
  image?: { data: string; mimeType: string };
  note?: string;
}

export interface WidgetsOptions {
  /** Where what windows show of their artifacts' files is kept. */
  content: ArtifactContent;
  /** The project's folders, or undefined for a project that isn't known. */
  home(sandbox: string): WidgetHome | undefined;
  /** The VM user's home, absolute, as `~` is in the VM. */
  vmHome(sandbox: string): Promise<string>;
  /**
   * Asks the window showing the session to load the page in pane `pane` again, waiting for it to load, and to take a
   * picture of the pane as it is on screen; resolves with the picture, if one was asked for.
   */
  pane?(session: string, pane: PaneId, what: { reload: boolean; capture: boolean; wait: number }): Promise<PaneAnswer>;
  /** A folder of Kumiko's own, on the same disk as the Claude homes, for files on their way into one (see `writeIn`). */
  scratch: string;
  /** Whether something answers at a preview's URL. */
  reachable?(url: string): Promise<boolean>;
}

const MAX_ARTIFACTS = 20;
const MAX_TITLE = 200;
/** How long after a file changes on disk it is read again: editors write in bursts. */
const DEBOUNCE_MS = 150;

/** The folder of a session's artifacts, under the Kumiko folder; the same in the VM (under `~/.kumiko`) and on the host. */
const artifactsDir = (id: string) => join("artifacts", id);

/** The Claude home and the Kumiko folder in the VM, relative to its home. */
const CLAUDE_DIR = CLAUDE_HOME_IN_VM.slice(2);
const KUMIKO_DIR = KUMIKO_HOME_IN_VM.slice(2);

const within = (path: string, root: string) => path === root || path.startsWith(root.endsWith("/") ? root : root + "/");
const hostWithin = (path: string, root: string) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);

class ToolError extends Error {}

/** Whether a session's artifacts' folder is really where it should be in `kumikoHome`, not a link anywhere else. */
function inPlace(kumikoHome: string, id: string): boolean {
  try {
    return realpathSync(join(kumikoHome, artifactsDir(id))) === join(realpathSync(kumikoHome), artifactsDir(id));
  } catch {
    return false;
  }
}

/**
 * Where `path` really is, if its folder is in `realDir` (resolved already): its folder resolved, and its name. The
 * file itself may be a link, and Claude may swap a folder on the way afterwards: `removeIn` and `writeIn` check the
 * folder again as they use it, and don't follow the file.
 */
async function realWithin(path: string, realDir: string): Promise<{ dir: string; name: string } | undefined> {
  try {
    const parent = await realpath(dirname(path));
    return hostWithin(parent, realDir) ? { dir: parent, name: basename(path) } : undefined;
  } catch {
    return undefined;
  }
}

/** Stands for a session's artifacts' folder in `given`. */
const FOLDER = "<folder>";

/** The longest name Claude can give a session: the tab has room for about that much beside the project's name. */
const MAX_SESSION_TITLE = 32;

/** The longest description Claude can give a session: two lines in the list of saved sessions. */
const MAX_SESSION_DESCRIPTION = 160;

/** The longest opening prompt Claude can propose for a new session. */
const MAX_PROPOSED_PROMPT = 20_000;

/** The largest artifact's file that is copied to another session. */
const MAX_SHARED_BYTES = 10 * 1024 * 1024;

/** How many artifacts one call can share, or a new session start with. */
const MAX_SHARED = 10;

/** How many saved sessions session_list names, most recent first; open ones are all named. */
const MAX_LISTED_SAVED = 30;

/** A copy of an artifact's file in another session's folder, as that session's Claude names it. */
export interface Copied {
  path: string;
  type: ArtifactType;
  title: string;
}

/** What Claude's system prompt gets about Kumiko, artifacts and the session's name, naming the session's folder. */
export const systemPrompt = (folder: string) =>
  [
    "You are running in Kumiko, which shows this conversation in a window that can have panes beside the chat.",
    "For an artifact the user will want to look at while it changes, such as a plan, a spec, a report, a diagram or a chart, write it as a file (Markdown, SVG, a Mermaid diagram, or an image you generate) and show it beside the chat with the mcp__kumiko__artifact_open tool; then keep changing the file, and the pane follows it. Unlike artifacts elsewhere, you don't pass the content to the tool: the artifact is the file.",
    "Images in a Markdown artifact load only from https addresses: local files and relative paths aren't shown, for security, as the window would load them from the user's computer. To show an image of your own, such as a screenshot, open its file as an artifact of its own, or put it in an HTML artifact as a data: URI.",
    `Write artifacts in ${folder}/, the session's folder for them; only files there can be shown.`,
    `Once the user's message makes clear what this session is about, name it with the mcp__kumiko__session_rename tool: a few words, up to ${MAX_SESSION_TITLE} characters, saying what the work is; the session's tab shows it. Give it a description too, a sentence on what the session is for, which the list of sessions to resume shows. Name it again only if the subject really changes.`,
    "The chat folds a turn's tool calls and short remarks away once it ends, leaving its last message as the reply: when you answer and then still have tool calls to make, such as tidying up, end the turn with the answer, or with a message that says what it is and where it is.",
  ].join(" ");

/** An artifact's file as read: what is shown of it and its hash, and its text, for a title. */
interface Read {
  data: Buffer;
  hash: string;
  text: string;
  truncated: boolean;
  missing: boolean;
  /** Its size and time, to tell whether it changed since. */
  stamp: string;
}

/** The longest Claude can ask the window to wait before a picture. */
const MAX_WAIT_MS = 10_000;

/** Artifacts that are web pages, which load and can be loaded again, as opposed to files the pane follows. */
const isPage = (a: ArtifactState) => a.type === "html" || a.type === "preview" || a.type === "web";

/**
 * The widgets of sessions' windows, beyond the window itself: the tools Claude changes them with, and the artifacts'
 * files, read on the host and read again when they change.
 */
export class Widgets implements SessionWidgets {
  sessions!: Sessions;
  private homes = new Map<string, string>();
  /** The size and time of each artifact's file when last read, by session and widget, so an unchanged one isn't read. */
  private seen = new Map<string, string>();
  private refreshing = new Map<string, Promise<void>>();
  private again = new Set<string>();
  private watchers = new Map<string, Map<string, FSWatcher>>();
  private timers = new Map<string, NodeJS.Timeout>();
  /** The server has gone: nothing is read or watched any more. */
  private stopped = false;

  constructor(private readonly opts: WidgetsOptions) {}

  /** Learns the VM's home, so the system prompt can name the artifacts' folder as Claude's tools want it: absolute. */
  async prepare(sandbox: string): Promise<void> {
    if (this.homes.has(sandbox)) return;
    const home = (await this.opts.vmHome(sandbox).catch(() => "")).trim();
    if (home.startsWith("/")) this.homes.set(sandbox, home.replace(/\/+$/, ""));
  }

  private async vmHome(sandbox: string): Promise<string> {
    await this.prepare(sandbox);
    const home = this.homes.get(sandbox);
    if (!home) throw new ToolError("Couldn't ask the sandbox where its home is. Try again.");
    return home;
  }

  /** The session's artifacts' folder in the VM, as Claude should name it. */
  private vmDocs(info: SessionInfo): string {
    const home = this.homes.get(info.sandbox);
    return `${home ?? "~"}/${KUMIKO_DIR}/${artifactsDir(info.id)}`;
  }

  private hostDocs(info: Pick<SessionInfo, "id" | "sandbox">): string | undefined {
    const home = this.opts.home(info.sandbox);
    return home && join(home.kumikoHome, artifactsDir(info.id));
  }

  /**
   * The session's artifacts' folder resolved, or undefined if there isn't one. Claude can change the Kumiko folder, so it can
   * swap the folder, or one above it, for a link to anywhere on the host; then it isn't the session's folder any more,
   * and nothing is read, written or deleted through it.
   */
  private async realDocs(info: SessionInfo): Promise<string | undefined> {
    const home = this.opts.home(info.sandbox);
    if (!home) return undefined;
    const dir = join(home.kumikoHome, artifactsDir(info.id));
    if (!existsSync(dir)) return undefined;
    if (!inPlace(home.kumikoHome, info.id)) {
      throw new ToolError(`This session's folder, ${this.vmDocs(info)}, links somewhere else, so Kumiko won't show, write or delete anything in it. Make it a folder again.`);
    }
    return realpath(dir);
  }

  tools(info: SessionInfo): { tools: ToolHost; appendSystemPrompt: string } {
    const dir = this.hostDocs(info);
    if (dir) mkdirSync(dir, { recursive: true });
    const folder = this.vmDocs(info);
    return {
      tools: { list: () => toolsFor(folder), call: (name, args, ctx) => this.call(info.id, name, args, ctx.toolUseId) },
      appendSystemPrompt: systemPrompt(folder),
    };
  }

  /**
   * What Claude is given of these tools, as one string to hash: their specs and its instructions, with a stand-in for
   * the session's folder, so it is the same for every session and whether or not the sandbox's home is known yet.
   */
  given(): string {
    return JSON.stringify([toolsFor(FOLDER), systemPrompt(FOLDER)]);
  }

  private async call(id: string, name: string, args: Record<string, unknown>, toolUseId?: string): Promise<ToolResult> {
    try {
      const info = this.sessions.get(id);
      if (!info) throw new ToolError("This session is gone.");
      // A call answered once already, by a server that went away before it could save: done, so it isn't done twice.
      if (toolUseId && this.sessions.events(id).some((e) => e.kind === "window" && e.payload.toolUseId === toolUseId)) {
        return { text: `Done already. ${describe(this.sessions.window(id)!)}` };
      }
      switch (name) {
        case "window_list":
          return { text: describe(this.sessions.window(id)!) };
        case "window_close": {
          const pane = str(args.pane, "pane");
          const w = this.sessions.changeWindow(id, { type: "close", pane }, toolUseId);
          return { text: `Closed pane ${pane}. ${describe(w)}` };
        }
        case "artifact_capture":
        case "artifact_reload": {
          const capture = name === "artifact_capture";
          const reload = !capture || args.reload === true;
          const [widget, artifact] = await this.find(info, args.artifact);
          const w = this.sessions.window(id)!;
          const pane = paneOf(w, widget);
          if (!pane) throw new ToolError(`Artifact ${widget} "${artifact.title}" isn't shown, so it can't be ${capture ? "captured" : "reloaded"}: show it with artifact_open first.`);
          if (artifact.type === "web" && !artifact.approved) throw new ToolError(`The user hasn't allowed ${urlOrigin(artifact.path)} yet, so it hasn't loaded. Wait for them to allow it in the pane.`);
          if (!capture && !isPage(artifact)) throw new ToolError(`Artifact ${widget} "${artifact.title}" isn't a page; it follows its file without reloading.`);
          const reloading = reload && isPage(artifact);
          if (args.wait !== undefined && !(typeof args.wait === "number" && args.wait >= 0 && args.wait <= MAX_WAIT_MS)) {
            throw new ToolError(`wait is a number of milliseconds, from 0 to ${MAX_WAIT_MS}.`);
          }
          // A moment after a reload by default, for the page to paint what it loaded.
          const wait = capture ? Math.round((args.wait as number | undefined) ?? (reloading ? 300 : 0)) : 0;
          const { image, note } = await this.askPane(id, pane, { reload: reloading, capture, wait });
          const what = `Artifact ${widget} "${artifact.title}" in pane ${pane}`;
          const failed = note ? ` ${note}` : "";
          if (!capture) return { text: note ? `${what} was loaded again, but${failed.replace(/^ The page/, " the page")}` : `${what} has loaded again.` };
          return { text: `${what}${reload && isPage(artifact) ? ", loaded again," : ","} as the user sees it now.${failed}`, images: image ? [image] : [] };
        }
        case "artifact_remove": {
          const [widget, artifact] = await this.find(info, args.artifact, { shown: false });
          const { window: after, deleted } = await this.remove(id, widget, "another", toolUseId);
          const file = isPage(artifact) && artifact.type !== "html" ? "" : deleted ? ", and deleted its file" : "; its file was gone already";
          return { text: `Removed artifact ${widget} "${artifact.title}" from the window${file}. ${describe(after)}` };
        }
        case "artifact_open":
          return { text: await this.open(info, args, toolUseId) };
        case "session_rename": {
          const title = str(args.title, "title").trim().replace(/\s+/g, " ");
          const description = args.description === undefined ? undefined : str(args.description, "description").trim().replace(/\s+/g, " ") || undefined;
          if (description && description.length > MAX_SESSION_DESCRIPTION) {
            throw new ToolError(`The description is ${description.length} characters; the list has room for ${MAX_SESSION_DESCRIPTION}. Make it shorter.`);
          }
          const described = description !== undefined && description !== info.description;
          if (info.titleBy === "user") {
            const stands = `The user named this session "${info.title}" with /rename, and their name stands`;
            if (!described) throw new ToolError(`${stands}.`);
            this.sessions.rename(id, undefined, "agent", description);
            return { text: `${stands}; its description is saved. The list of sessions to resume shows it.` };
          }
          if (!title) throw new ToolError("Give the session a name: a few words saying what the work is.");
          if (title.length > MAX_SESSION_TITLE) {
            throw new ToolError(`"${title}" is ${title.length} characters; the tab has room for ${MAX_SESSION_TITLE}. Pick a shorter name.`);
          }
          const named = title !== info.title;
          if (!named && !described) return { text: `The session is named "${title}" already${description ? ", with that description" : ""}.` };
          this.sessions.rename(id, named ? title : undefined, "agent", described ? description : undefined);
          const said = [named && `Named the session "${title}". Its tab shows it.`, described && `${named ? "Its" : "The session's"} description is saved; the list of sessions to resume shows it.`];
          return { text: said.filter(Boolean).join(" ") };
        }
        case "session_start": {
          // Answered once already: the user has it to accept, so it isn't asked twice.
          if (toolUseId && this.sessions.events(id).some((e) => e.kind === "proposal" && e.payload.toolUseId === toolUseId)) {
            return { text: "Done already: the user has it to accept." };
          }
          const prompt = str(args.prompt, "prompt").trim();
          if (!prompt) throw new ToolError("Give the new session a prompt: what it is to do.");
          if (prompt.length > MAX_PROPOSED_PROMPT) throw new ToolError(`The prompt is ${prompt.length} characters; at most ${MAX_PROPOSED_PROMPT}. Put the details in a file it can read.`);
          const title = args.title === undefined ? undefined : str(args.title, "title").trim().replace(/\s+/g, " ") || undefined;
          if (title && title.length > MAX_SESSION_TITLE) {
            throw new ToolError(`"${title}" is ${title.length} characters; the tab has room for ${MAX_SESSION_TITLE}. Pick a shorter name.`);
          }
          const artifacts = await this.shareable(info, args.artifacts);
          this.sessions.propose(id, { prompt, ...(title ? { title } : {}), ...(artifacts.length ? { artifacts: artifacts.map(([, a]) => a.path) } : {}) }, toolUseId);
          const copies = artifacts.length ? ` It gets copies of ${artifacts.map(([w, a]) => `${w} "${a.title}"`).join(", ")} as they are then, in its own folder and window; the prompt it gets names them.` : "";
          return {
            text: `Asked the user to start the session: the chat shows them the prompt, and the session starts in a tab of its own once they accept it.${copies} You won't hear whether they do, so don't wait for it.`,
          };
        }
        case "session_list":
          return { text: await this.list(info) };
        case "artifact_share": {
          const to = this.sessions.get(str(args.session, "session"));
          if (!to || to.sandbox !== info.sandbox) throw new ToolError(`There is no session ${args.session} in this project. session_list names them.`);
          if (to.id === id) throw new ToolError("That is this session.");
          if (!LIVE_SESSION_STATUSES.includes(to.status)) throw new ToolError(`Session ${to.id} isn't open, so it can't be given anything; the user can resume it first.`);
          const artifacts = await this.shareable(info, args.artifacts);
          if (!artifacts.length) throw new ToolError("Which artifacts? Name them by id or path.");
          const { copied, skipped } = await this.copyArtifacts(info, to, artifacts.map(([, a]) => a.path));
          if (copied.length) {
            await this.addCopies(to, copied, false);
            this.sessions.shared(to.id, info, nameOf(info), copied.map(({ path, title }) => ({ path, title })));
          }
          const said = copied.length
            ? `Copied ${copied.map((c) => `"${c.title}" to ${c.path}`).join(", ")} in session ${to.id} ("${nameOf(to)}"): its window has ${copied.length > 1 ? "them" : "it"}, not shown, for the user to switch a pane to. These are copies: changing yours doesn't change them, so share again to send a newer one. Its Claude is told with the user's next message there, not before.`
            : "Nothing was copied.";
          return { text: [said, ...skipped].join(" "), ...(copied.length ? {} : { isError: true }) };
        }
        default:
          throw new ToolError(`There is no tool ${name}.`);
      }
    } catch (err) {
      if (err instanceof ToolError || err instanceof WindowError) return { text: err.message, isError: true };
      throw err;
    }
  }

  /** The artifacts `refs` names, for copying to another session: files in this session's folder, all or nothing. */
  private async shareable(info: SessionInfo, refs: unknown): Promise<[WidgetId, ArtifactState][]> {
    if (refs === undefined) return [];
    if (!Array.isArray(refs)) throw new ToolError("artifacts must be a list of artifacts' ids or paths.");
    if (refs.length > MAX_SHARED) throw new ToolError(`At most ${MAX_SHARED} artifacts at a time.`);
    const found: [WidgetId, ArtifactState][] = [];
    for (const ref of refs) {
      const [widget, a] = await this.find(info, ref, { shown: false });
      if (isPage(a) && a.type !== "html") throw new ToolError(`Artifact ${widget} "${a.title}" is a page at ${a.path}, not a file: give the URL in the prompt instead.`);
      if (!within(a.path, this.vmDocs(info))) throw new ToolError(`Artifact ${widget} "${a.title}" isn't in this session's folder, so it can't be shared.`);
      if (!found.some(([w]) => w === widget)) found.push([widget, a]);
    }
    return found;
  }

  /** The project's sessions, for Claude: open ones first, then saved ones, most recent first. */
  private async list(info: SessionInfo): Promise<string> {
    const open = this.sessions.list().filter((s) => s.sandbox === info.sandbox);
    const saved = (await this.sessions.resumable()).filter((s) => s.sandbox === info.sandbox);
    const line = (s: SessionInfo, state: string) =>
      `- ${s.id}${s.id === info.id ? " (this session)" : ""}: "${nameOf(s)}", ${state}, started ${s.startedAt.slice(0, 16).replace("T", " ")} UTC.${s.description ? ` ${s.description}` : ""}`;
    const stateOf = (s: SessionInfo) =>
      !LIVE_SESSION_STATUSES.includes(s.status) ? "ended, its tab still open" : s.asking === "plan" ? "open, waiting for the user to approve its plan" : s.asking ? "open, waiting for the user to answer its questions" : s.status === "idle" ? (isWaiting(s) ? "open, waiting for the user" : "open, idle") : "open, working";
    const lines = [
      ...open.map((s) => line(s, stateOf(s))),
      ...saved.slice(0, MAX_LISTED_SAVED).map((s) => line(s, "closed; the user can resume it")),
    ];
    const more = saved.length > MAX_LISTED_SAVED ? `\n(and ${saved.length - MAX_LISTED_SAVED} older saved sessions)` : "";
    return `Sessions in this project (${info.sandbox}), as the user's tabs name them:\n${lines.join("\n")}${more}`;
  }

  /**
   * Copies the artifacts' files at `paths`, in session `from`'s folder, into session `to`'s folder, by name, as they are now.
   * `to` may not have started yet. A file of that name in `to`'s folder is only replaced if its window has it as an
   * artifact (an earlier copy, say): anything else there is its Claude's own. Returns the copies, and what wasn't copied.
   */
  async copyArtifacts(from: SessionInfo, to: Pick<SessionInfo, "id" | "sandbox">, paths: string[]): Promise<{ copied: Copied[]; skipped: string[] }> {
    const copied: Copied[] = [];
    const skipped: string[] = [];
    const src = await this.realDocs(from).catch(() => undefined);
    const dir = this.hostDocs(to);
    const home = this.homes.get(to.sandbox);
    if (!src || !dir || !home) return { copied, skipped: ["This session's folder can't be read, so nothing was copied."] };
    mkdirSync(dir, { recursive: true });
    // Not into a folder Claude has swapped for a link, which would write wherever it points.
    const dst = inPlace(this.opts.home(to.sandbox)!.kumikoHome, to.id) ? await realpath(dir).catch(() => undefined) : undefined;
    if (!dst) return { copied, skipped: [`Session ${to.id}'s folder links somewhere else, so nothing was copied to it.`] };
    const theirs = new Set(artifactsOf(this.sessions.window(to.id) ?? chatWindow()).map(([, a]) => a.path));
    // Named as in this session's window, if it still has them.
    const mine = this.sessions.window(from.id);
    for (const a of paths.map((path) => ({ path, title: (mine && artifactsOf(mine).find(([, d]) => d.path === path)?.[1].title) || posix.basename(path) }))) {
      const type = artifactTypeOf(a.path);
      const name = posix.basename(a.path);
      const path = `${home}/${KUMIKO_DIR}/${artifactsDir(to.id)}/${name}`;
      const at = this.hostPath(from, a.path);
      const real = at && (await realWithin(at.path, src));
      const data = real && type ? await readWhole(real.dir, real.name, this.opts.scratch) : undefined;
      if (!type || !data) {
        skipped.push(`"${a.title}" (${a.path}) ${data === null ? `is larger than ${MAX_SHARED_BYTES / 1024 / 1024} MB` : "has no file to copy"}.`);
        continue;
      }
      if (existsSync(join(dst, name)) && !theirs.has(path)) {
        skipped.push(`Session ${to.id} has a file ${name} of its own already, which wasn't replaced: rename yours and share it again.`);
        continue;
      }
      if (await writeIn(dst, name, data, this.opts.scratch)) copied.push({ path, type, title: a.title });
      else skipped.push(`"${a.title}" couldn't be written to session ${to.id}'s folder.`);
    }
    return { copied, skipped };
  }

  /** Puts copies made by `copyArtifacts` in session `to`'s window: added, or updated if there already, and `show`n. */
  async addCopies(to: SessionInfo, copies: Copied[], show: boolean): Promise<void> {
    await this.prepare(to.sandbox);
    for (const c of copies) {
      const read = await this.read(to, c.path, c.type).catch(() => undefined);
      if (!read || read.missing) continue;
      const content = await this.keepContent(read);
      let w = this.sessions.window(to.id)!;
      const existing = artifactsOf(w).find(([, a]) => a.path === c.path);
      const state = { content, truncated: read.truncated, missing: false };
      if (existing) w = this.sessions.changeWindow(to.id, { type: "update", widget: existing[0], op: { ...state, title: c.title } });
      else if (artifactsOf(w).length < MAX_ARTIFACTS) w = this.sessions.changeWindow(to.id, { type: "add", widget: nextId(w, "w"), kind: "artifact", state: { path: c.path, type: c.type, title: c.title, ...state } });
      else continue;
      const widget = artifactsOf(w).find(([, a]) => a.path === c.path)![0];
      if (show && !paneOf(w, widget)) {
        const target = docPaneTarget(w) ?? { split: { split: "right" as const } };
        this.sessions.changeWindow(to.id, "pane" in target ? { type: "show", pane: target.pane, widget } : { type: "split", place: target.split, pane: nextId(w, "p"), widget });
      }
    }
    this.watch(to);
  }

  private async open(info: SessionInfo, args: Record<string, unknown>, toolUseId?: string): Promise<string> {
    const { id } = info;
    if ((args.path === undefined) === (args.url === undefined)) throw new ToolError("Give either path (a file) or url (a page served in the sandbox, for a preview).");
    if (args.url !== undefined) return this.openPage(info, str(args.url, "url"), args, toolUseId);
    const path = await this.vmPath(info, str(args.path, "path")).catch(() => posix.normalize(str(args.path, "path")));
    // Artifacts are what Claude makes for the session, kept in its folder; the repository's files aren't artifacts.
    if (!within(path, this.vmDocs(info))) {
      throw new ToolError(`Artifacts live in this session's folder, ${this.vmDocs(info)}/: write the file there (or copy it there), then open it. ${path} isn't in it.`);
    }
    const type = artifactTypeOf(path);
    if (!type) throw new ToolError(`Kumiko can't show ${posix.basename(path)} as an artifact. It shows ${ARTIFACT_FILES.join(", ")} files, and pages served in the sandbox (url).`);
    const asked = targetOf(args.place);
    const title = args.title === undefined ? undefined : str(args.title, "title").trim();
    if (title !== undefined && (!title || title.length > MAX_TITLE)) throw new ToolError(`A title has 1 to ${MAX_TITLE} characters.`);
    const read = await this.read(info, path, type);
    if (read.missing) throw new ToolError(`There is no file ${path}. Write it first, then open it.`);
    const note = !read.truncated
      ? ""
      : type === "image"
        ? ` It is larger than ${MAX_IMAGE_BYTES / 1024 / 1024} MB, so it isn't shown: make it smaller.`
        : ` It is longer than ${MAX_ARTIFACT_BYTES / 1024} KB, so only its start is shown: split it into several artifacts.`;

    // Kept before the window is looked at: from there to the change, nothing waits, so no other change comes between.
    const content = await this.keepContent(read);
    let w = this.sessions.window(id)!;
    const docs = artifactsOf(w);
    const existing = docs.find(([, d]) => d.path === path);
    const ops: WindowOp[] = [];
    let widget: string;
    if (existing) {
      widget = existing[0];
      const changed: Partial<ArtifactState> = {};
      if (title && title !== existing[1].title) changed.title = title;
      if (read.hash !== existing[1].content || read.truncated !== Boolean(existing[1].truncated) || existing[1].missing) Object.assign(changed, { content, truncated: read.truncated, missing: false });
      if (Object.keys(changed).length) ops.push({ type: "update", widget, op: changed });
      // Shown already, and not asked to go anywhere else: nothing moves.
      const pane = paneOf(w, widget);
      if (pane && (!asked || ("pane" in asked && asked.pane === pane))) {
        for (const op of ops) w = this.sessions.changeWindow(id, op, toolUseId);
        return `${path} is shown already, as artifact ${widget} in pane ${pane}.${note} ${describe(w)}`;
      }
    } else {
      if (docs.length >= MAX_ARTIFACTS) throw new ToolError(`A window has at most ${MAX_ARTIFACTS} artifacts.`);
      widget = nextId(w, "w");
      const state: ArtifactState = { path, type, title: title || titleOf(path, type, read.text), content, ...(read.truncated ? { truncated: true } : {}) };
      ops.push({ type: "add", widget, kind: "artifact", state });
    }
    // By default in the artifact pane used last, so artifacts don't each take a pane; a new one only when there is none.
    const target = asked ?? docPaneTarget(w) ?? { split: { split: "right" } };
    let pane: string;
    let where: string;
    if ("pane" in target) {
      pane = target.pane;
      const was = w.widgets[w.panes[pane]];
      ops.push({ type: "show", pane, widget });
      const before = was?.kind === "artifact" ? ` in place of "${(was.state as ArtifactState).title}", which stays in the window` : "";
      where = `in pane ${pane}${before}`;
    } else {
      pane = nextId(w, "p");
      ops.push({ type: "split", place: target.split, pane, widget });
      const { split: dir, of } = target.split;
      where = `in a new pane ${pane}, ${{ right: "right of", left: "left of", above: "above", below: "below" }[dir]} ${of && of !== CHAT ? `pane ${of}` : "the chat"}`;
    }
    // All or nothing: checked on a copy first, so a split that doesn't fit doesn't leave a widget added.
    let check = w;
    for (const op of ops) check = applyWindowOp(check, op);
    for (const op of ops) w = this.sessions.changeWindow(id, op, toolUseId);
    this.watch(info);
    return `Showing ${path} as artifact ${widget} ${where}. Keep editing the file with your own tools; the pane follows it.${note} ${describe(w)}`;
  }

  /**
   * Takes an artifact out of the session's window (see `removeArtifact`) and deletes its file, if it is one in the
   * session's folder: an artifact is the session's own. Rewinding to before puts it back, file and all.
   */
  async remove(id: string, widget: WidgetId, instead: "another" | "close", toolUseId?: string): Promise<{ window: WindowState; deleted: boolean }> {
    const info = this.sessions.get(id);
    let w = this.sessions.window(id);
    if (!info || !w) throw new ToolError("This session is gone.");
    const artifact = w.widgets[widget]?.kind === "artifact" ? (w.widgets[widget].state as ArtifactState) : undefined;
    for (const op of removeArtifact(w, widget, instead)) w = this.sessions.changeWindow(id, op, toolUseId);
    this.watch(info);
    let deleted = false;
    const at = artifact && this.hostPath(info, artifact.path);
    const dir = this.hostDocs(info);
    const realDir = dir && (await this.realDocs(info).catch(() => undefined));
    const real = artifact && at && dir && realDir && hostWithin(at.path, dir) && !(artifact.type === "preview" || artifact.type === "web") ? await realWithin(at.path, realDir) : undefined;
    // A link is deleted itself, not what it points to.
    if (real) deleted = await removeIn(real.dir, real.name);
    return { window: w, deleted };
  }

  /**
   * The artifact `ref` names: its id, its file's path (as given or as resolved), or a preview's URL. Without one, the
   * artifact in the pane used last, or any shown, unless `shown` is false.
   */
  private async find(info: SessionInfo, ref: unknown, { shown = true } = {}): Promise<[WidgetId, ArtifactState]> {
    const w = this.sessions.window(info.id)!;
    const all = artifactsOf(w);
    if (ref === undefined) {
      if (!shown) throw new ToolError("Which artifact?");
      const visible = all.filter(([widget]) => paneOf(w, widget));
      const pick = visible.find(([widget]) => paneOf(w, widget) === w.active) ?? visible[0];
      if (!pick) throw new ToolError(`No artifact is shown. ${describe(w)}`);
      return pick;
    }
    const name = str(ref, "artifact");
    const path = isPreviewUrl(name) ? undefined : await this.vmPath(info, name).catch(() => undefined);
    const pick = all.find(([widget, a]) => widget === name || a.path === name || (path !== undefined && a.path === path));
    if (!pick) throw new ToolError(`There is no artifact ${name} in the window. ${describe(w)}`);
    return pick;
  }

  /** Asks the user's window to reload a pane's page or take a picture of it; a tool error if it can't. */
  private async askPane(session: string, pane: PaneId, what: { reload: boolean; capture: boolean; wait: number }) {
    if (!this.opts.pane) throw new ToolError("This needs the user's window, which isn't available here.");
    return this.opts.pane(session, pane, what).catch((err: unknown) => {
      throw new ToolError(err instanceof Error ? err.message : String(err));
    });
  }

  /**
   * Opens a page by its URL: a preview of one the sandbox serves (such as a dev server's: Lima forwards its port to the
   * same one on this machine), checked first to answer; or an external site, which loads only once the user allows
   * it in the pane, unless they have allowed a page of the same site in this session already.
   */
  private async openPage(info: SessionInfo, url: string, args: Record<string, unknown>, toolUseId?: string): Promise<string> {
    const type = isPreviewUrl(url) ? "preview" : isExternalUrl(url) ? "web" : undefined;
    if (!type) {
      throw new ToolError(`Kumiko can't show ${url}: a url is a page served in the sandbox (http://localhost:5173/) or a public http(s) site, not a private network's.`);
    }
    if (type === "preview" && this.opts.reachable && !(await this.opts.reachable(url))) {
      throw new ToolError(
        `Nothing answers at ${url} on the user's machine. Start the server in the sandbox listening on 127.0.0.1 or 0.0.0.0 (Vite: --host 127.0.0.1), as Lima forwards only those, and check the port isn't taken on the user's machine.`,
      );
    }
    const title = args.title === undefined ? undefined : str(args.title, "title").trim();
    const asked = targetOf(args.place);
    let w = this.sessions.window(info.id)!;
    const origin = urlOrigin(url);
    const allowed = type === "preview" || artifactsOf(w).some(([, a]) => a.type === "web" && a.approved && urlOrigin(a.path) === origin);
    const existing = artifactsOf(w).find(([, a]) => a.path === url);
    const ops: WindowOp[] = [];
    let widget: string;
    if (existing) {
      widget = existing[0];
      if (title && title !== existing[1].title) ops.push({ type: "update", widget, op: { title } });
    } else {
      if (artifactsOf(w).length >= MAX_ARTIFACTS) throw new ToolError(`A window has at most ${MAX_ARTIFACTS} artifacts.`);
      widget = nextId(w, "w");
      const where = url.replace(/^https?:\/\//, "");
      const state: ArtifactState = { path: url, type, title: title || (type === "preview" ? `Preview of ${where}` : urlHost(url)!), ...(type === "web" ? { approved: allowed } : {}) };
      ops.push({ type: "add", widget, kind: "artifact", state });
    }
    const pending = type === "web" && !(existing ? existing[1].approved : allowed);
    const shownIn = paneOf(w, widget);
    if (shownIn && (!asked || ("pane" in asked && asked.pane === shownIn))) {
      // Shown already, where it was asked for: opening it again loads it again, as a stuck page or a server without
      // live reload needs.
      for (const op of ops) w = this.sessions.changeWindow(info.id, op, toolUseId);
      if (pending) return `${url} is shown already, as artifact ${widget} in pane ${shownIn}, waiting for the user to allow ${origin}. ${describe(w)}`;
      const reloaded = await this.askPane(info.id, shownIn, { reload: true, capture: false, wait: 0 }).then(() => true, () => false);
      return `${url} is shown already, as artifact ${widget} in pane ${shownIn}; ${reloaded ? "it has loaded again" : "the user's window didn't answer to load it again"}. ${describe(w)}`;
    }
    const target = asked ?? docPaneTarget(w) ?? { split: { split: "right" } };
    ops.push("pane" in target ? { type: "show", pane: target.pane, widget } : { type: "split", place: target.split, pane: nextId(w, "p"), widget });
    let check = w;
    for (const op of ops) check = applyWindowOp(check, op);
    for (const op of ops) w = this.sessions.changeWindow(info.id, op, toolUseId);
    const pane = paneOf(w, widget);
    if (type === "preview") return `Previewing ${url} as artifact ${widget} in pane ${pane}. It shows the page live; the dev server's own reload keeps it current. Use artifact_capture to see it. ${describe(w)}`;
    if (pending) {
      return `Asked the user to allow ${origin} in pane ${pane} (artifact ${widget}); the site loads once they do, and you can't capture it before. If they deny it, it goes from the window. ${describe(w)}`;
    }
    return `Showing ${url} as artifact ${widget} in pane ${pane}; the user allowed ${origin} in this session already. Use artifact_capture to see it. ${describe(w)}`;
  }

  /** The absolute path in the VM that `path` names, if it is one whose file the host can read. */
  private async vmPath(info: SessionInfo, path: string): Promise<string> {
    const home = await this.vmHome(info.sandbox);
    let p = path.startsWith("~/") ? home + path.slice(1) : path;
    if (!p.startsWith("/")) p = posix.resolve(info.workdir, p);
    p = posix.normalize(p);
    if (this.hostPath(info, p)) return p;
    const roots = this.opts.home(info.sandbox)?.roots ?? [];
    throw new ToolError(`Kumiko can't show ${p}: it can only show files in ${[this.vmDocs(info), ...roots].join(", ")} (or anywhere under ${KUMIKO_HOME_IN_VM} or ${CLAUDE_HOME_IN_VM}).`);
  }

  /** Where a file in the VM is on the host, if it is in a folder mounted from there. */
  private hostPath(info: SessionInfo, vmPath: string): { path: string; root: string } | undefined {
    const home = this.opts.home(info.sandbox);
    const vmHome = this.homes.get(info.sandbox);
    if (!home) return undefined;
    if (vmHome) {
      for (const [dir, root] of [[KUMIKO_DIR, home.kumikoHome], [CLAUDE_DIR, home.claudeHome]]) {
        if (within(vmPath, `${vmHome}/${dir}`)) return { path: join(root, relative(`${vmHome}/${dir}`, vmPath)), root };
      }
    }
    const root = home.roots.find((r) => within(vmPath, r));
    return root ? { path: vmPath, root } : undefined;
  }

  /**
   * An artifact's file as it is now: what is shown of it (its first MAX_ARTIFACT_BYTES, or an image whole), with its
   * hash, read on the host. A link out of the session's folder isn't followed. `text` is the shown part as text, for titles.
   */
  private async read(info: SessionInfo, vmPath: string, type: ArtifactType): Promise<Read> {
    const at = this.hostPath(info, vmPath);
    const gone: Read = { data: Buffer.alloc(0), hash: "", text: "", truncated: false, missing: true, stamp: "missing" };
    if (!at) return gone;
    try {
      const docs = await this.realDocs(info);
      if (!docs) return gone;
      const real = await realpath(at.path);
      if (!hostWithin(real, docs)) throw new ToolError(`${vmPath} links to a file outside this session's folder, which Kumiko won't show.`);
      // The file that is there now, in that folder: Claude may have swapped a link in since the check.
      const opened = await openIn(dirname(real), basename(real), this.opts.scratch);
      if (!opened) return gone;
      const { fh } = opened;
      try {
        const st = await fh.stat();
        if (!st.isFile()) throw new ToolError(`${vmPath} isn't a file.`);
        const stamp = `${st.size}:${st.mtimeMs}`;
        // An image is all or nothing: a cut one can't be shown.
        if (type === "image" && st.size > MAX_IMAGE_BYTES) return { ...gone, missing: false, truncated: true, stamp };
        if (type === "image") {
          const data = await fh.readFile();
          return { data, hash: contentHash(data), text: "", truncated: false, missing: false, stamp };
        }
        const buf = Buffer.alloc(Math.min(st.size, MAX_ARTIFACT_BYTES));
        const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
        // Cut at a character, not in the middle of one.
        const text = new TextDecoder().decode(buf.subarray(0, bytesRead)).replace(/\uFFFD$/, "");
        const data = Buffer.from(text);
        return { data, hash: contentHash(data), text, truncated: st.size > MAX_ARTIFACT_BYTES, missing: false, stamp };
      } finally {
        await opened.done();
      }
    } catch (err) {
      if (err instanceof ToolError) throw err;
      return gone;
    }
  }

  /** Keeps what is shown of a file, for the window to fetch; its hash, or undefined for nothing to show. */
  private async keepContent(read: Read): Promise<string | undefined> {
    if (read.missing || (read.truncated && !read.data.length)) return undefined;
    return this.opts.content.put(read.data);
  }

  /** One of Claude's messages: once a tool has run, or the turn has ended, the artifacts may have changed. */
  message(info: SessionInfo, m: AgentMessage): void {
    const content = (m.message as { content?: unknown } | undefined)?.content;
    const toolResult = m.type === "user" && Array.isArray(content) && content.some((b: { type?: unknown }) => b?.type === "tool_result");
    if (m.type === "result" || toolResult) void this.refresh(info.id);
  }

  /**
   * Reads the artifacts' files again, and records those that changed: shown or not, since a pane can switch to any of
   * them and marks those that changed meanwhile. One at a time per session.
   */
  refresh(id: string): Promise<void> {
    if (this.stopped) return Promise.resolve();
    const running = this.refreshing.get(id);
    if (running) {
      this.again.add(id);
      return running;
    }
    const done = (async () => {
      do {
        this.again.delete(id);
        await this.refreshOnce(id).catch(() => {});
      } while (this.again.has(id));
    })().finally(() => this.refreshing.delete(id));
    this.refreshing.set(id, done);
    return done;
  }

  private async refreshOnce(id: string) {
    const info = this.sessions.get(id);
    const w = this.sessions.window(id);
    if (!info || !w || (info.status !== "idle" && info.status !== "running" && info.status !== "starting")) return this.unwatch(id);
    await this.prepare(info.sandbox);
    for (const [widget, doc] of artifactsOf(w)) {
      // Not where it can be read from now (the VM's home isn't known): left as last read.
      if (!this.hostPath(info, doc.path)) continue;
      const read = await this.read(info, doc.path, doc.type).catch(() => undefined);
      if (!read) continue;
      const key = `${id}:${widget}`;
      if (this.seen.get(key) === read.stamp) continue;
      this.seen.set(key, read.stamp);
      // A file that is gone keeps showing what it was.
      if (read.missing) {
        if (doc.missing) continue;
      } else if (read.hash === (doc.content ?? "") && !doc.missing && read.truncated === Boolean(doc.truncated)) continue;
      try {
        const op = read.missing ? { missing: true } : { content: await this.keepContent(read), truncated: read.truncated, missing: false };
        this.sessions.changeWindow(id, { type: "update", widget, op });
      } catch {
        // The session ended meanwhile.
      }
    }
    this.watch(info);
  }

  /** Watches the folders of the artifacts, for the user editing one between turns. */
  private watch(info: SessionInfo) {
    const w = this.sessions.window(info.id);
    if (!w || this.stopped) return;
    const dirs = new Set(artifactsOf(w).flatMap(([, d]) => {
      const at = this.hostPath(info, d.path);
      return at ? [dirname(at.path)] : [];
    }));
    const mine = this.watchers.get(info.id) ?? new Map<string, FSWatcher>();
    for (const [dir, watcher] of mine) if (!dirs.has(dir)) (watcher.close(), mine.delete(dir));
    for (const dir of dirs) {
      if (mine.has(dir) || !existsSync(dir)) continue;
      try {
        const watcher = watch(dir, () => {
          clearTimeout(this.timers.get(info.id));
          this.timers.set(info.id, setTimeout(() => void this.refresh(info.id), DEBOUNCE_MS));
        });
        watcher.on("error", () => (watcher.close(), mine.delete(dir)));
        mine.set(dir, watcher);
      } catch {
        // Can't be watched: it is still read after every tool call.
      }
    }
    this.watchers.set(info.id, mine);
  }

  private unwatch(id: string) {
    for (const watcher of this.watchers.get(id)?.values() ?? []) watcher.close();
    this.watchers.delete(id);
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
  }

  /** What is kept of one of Claude's messages: a Write to an artifact keeps its size, not the text the window has. */
  keep(info: SessionInfo, m: AgentMessage): AgentMessage {
    if (m.type !== "assistant") return m;
    const message = m.message as { content?: unknown } | undefined;
    if (!Array.isArray(message?.content)) return m;
    const w = this.sessions.window(info.id);
    const shown = new Set(w ? artifactsOf(w).map(([, d]) => d.path) : []);
    if (!shown.size) return m;
    let changed = false;
    const content = message.content.map((b: { type?: unknown; name?: unknown; input?: { file_path?: unknown; content?: unknown } }) => {
      if (b?.type !== "tool_use" || b.name !== "Write" || typeof b.input?.content !== "string" || typeof b.input.file_path !== "string") return b;
      if (!shown.has(posix.normalize(b.input.file_path))) return b;
      changed = true;
      return { ...b, input: { ...b.input, content: `(${Buffer.byteLength(b.input.content)} bytes, shown in the artifact's pane)` } };
    });
    return changed ? ({ ...m, message: { ...message, content } } as AgentMessage) : m;
  }

  /** A fork gets a copy of the original's artifacts' folder, and its window names the copies. */
  forked(from: SessionInfo, to: SessionInfo, events: SessionEvent[]): SessionEvent[] {
    const src = this.hostDocs(from);
    const dst = this.hostDocs(to);
    // Not from a folder Claude has swapped for a link, which would copy what it points to where Claude can read it.
    if (src && dst && existsSync(src) && inPlace(this.opts.home(from.sandbox)!.kumikoHome, from.id)) cpSync(src, dst, { recursive: true });
    const home = this.homes.get(from.sandbox);
    if (!home) return events;
    const quoted = (path: string) => JSON.stringify(path).slice(1, -1);
    const a = quoted(`${home}/${KUMIKO_DIR}/${artifactsDir(from.id)}/`);
    const b = quoted(`${home}/${KUMIKO_DIR}/${artifactsDir(to.id)}/`);
    return events.map((e) => (e.kind === "window" ? (JSON.parse(JSON.stringify(e).split(a).join(b)) as SessionEvent) : e));
  }

  /** After a rewind, the artifacts in the session's own folder are put back as the window has them. */
  rewound(info: SessionInfo, w: WindowState): void {
    void this.putBack(info, w);
  }

  private async putBack(info: SessionInfo, w: WindowState): Promise<void> {
    const dir = this.hostDocs(info);
    const realDir = await this.realDocs(info).catch(() => undefined);
    const home = this.homes.get(info.sandbox);
    if (!dir || !realDir || !home) return;
    const vmDir = `${home}/${KUMIKO_DIR}/${artifactsDir(info.id)}`;
    for (const [widget, d] of artifactsOf(w)) {
      if (d.truncated || d.missing || d.type === "preview" || d.type === "web" || !within(d.path, vmDir)) continue;
      this.seen.delete(`${info.id}:${widget}`);
      const data = d.content ? await this.opts.content.get(d.content) : undefined;
      const real = data && (await realWithin(join(dir, relative(vmDir, d.path)), realDir));
      // Not through a link, which Claude could have pointed anywhere on the host.
      if (real) await writeIn(real.dir, real.name, data, this.opts.scratch);
    }
  }

  /** A saved session deleted for good: its artifacts go too. */
  deleted(info: SessionInfo): void {
    this.unwatch(info.id);
    const home = this.opts.home(info.sandbox);
    // From inside the artifacts' folder of the Kumiko folder, so a folder on the way that Claude made a link isn't followed.
    if (home) void realpath(home.kumikoHome).then((real) => removeIn(join(real, "artifacts"), info.id, { recursive: true }), () => {});
  }

  /** The server is going away: nothing more is watched. */
  close(): void {
    this.stopped = true;
    for (const id of [...this.watchers.keys()]) this.unwatch(id);
  }

  /** The session is no longer open. */
  closed(id: string): void {
    this.unwatch(id);
    for (const key of this.seen.keys()) if (key.startsWith(`${id}:`)) this.seen.delete(key);
  }
}

/** A session's name as its tab shows it: its title, or its opening prompt's first words. */
function nameOf(s: SessionInfo): string {
  if (s.title) return s.title;
  const first = s.prompt.trim().split("\n")[0];
  return first.length > 60 ? `${first.slice(0, 60)}…` : first;
}

/** A file in `dir`, whole, as `openIn` finds it: undefined if it isn't a file there, null if it is too large to copy. */
async function readWhole(dir: string, name: string, scratch: string): Promise<Buffer | null | undefined> {
  const opened = await openIn(dir, name, scratch).catch(() => undefined);
  if (!opened) return undefined;
  try {
    const st = await opened.fh.stat();
    if (!st.isFile()) return undefined;
    if (st.size > MAX_SHARED_BYTES) return null;
    return await opened.fh.readFile();
  } finally {
    await opened.done();
  }
}

function str(v: unknown, name: string): string {
  if (typeof v !== "string" || !v) throw new ToolError(`${name} must be a non-empty string.`);
  return v;
}

/** Where an artifact goes: into a pane that is there, in place of what it shows, or a new pane from a split. */
type Target = { pane: PaneId } | { split: Place };

/** The `place` Claude asked for, if any. */
function targetOf(v: unknown): Target | undefined {
  if (v === undefined) return undefined;
  const usage = `place must be { split: "right" | "below" | "left" | "above", of?, size? } or { in: <pane> }.`;
  if (typeof v !== "object" || v === null) throw new ToolError(usage);
  const { split, of, size, in: into } = v as Record<string, unknown>;
  if (into !== undefined) {
    if (typeof into !== "string" || !into) throw new ToolError("place.in must be a pane's id.");
    return { pane: into };
  }
  if (split !== "right" && split !== "below" && split !== "left" && split !== "above") throw new ToolError(`place.split must be a side. ${usage}`);
  if (of !== undefined && typeof of !== "string") throw new ToolError("place.of must be a pane's id.");
  if (size !== undefined && typeof size !== "number") throw new ToolError("place.size must be a number between 0.2 and 0.8.");
  return { split: { split, ...(of ? { of } : {}), ...(size !== undefined ? { size } : {}) } };
}

/** Where an artifact goes by default: the active pane if it shows an artifact, else any pane that does. */
export function docPaneTarget(w: WindowState): Target | undefined {
  const showsDoc = (pane: string | undefined) => pane !== undefined && w.widgets[w.panes[pane]]?.kind === "artifact";
  const pane = showsDoc(w.active) ? w.active : paneIds(w.layout).find(showsDoc);
  return pane ? { pane } : undefined;
}

/** The first heading of an artifact, or its file's name. */
/** The first heading of a Markdown artifact, an HTML page's title, or its file's name. */
function titleOf(path: string, type: ArtifactType, text: string): string {
  const heading =
    type === "markdown" ? /^#{1,6}\s+(.+?)\s*#*\s*$/m.exec(text)?.[1] : type === "html" ? /<title[^>]*>\s*([^<]+?)\s*<\/title>/i.exec(text)?.[1] : undefined;
  return (heading || posix.basename(path)).slice(0, MAX_TITLE);
}

/** The window for Claude: its layout, what each pane shows, and the artifacts not shown. */
function describe(w: WindowState): string {
  const name = (pane: string) => {
    const id = w.panes[pane];
    const widget = w.widgets[id];
    if (widget?.kind === "chat") return `${pane} (the chat)`;
    const d = widget?.state as ArtifactState | undefined;
    return `${pane} (artifact ${id} "${d?.title}", ${d?.path}${d?.missing ? ", file missing" : ""}${d?.type === "web" && !d.approved ? ", waiting for the user to allow it" : ""})`;
  };
  const tree = (l: Layout): string => (l.kind === "pane" ? name(l.id) : `${l.dir === "row" ? "side by side" : "one above the other"}: [${tree(l.a)}, ${tree(l.b)}]`);
  const hidden = artifactsOf(w).filter(([id]) => !paneOf(w, id));
  const panes = paneIds(w.layout).length;
  return `Window (${panes} pane${panes > 1 ? "s" : ""}): ${tree(w.layout)}.${hidden.length ? ` Not shown: ${hidden.map(([id, d]) => `artifact ${id} "${d.title}", ${d.path}`).join("; ")}. The user can switch an artifact pane to any of them, and so can artifact_open.` : ""}`;
}

const PLACE_SCHEMA = {
  type: "object",
  description:
    "Where to show it. Leave it out to show it in the artifact pane used last (or a new pane right of the chat if there is none). `split` opens a new pane right of or below a pane (the chat's by default), taking `size` of its room (0.5 by default); `in` shows it in that pane instead of the artifact there.",
  properties: {
    split: { type: "string", enum: ["right", "below", "left", "above"] },
    of: { type: "string", description: 'The pane to split, as window_list names it. Default: "chat".' },
    size: { type: "number", minimum: 0.2, maximum: 0.8 },
    in: { type: "string", description: "A pane showing an artifact, as window_list names it." },
  },
};

/** The tools for a session whose artifacts go in `folder`, in the VM. */
const toolsFor = (folder: string): ToolSpec[] => [
  {
    name: "artifact_open",
    alwaysLoad: true,
    description:
      `Shows an artifact in a pane beside the chat, for the user to look at while it changes: a plan, a spec or a report in Markdown (.md), a page in HTML (.html, shown in a sandbox; it may load from https CDNs but not from this machine), a drawing in SVG (.svg), a diagram in Mermaid (.mmd, flowcharts, sequence diagrams and the like; Markdown artifacts can also have \`\`\`mermaid blocks), or an image (.png, .jpg, .gif, .webp, up to 2 MB), such as a chart you generate; or, with url, a live preview of a page the sandbox serves, such as a dev server's, or a public website (a deployed site, a reference); the user allows each site once per session before it loads, and private networks are off limits. It takes the file's path, not its content: write the file first, then open it once; after that, keep changing the file, and the pane follows it. An artifact pane shows one artifact at a time and the user can switch it to any of the window's artifacts, so open each artifact in the same pane unless the user wants two side by side; the one it replaces stays in the window. Opening a file that is shown already does nothing; opening a preview that is shown already loads it again. Artifacts live in this session's folder, ${folder}/: write each file there; files elsewhere, such as the repository's, aren't artifacts.`,
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "The file's path, absolute or relative to the working directory." },
        url: {
          type: "string",
          description:
            "Instead of path: a page served in the sandbox to preview live, such as a dev server's (http://localhost:5173/; start the server listening on 127.0.0.1 or 0.0.0.0 first), or a public website, which loads once the user allows its site.",
        },
        title: { type: "string", description: "The pane's title. Default: the file's first heading, or its name." },
        place: PLACE_SCHEMA,
      },
    },
  },
  {
    name: "artifact_capture",
    alwaysLoad: true,
    description:
      "Takes a picture of an artifact's pane as the user sees it now and gives it to you, so you can see what you made: a preview of a page or component, an HTML artifact, a diagram. Use it while iterating on how something looks. The artifact has to be shown, and the user's window open on this session.",
    inputSchema: {
      type: "object",
      properties: {
        artifact: { type: "string", description: "The artifact's id (as window_list names it), its file's path, or a preview's URL. Default: the pane used last." },
        reload: { type: "boolean", description: "For a page (HTML or preview): load it again first, and wait for it, so the picture shows what the page serves now." },
        wait: {
          type: "number",
          minimum: 0,
          maximum: 10000,
          description: "Milliseconds to wait before taking the picture, for animations, transitions or data that loads late (a chart drawing itself: ~1500). Default: 300 after a reload, else 0.",
        },
      },
    },
  },
  {
    name: "artifact_reload",
    description:
      "Loads an HTML artifact or a preview again, as Reload in its pane does: for a dev server without live reload, or a page that is stuck. Other artifacts follow their files and needn't be. To see the result too, use artifact_capture with reload instead.",
    inputSchema: {
      type: "object",
      properties: { artifact: { type: "string", description: "The artifact's id (as window_list names it), its file's path, or a preview's URL. Default: the pane used last." } },
    },
  },
  {
    name: "window_list",
    alwaysLoad: true,
    description: "Lists the panes of the window this conversation is shown in, and artifacts that aren't shown (the user may have closed them).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "window_close",
    alwaysLoad: true,
    description: "Closes a pane. Its artifact stays and can be shown again with artifact_open. The chat's pane can't be closed.",
    inputSchema: { type: "object", properties: { pane: { type: "string", description: "The pane, as window_list names it." } }, required: ["pane"] },
  },
  {
    name: "session_rename",
    alwaysLoad: true,
    description: `Names this session; its tab in the user's window shows the name. Give a few words, up to ${MAX_SESSION_TITLE} characters, saying what the work is, once the user has made that clear; name it again only if the subject really changes. Describe it too, in a sentence: the list of sessions to resume shows the description under the name. A name the user gave with /rename stands, and can't be changed, but the description still can.`,
    inputSchema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          maxLength: MAX_SESSION_TITLE,
          description: `The name, at most ${MAX_SESSION_TITLE} characters counting spaces, such as "Fix composer paste"; a longer one is refused.`,
        },
        description: {
          type: "string",
          description: `What the session is about, up to ${MAX_SESSION_DESCRIPTION} characters, such as "Pasting an image into the composer attaches it instead of inserting its path."`,
        },
      },
      required: ["title"],
    },
  },
  {
    name: "session_start",
    description: `Asks the user to start a new session in this project, beside this one, on an opening prompt you write: for separate work that came up, such as a bug found along the way or a follow-up, that shouldn't hold up or crowd this session. The chat shows the user the prompt, and the session starts, in a tab of its own, only once they accept it; you won't hear whether they do. It starts in the project's clone with nothing of this conversation, so the prompt has to say everything it needs: what to do, why, and where to look.`,
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: `The new session's opening prompt, up to ${MAX_PROPOSED_PROMPT} characters, as the user would write it.` },
        title: {
          type: "string",
          maxLength: MAX_SESSION_TITLE,
          description: `A name for the new session, at most ${MAX_SESSION_TITLE} characters counting spaces, as session_rename takes; its tab shows it. A longer one is refused.`,
        },
        artifacts: {
          type: "array",
          items: { type: "string" },
          description: `Artifacts of this session to give it, by id or path, up to ${MAX_SHARED}: a plan or spec it works from, say. It gets copies of their files as they are when the user accepts, in its own artifacts folder and window, and the prompt names them.`,
        },
      },
      required: ["prompt"],
    },
  },
  {
    name: "session_list",
    description:
      "Lists the sessions in this project, as the user's tabs name them, with what each is about: the open ones (working, idle, or waiting for the user) and the saved ones the user can resume. Use it to find work already under way elsewhere before starting more, or the session to share an artifact with.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "artifact_share",
    description: `Copies artifacts of this session into another open session of this project (as session_list names it): their files go in its artifacts folder, and its window has them for the user to show. They are copies, as they are now: changing yours later doesn't change them, so share again to send a newer one, which replaces the copy. The other session's Claude is told with the user's next message there, not before.`,
    inputSchema: {
      type: "object",
      properties: {
        session: { type: "string", description: "The session's id, as session_list gives it." },
        artifacts: { type: "array", items: { type: "string" }, description: `The artifacts, by id (as window_list names them) or path, up to ${MAX_SHARED}.` },
      },
      required: ["session", "artifacts"],
    },
  },
  {
    name: "artifact_remove",
    description:
      "Deletes an artifact: takes it out of the window and deletes its file (a preview or a website just goes from the window). For one that is finished with or was opened by mistake. If a pane shows it, the pane goes back to what it showed before, or shows another artifact, or closes.",
    inputSchema: {
      type: "object",
      properties: { artifact: { type: "string", description: "The artifact's id (as window_list names it, e.g. w3), its file's path, or a preview's URL." } },
      required: ["artifact"],
    },
  },
];

/**
 * The ops that take an artifact out of the window. A pane showing it goes back to what it showed before the artifact
 * took its place, if that is still in the window and not shown elsewhere. Failing that, with `instead: "another"`, it
 * shows the artifact added last of those no pane shows, so the user's layout stays; with `"close"`, or with none, it
 * closes.
 */
export function removeArtifact(w: WindowState, widget: WidgetId, instead: "another" | "close" = "another"): WindowOp[] {
  const pane = paneOf(w, widget);
  const below = w.under?.[widget];
  const back = pane && below && w.widgets[below] && !paneOf(w, below) ? below : undefined;
  const other = pane && !back && instead === "another" ? artifactsOf(w).findLast(([id]) => id !== widget && !paneOf(w, id))?.[0] : undefined;
  const next = back ?? other;
  return [...(pane && next ? [{ type: "show" as const, pane, widget: next }] : []), { type: "remove", widget }];
}
