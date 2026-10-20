import { constants } from "node:fs";
import { access, cp, lstat, mkdir, readdir, readFile, realpath, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { CLAUDE_HOME_IN_VM, NAME_PATTERN, projectMountRole, WORKTREES_SUFFIX, type Mount, type Project, type SandboxSpec } from "@kumiko/shared";
import { cloneProblem } from "./git.js";

export function defaultKumikoHome(): string {
  return process.env.KUMIKO_HOME ?? join(homedir(), ".kumiko");
}

/**
 * Kumiko was called Bentomo, and kept its state in ~/.bentomo. Moves that to ~/.kumiko, once, unless KUMIKO_HOME
 * points elsewhere or ~/.kumiko is there already.
 */
export async function adoptBentomoHome(): Promise<void> {
  if (process.env.KUMIKO_HOME) return;
  const old = join(homedir(), ".bentomo"), home = defaultKumikoHome();
  if (!(await exists(old)) || (await exists(home))) return;
  await rename(old, home);
}

const exists = (path: string) => lstat(path).then(() => true, () => false);

/** The file Kumiko owns in each Claude home, imported by CLAUDE.md. Rewritten whenever the VM or a session starts. */
export const MANAGED_FILE = "kumiko.md";
/** What the managed file was called when Kumiko was Bentomo. */
const OLD_MANAGED_FILE = "bentomo.md";

/** What a new app-level template's CLAUDE.md says. The import is what brings in Kumiko's instructions. */
const TEMPLATE_CLAUDE_MD = `@${MANAGED_FILE}

<!--
  Your instructions for Claude in this project's sandbox go here. Kumiko seeded this file once and won't touch it again;
  its own instructions are in ${MANAGED_FILE}, which it rewrites, so keep the import above.
-->
`;

/** Kumiko's instructions for a project: the worktree convention, with the project's real paths. */
export function managedInstructions(p: Project): string {
  return `<!-- Written by Kumiko, and rewritten whenever the sandbox or a session starts: edit CLAUDE.md instead. -->

# Working in this project

The git clone is \`${p.clonePath}\`. Sessions start there.

## Worktrees

- When a task changes code, make a worktree for it first and work there:
  \`git worktree add "${p.worktreesPath}/<branch>" -b <branch>\`, then \`cd\` into it. Pick a short branch name that says what the work is.
- Worktrees go in \`${p.worktreesPath}/\` and nowhere else: not inside the clone, not in /tmp.
- Questions and read-only exploration don't need a worktree; look around in the clone and leave it as it is.
- If the user asks for a worktree, or names an existing one, use that.
- Other sessions may be working in other worktrees at the same time. Leave worktrees you didn't create alone.
`;
}

/** Creating a project whose id is taken: by an earlier project, or by a create that raced this one. */
export class ProjectExists extends Error {
  constructor(id: string) {
    super(`There is already a project called ${id}.`);
  }
}

/** A project's record is there but can't be used: not JSON, edited by hand, or unreadable. */
export class ProjectRecordError extends Error {
  constructor(readonly file: string, why: string) {
    super(`Kumiko's record of a project, ${file}, can't be read (${why}). Fix the file, or delete it to drop the project.`);
  }
}

/** Ids name files and folders; only the sandbox name shape may. */
function assertId(id: string): void {
  if (!NAME_PATTERN.test(id)) throw new Error(`Not a project id: ${id}`);
}

export interface CreatedProject {
  project: Project;
  /** Undoes what creating the project did on the host, for a create that fails before its VM is started. */
  rollback(): Promise<void>;
}

/**
 * Projects, one JSON file each, and their Claude homes. A project's VM (its sandbox) is the provider's business;
 * this only knows the paths it is built from.
 */
export class ProjectStore {
  readonly dir: string;
  readonly claudeRoot: string;
  readonly templateDir: string;

  constructor(home: string = defaultKumikoHome()) {
    this.dir = join(home, "projects");
    this.claudeRoot = join(home, "claude");
    this.templateDir = join(home, "claude-template");
  }

  private file(id: string): string {
    assertId(id);
    return join(this.dir, `${id}.json`);
  }

  claudeHome(id: string): string {
    assertId(id);
    return join(this.claudeRoot, id);
  }

  /** The project's record; undefined when there is none, ProjectRecordError when there is one that can't be used. */
  async get(id: string): Promise<Project | undefined> {
    if (!NAME_PATTERN.test(id)) return undefined;
    const file = this.file(id);
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new ProjectRecordError(file, err instanceof Error ? err.message : String(err));
    }
    let p: Partial<Project> | null;
    try {
      p = JSON.parse(text) as Partial<Project> | null;
    } catch {
      throw new ProjectRecordError(file, "not valid JSON");
    }
    if (p?.id !== id) throw new ProjectRecordError(file, `its id isn't ${id}`);
    if (typeof p.clonePath !== "string" || typeof p.worktreesPath !== "string") throw new ProjectRecordError(file, "it has no clone or worktrees path");
    return p as Project;
  }

  /** Every project, by id, and why each record that can't be used can't be. */
  async list(): Promise<{ projects: Project[]; errors: string[] }> {
    let files: string[];
    try {
      files = await readdir(this.dir);
    } catch {
      return { projects: [], errors: [] };
    }
    const projects: Project[] = [];
    const errors: string[] = [];
    await Promise.all(
      files
        .filter((f) => f.endsWith(".json"))
        .map(async (f) => {
          const id = f.slice(0, -".json".length);
          if (!NAME_PATTERN.test(id)) return void errors.push(new ProjectRecordError(join(this.dir, f), "its name isn't a project id").message);
          try {
            const p = await this.get(id);
            if (p) projects.push(p);
          } catch (err) {
            if (!(err instanceof ProjectRecordError)) throw err;
            errors.push(err.message);
          }
        }),
    );
    return { projects: projects.sort((a, b) => a.id.localeCompare(b.id)), errors: errors.sort() };
  }

  /** Writes a new project's record, failing if the id is taken: two creates racing for one name can't both win. */
  private async claim(p: Project): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.file(p.id), JSON.stringify(p, null, 2) + "\n", { flag: "wx" }).catch((err: NodeJS.ErrnoException) => {
      throw err.code === "EEXIST" ? new ProjectExists(p.id) : err;
    });
  }

  /**
   * Checks a clone and works out its paths, without changing anything. Returns the real path of the clone, since a
   * worktree's `.git` file stores real paths and the VM must see the same ones.
   */
  async check(id: string, rawClonePath: string): Promise<{ errors: string[]; clonePath?: string; worktreesPath?: string }> {
    const errors: string[] = [];
    if (!NAME_PATTERN.test(id)) errors.push("Name must be 1–30 lowercase letters, digits or dashes, not starting or ending with a dash.");
    // Taken even when its record can't be read: creating would fail on the file anyway.
    else if (await lstat(this.file(id)).then(() => true, () => false)) errors.push(new ProjectExists(id).message);

    const raw = rawClonePath.trim().replace(/^~(?=\/|$)/, homedir());
    if (!raw) return { errors: [...errors, "Pick the clone to work in."] };
    if (!isAbsolute(raw)) return { errors: [...errors, `${raw} must be an absolute path.`] };
    let clonePath: string;
    try {
      clonePath = await realpath(normalize(raw));
      if (!(await stat(clonePath)).isDirectory()) return { errors: [...errors, `${raw} is not a folder.`] };
    } catch {
      return { errors: [...errors, `${raw} does not exist.`] };
    }
    if (clonePath === "/") return { errors: [...errors, "The root folder can't be a project."] };

    const problem = await cloneProblem(clonePath);
    if (problem) errors.push(problem);
    const taken = (await this.list()).projects.find((p) => p.clonePath === clonePath);
    if (taken) errors.push(`${clonePath} is already the project ${taken.id}.`);

    const worktreesPath = clonePath + WORKTREES_SUFFIX;
    const existing = await lstat(worktreesPath).catch(() => undefined);
    if (existing && !existing.isDirectory()) {
      errors.push(`${worktreesPath} exists but isn't a folder, so worktrees can't go there. Move it aside first.`);
    } else if (!existing) {
      const parent = dirname(clonePath);
      if (!(await access(parent, constants.W_OK).then(() => true, () => false))) {
        errors.push(`Can't create ${worktreesPath}: ${parent} isn't writable.`);
      }
    }
    return { errors, clonePath, worktreesPath };
  }

  /**
   * Creates what a project needs on the host: the worktrees folder (if missing), the Claude home seeded from the
   * app-level template, and the project's record. `check` must have passed. The VM is the caller's to create.
   */
  async create(id: string, clonePath: string, worktreesPath: string): Promise<CreatedProject> {
    const project: Project = { id, clonePath, worktreesPath, createdAt: new Date().toISOString() };
    await this.claim(project);
    let madeWorktrees = false;
    const rollback = async () => {
      await rm(this.file(id), { force: true });
      await rm(this.claudeHome(id), { recursive: true, force: true });
      // Only a folder Kumiko made, and only while it is still empty.
      if (madeWorktrees) await rmdir(worktreesPath).catch(() => {});
    };
    try {
      madeWorktrees = await mkdir(worktreesPath).then(() => true, (err: NodeJS.ErrnoException) => {
        if (err.code === "EEXIST") return false;
        throw err;
      });
      await this.seedClaudeHome(project);
    } catch (err) {
      await rollback();
      throw err;
    }
    return { project, rollback };
  }

  /** Makes the app-level template the first time it is needed, so the user can find and change it. */
  private async ensureTemplate(): Promise<void> {
    if (await stat(this.templateDir).then(() => true, () => false)) return renameImport(this.templateDir);
    await mkdir(this.templateDir, { recursive: true });
    await writeFile(join(this.templateDir, "CLAUDE.md"), TEMPLATE_CLAUDE_MD, { flag: "wx" }).catch(() => {});
  }

  /** Copies the template into a new Claude home, once; from then on the two are independent. */
  private async seedClaudeHome(p: Project): Promise<void> {
    await this.ensureTemplate();
    const home = this.claudeHome(p.id);
    await mkdir(this.claudeRoot, { recursive: true });
    await cp(this.templateDir, home, { recursive: true, errorOnExist: false, force: false });
    await this.writeManaged(p);
  }

  /** Rewrites Kumiko's own instructions in the project's Claude home; CLAUDE.md is the user's. */
  async writeManaged(p: Project): Promise<void> {
    const home = this.claudeHome(p.id);
    await mkdir(home, { recursive: true });
    await writeFile(join(home, MANAGED_FILE), managedInstructions(p));
    await renameImport(home);
  }

  /** Deletes the project's record and its Claude home, which holds its login and Claude's session history. */
  async remove(id: string): Promise<void> {
    await rm(this.file(id), { force: true });
    await rm(this.claudeHome(id), { recursive: true, force: true });
  }

  /** What is wrong with the project's folders on the host, if anything. The VM can't start without them. */
  async problem(p: Project): Promise<string | undefined> {
    const isDir = (path: string) => stat(path).then((s) => s.isDirectory(), () => false);
    if (!(await isDir(p.clonePath))) return `The clone ${p.clonePath} is gone. Put it back to use this project.`;
    if (!(await isDir(p.worktreesPath))) return `The worktrees folder ${p.worktreesPath} is gone. Create it again, empty, to use this project.`;
    return undefined;
  }

  /**
   * The mounts every project's VM has: the clone and its worktrees at the same paths as on the host, which git needs
   * (a worktree's `.git` file holds the main repo's absolute path), and the Claude home as the VM user's ~/.claude.
   */
  fixedMounts(p: Project): Mount[] {
    return [
      { hostPath: p.clonePath, guestPath: p.clonePath, writable: true },
      { hostPath: p.worktreesPath, guestPath: p.worktreesPath, writable: true },
      { hostPath: this.claudeHome(p.id), guestPath: CLAUDE_HOME_IN_VM, writable: true },
    ];
  }

  /** The project's fixed mounts, then the others in `mounts`; any fixed ones among those are replaced, not repeated. */
  mounts(p: Project, mounts: Mount[]): Mount[] {
    const extra = mounts.filter((m) => !projectMountRole(p, m, this.claudeHome(p.id)));
    return [...this.fixedMounts(p), ...extra];
  }

  /** The VM's spec: the user's resources, extra mounts, variables and script, plus what every project has. */
  spec(p: Project, base: Omit<SandboxSpec, "name" | "workdir">): SandboxSpec {
    return { ...base, name: p.id, mounts: this.mounts(p, base.mounts), workdir: p.clonePath };
  }
}

/** Points a CLAUDE.md written when Kumiko was Bentomo at the renamed managed file, and drops the old one. */
async function renameImport(home: string): Promise<void> {
  const file = join(home, "CLAUDE.md");
  const text = await readFile(file, "utf8").catch(() => undefined);
  const renamed = text?.replace(/^@bentomo\.md$/m, `@${MANAGED_FILE}`);
  if (renamed !== text) await writeFile(file, renamed!);
  await rm(join(home, OLD_MANAGED_FILE), { force: true });
}
