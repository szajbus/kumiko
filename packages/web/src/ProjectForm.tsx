import { useEffect, useId, useMemo, useState } from "react";
import {
  CLAUDE_HOME_IN_VM,
  DEFAULTS,
  ENV_NAME_PATTERN,
  MINIMUMS,
  NAME_PATTERN,
  sameMounts,
  vmName,
  WORKTREES_SUFFIX,
  type CreateProjectRequest,
  type Mount,
  type ProjectView,
  type TemplatesResponse,
} from "@bentomo/shared";
import { api, errorMessage, RequestError, useDefaults } from "./api";
import { sessionsNote } from "./actions";
import { ConfirmDialog } from "./ConfirmDialog";
import { Breadcrumbs } from "./Breadcrumbs";
import { tilde } from "./format";
import { Cross, Folder, Plus, Redo, Save, Close } from "./icons";
import { Select, type SelectGroup } from "./Select";
import { COLORS } from "./status";

interface Props {
  /** Edit this project's VM instead of creating a project. The clone, name and template are fixed; saving in place needs the VM stopped for resources and mounts. */
  editing?: ProjectView;
  onCancel(): void;
  /** Called with the project's id once it's created or the edit is saved. */
  onCreated(id: string): void;
}

interface MountRow {
  id: number;
  hostPath: string;
  /** Where it lands in the VM; empty means the same path as on the host. */
  guestPath: string;
  writable: boolean;
}

/** An absolute path or ~/…, but not / or ~ alone. */
const vmPathShape = (t: string) => (t.startsWith("/") && t !== "/") || (t.startsWith("~/") && t.length > 2);

function guestPathOk(p: string, rows: MountRow[], self: number): boolean {
  const t = p.trim();
  if (!t) return true; // the same path as on the host
  return vmPathShape(t) && !rows.some((r) => r.id !== self && (r.guestPath.trim() || r.hostPath.trim()) === t);
}

/** A project name from a folder name, as the server would suggest it. */
export function suggestName(path: string): string {
  const base = path.replace(/\/+$/, "").split("/").pop() ?? "";
  return base.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30).replace(/-+$/, "");
}

/** Whether a stored mount is one every project has: clone, worktrees or Claude home. The form only shows the others. */
const isFixed = (p: ProjectView, m: Mount) => {
  const guest = m.guestPath ?? m.hostPath;
  return (
    (m.hostPath === p.project.clonePath && guest === p.project.clonePath) ||
    (m.hostPath === p.project.worktreesPath && guest === p.project.worktreesPath) ||
    guest === CLAUDE_HOME_IN_VM
  );
};

interface EnvRow {
  id: number;
  name: string;
}

let nextId = 1;
const hasPicker = () => typeof window.bentomo?.pickFolder === "function";

export function ProjectForm({ editing, onCancel, onCreated }: Props) {
  const was = editing?.meta?.spec;
  const defaults = useDefaults();
  const home = defaults?.home;
  const [clonePath, setClonePath] = useState(editing?.project.clonePath ?? "");
  const [name, setNameRaw] = useState(editing?.name ?? "");
  // The name follows the clone's folder until the user types one.
  const [nameEdited, setNameEdited] = useState(Boolean(editing));
  const [templates, setTemplates] = useState<TemplatesResponse | undefined>();
  const [templatesError, setTemplatesError] = useState<string | undefined>();
  const [template, setTemplate] = useState(was ? was.template || "template:default" : "");
  // Lima's current values win over the stored spec, in case the VM was edited outside Bentomo.
  const [cpus, setCpus] = useState(String(editing?.cpus ?? was?.cpus ?? DEFAULTS.cpus));
  const [memory, setMemory] = useState(String(editing?.memoryGiB ?? was?.memoryGiB ?? DEFAULTS.memoryGiB));
  const [disk, setDisk] = useState(String(editing?.diskGiB ?? was?.diskGiB ?? DEFAULTS.diskGiB));
  const extraWas = useMemo(() => (editing && was ? was.mounts.filter((m) => !isFixed(editing, m)) : []), [editing, was]);
  const [mounts, setMounts] = useState<MountRow[]>(() =>
    extraWas.map((m) => ({ id: nextId++, hostPath: m.hostPath, guestPath: m.guestPath && m.guestPath !== m.hostPath ? m.guestPath : "", writable: m.writable })),
  );
  const [envRows, setEnvRows] = useState<EnvRow[]>(() => (was?.env ?? []).map((n) => ({ id: nextId++, name: n })));
  const [envSet, setEnvSet] = useState<Record<string, boolean>>({});
  const [provision, setProvision] = useState(was?.provision ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [confirmRecreate, setConfirmRecreate] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (editing) return; // the template is fixed
    api.templates().then(
      (t) => {
        setTemplates(t);
        setTemplate((cur) => cur || t.preferred);
      },
      (err: Error) => {
        setTemplatesError(err.message);
        setTemplate((cur) => cur || "template:default");
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Ask the server which forwarded variables it can see; it answers yes/no, never values.
  const envNames = useMemo(() => [...new Set(envRows.map((r) => r.name.trim()).filter((n) => ENV_NAME_PATTERN.test(n)))], [envRows]);
  useEffect(() => {
    const missing = envNames.filter((n) => !(n in envSet));
    if (!missing.length) return;
    const t = setTimeout(() => {
      api.env(missing).then((r) => setEnvSet((cur) => ({ ...cur, ...r })), () => {});
    }, 250);
    return () => clearTimeout(t);
  }, [envNames, envSet]);

  const nameOk = NAME_PATTERN.test(name);
  const cloneOk = editing || clonePath.trim().startsWith("/") || clonePath.trim().startsWith("~/");
  const shownName = name || "<name>";
  const clone = clonePath.trim().replace(/\/+$/, "");

  const setClone = (path: string) => {
    setClonePath(path);
    if (!nameEdited) setNameRaw(suggestName(path));
  };
  const setName = (v: string) => {
    setNameRaw(v.toLowerCase());
    setNameEdited(v.trim() !== "");
  };
  const pickClone = async () => {
    const path = await window.bentomo!.pickFolder();
    if (path) setClone(path);
  };

  const addFolder = async () => {
    if (hasPicker()) {
      const path = await window.bentomo!.pickFolder();
      if (path) setMounts((all) => [...all, { id: nextId++, hostPath: path, guestPath: "", writable: false }]);
    } else {
      setMounts((all) => [...all, { id: nextId++, hostPath: "", guestPath: "", writable: false }]);
    }
  };
  const changeFolder = async (id: number) => {
    const path = await window.bentomo!.pickFolder();
    if (path) patchMount(id, { hostPath: path });
  };
  const patchMount = (id: number, patch: Partial<MountRow>) => setMounts((all) => all.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  const extraMounts = (): Mount[] =>
    mounts
      .filter((m) => m.hostPath.trim())
      .map((m) => ({ hostPath: m.hostPath.trim(), writable: m.writable, guestPath: m.guestPath.trim() || m.hostPath.trim() }));

  const request = (): CreateProjectRequest => ({
    name: name.trim(),
    clonePath: clone,
    template: template || undefined,
    cpus: Number(cpus),
    memoryGiB: Number(memory),
    diskGiB: Number(disk),
    mounts: extraMounts(),
    env: envNames,
    provision: provision.trim() ? provision : undefined,
  });

  /**
   * Why saving in place won't work, if it won't. Resources and mounts go through `limactl edit`,
   * which needs the VM stopped and can't shrink the disk; recreating has neither limit.
   */
  const inPlaceBlocked = (() => {
    if (!editing) return undefined;
    if (editing.status === "absent") return `${editing.vm} doesn't exist, so it can only be created again.`;
    const s = request();
    const diskNow = Math.ceil(editing.diskGiB ?? was?.diskGiB ?? 0);
    const vmChanged =
      s.cpus !== (editing.cpus ?? was?.cpus) ||
      s.memoryGiB !== (editing.memoryGiB ?? was?.memoryGiB) ||
      s.diskGiB !== diskNow ||
      !sameMounts(s.mounts, extraWas);
    if (s.diskGiB < diskNow) return `Disk can only shrink by recreating; it is ${diskNow} GiB now.`;
    if (vmChanged && editing.status !== "stopped") return `Stop ${editing.vm} to save resource or mount changes without recreating it.`;
    return undefined;
  })();

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (!cloneOk) {
      setErrors([]);
      document.getElementById("f-clone")?.focus();
      return;
    }
    if (!nameOk) {
      setErrors([]);
      document.getElementById("f-name")?.focus();
      return;
    }
    if (editing) setConfirmRecreate(true);
    else void save();
  };

  const save = async (recreate = false) => {
    setSubmitting(true);
    setErrors([]);
    try {
      if (editing) {
        const { cpus, memoryGiB, diskGiB, mounts, env, provision } = request();
        await api.edit(editing.name, { cpus, memoryGiB, diskGiB, mounts, env, provision: provision ?? "" }, recreate);
        onCreated(editing.name);
      } else {
        const res = await api.create(request());
        onCreated(res.name);
      }
    } catch (err) {
      setErrors(err instanceof RequestError && err.details.length ? err.details : [errorMessage(err)]);
      setSubmitting(false);
    }
  };

  const preview = useMemo(() => {
    const s = request();
    const vm = vmName(s.name || "<name>");
    const repo = s.clonePath || "<host directory>";
    const fixed = [
      `#   ${repo}  at the same path, writable`,
      `#   ${repo}${WORKTREES_SUFFIX}  at the same path, writable (created if missing)`,
      `#   the project's Claude home  at ${CLAUDE_HOME_IN_VM}, writable (CLAUDE_CONFIG_DIR)`,
      ...s.mounts.map((m) => `#   ${m.hostPath}  at ${m.guestPath === m.hostPath ? "the same path" : m.guestPath}${m.writable ? ", writable" : ""}`),
    ];
    const lines = [
      "# mounts:",
      ...fixed,
      `limactl create --tty=false --name=${vm} --cpus=${s.cpus} --memory=${s.memoryGiB} --disk=${s.diskGiB} --set '.mounts = […]' ${s.template || "template:default"}`,
      `limactl start --tty=false ${vm}`,
      "# then Claude Code's installer over ssh, linked to /usr/local/bin/claude",
    ];
    if (s.provision) {
      const fwd = s.env.filter((n) => envSet[n]);
      lines.push(`# then the provisioning script in ${repo}${fwd.length ? `, with ${fwd.join(", ")} forwarded` : ""}`);
    }
    return lines.join("\n");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, clonePath, template, cpus, memory, disk, mounts, envNames, envSet, provision]);

  return (
    <>
      <form className="form-main" onSubmit={submit} noValidate>
        <Breadcrumbs
          items={
            editing
              ? [{ label: "Projects", href: "#/" }, { label: editing.name, href: `#/project/${editing.name}` }, { label: "Edit" }]
              : [{ label: "Projects", href: "#/" }, { label: "New project" }]
          }
        />
        <div className="form-intro">
          {editing ? (
            <>
              <h1 className="page-title page-title-lg">Edit {editing.name}</h1>
            </>
          ) : (
            <>
              <h1 className="page-title page-title-lg">New project</h1>
              <p className="muted">
                A git clone on this machine, with a sandbox of its own. Claude works in the clone and in worktrees beside it, in{" "}
                <code className="mono">{clone ? tilde(clone, home) : "<host directory>"}{WORKTREES_SUFFIX}</code>. Nothing is written into the repository.
              </p>
            </>
          )}
        </div>

        <Section title="Project" id="sec-basics">
          <Field
            label="Host directory"
            htmlFor="f-clone"
            invalid={touched && !cloneOk}
            hint={
              editing
                ? "The host directory can't change after creation."
                : touched && !cloneOk
                  ? "Pick the folder of a git clone."
                  : "A git clone on this machine: its top folder, not a worktree."
            }
          >
            {hasPicker() && !editing ? (
              <div className="clone-pick">
                <span className="mono path clone-path" title={clone}>
                  {clone ? tilde(clone, home) : <span className="dim">No folder picked</span>}
                </span>
                <button type="button" id="f-clone" className="btn-small" onClick={pickClone} autoFocus>
                  {clone ? "Change…" : "Choose…"}
                </button>
              </div>
            ) : (
              <input
                id="f-clone"
                className="input input-dark mono"
                type="text"
                value={clonePath}
                disabled={Boolean(editing)}
                autoFocus={!editing}
                placeholder="/absolute/path/to/clone"
                spellCheck={false}
                autoComplete="off"
                aria-invalid={touched && !cloneOk}
                onChange={(e) => setClone(e.target.value)}
              />
            )}
          </Field>
          <Field
            label="Name"
            htmlFor="f-name"
            invalid={touched && !nameOk}
            hint={
              editing ? (
                "The name can't change after creation."
              ) : (
                <>
                  Lowercase letters, digits and dashes. The sandbox will be <code className="mono">{vmName(shownName)}</code>.
                </>
              )
            }
          >
            <input
              id="f-name"
              className={`input input-dark mono${touched && !nameOk ? " is-invalid" : ""}`}
              type="text"
              value={name}
              disabled={Boolean(editing)}
              autoComplete="off"
              spellCheck={false}
              placeholder="web"
              aria-invalid={touched && !nameOk}
              onChange={(e) => setName(e.target.value)}
              onBlur={() => name && setTouched(true)}
            />
          </Field>
        </Section>

        <div className="form-group-head">
          <h2>Sandbox</h2>
          <p className="muted">
            Everything below configures the project's sandbox, <code className="mono">{vmName(shownName)}</code>: the Lima instance Claude runs in.
          </p>
        </div>

        <Section title="Template and resources" id="sec-res">
          <div className="grid grid-220">
            <Field
              label="Template"
              htmlFor="f-template"
              hint={
                editing ? (
                  "The template can't change after creation."
                ) : templatesError ? (
                  <span style={{ color: COLORS.warn }}>Couldn't list templates: {templatesError}</span>
                ) : (
                  <>
                    From <code className="mono">limactl create --list-templates</code>.
                  </>
                )
              }
            >
              <Select
                id="f-template"
                mono
                value={template}
                onValueChange={setTemplate}
                groups={editing ? [{ options: [template] }] : templateGroups(templates, templatesError)}
                placeholder="Loading…"
                disabled={Boolean(editing) || (!templates && !templatesError)}
              />
            </Field>
          </div>
          <div className="grid grid-160">
            <NumberField id="f-cpu" label="CPUs" min={MINIMUMS.cpus} whole value={cpus} onChange={setCpus} />
            <NumberField id="f-mem" label="Memory (GiB)" min={MINIMUMS.memoryGiB} value={memory} onChange={setMemory} />
            <NumberField id="f-disk" label="Disk (GiB)" min={MINIMUMS.diskGiB} value={disk} onChange={setDisk} />
          </div>
        </Section>

        <Section title="Default mounts" id="sec-default-mounts" description="Every project's sandbox has these; they can't be changed.">
          <div className="fieldset-stack">
            {[
              { host: clone ? tilde(clone, home) : "<host directory>", at: "the same path", what: "The clone" },
              { host: `${clone ? tilde(clone, home) : "<host directory>"}${WORKTREES_SUFFIX}`, at: "the same path", what: "Worktrees, created if missing" },
              {
                host: defaults ? `${tilde(defaults.claudeHomes, home)}/${name.trim() || "<name>"}` : "The project's Claude home",
                at: CLAUDE_HOME_IN_VM,
                what: "Claude home: login, settings, history",
              },
            ].map((m) => (
              <div key={m.what} className="detail-mount mount-grid">
                <span className="mount-icon">
                  <Folder />
                </span>
                <span className="mono path">{m.host}</span>
                <span className="row-sub">
                  <span className="badge">Writable</span>
                </span>
                <span className="mount-at">at</span>
                <span className="mono path">
                  {m.at} <span className="dim">· {m.what}</span>
                </span>
              </div>
            ))}
          </div>
        </Section>

        <Section
          title="Extra mounts"
          id="sec-mounts"
          description={
            <>
              Other host folders, at the same path in the sandbox unless you set another. <code className="mono">~</code> is the sandbox user's home.
            </>
          }
        >
          <div className="fieldset-stack">
            {mounts.map((m) => {
              const guestOk = guestPathOk(m.guestPath, mounts, m.id);
              return (
                <div key={m.id} className="mount-row mount-grid">
                  <span className="mount-icon">
                    <Folder />
                  </span>
                  {hasPicker() ? (
                    <span className="mono path mount-host-text" title={m.hostPath}>
                      {tilde(m.hostPath, home)}
                    </span>
                  ) : (
                    <input
                      className="input input-compact mono path"
                      type="text"
                      value={m.hostPath}
                      placeholder="/absolute/path/on/host"
                      aria-label="Host folder"
                      autoFocus={!m.hostPath}
                      spellCheck={false}
                      onChange={(e) => patchMount(m.id, { hostPath: e.target.value })}
                    />
                  )}
                  <div className="mount-controls">
                    <label className="check">
                      <input type="checkbox" checked={m.writable} onChange={(e) => patchMount(m.id, { writable: e.target.checked })} />
                      Writable
                    </label>
                    {hasPicker() && (
                      <button type="button" className="btn-small" onClick={() => changeFolder(m.id)}>
                        Change…
                      </button>
                    )}
                    <button
                      type="button"
                      className="icon-btn icon-btn-small"
                      aria-label={`Remove mount ${m.hostPath || "row"}`}
                      onClick={() => setMounts((all) => all.filter((r) => r.id !== m.id))}
                    >
                      <Cross />
                    </button>
                  </div>
                  <label htmlFor={`guest-${m.id}`} className="mount-at">
                    at
                  </label>
                  <input
                    id={`guest-${m.id}`}
                    className="input input-compact input-dark mono path"
                    type="text"
                    value={m.guestPath}
                    placeholder={m.hostPath.trim() ? `${m.hostPath.trim()} (the same path)` : "the same path"}
                    aria-invalid={!guestOk}
                    title={guestOk ? "Where the folder appears in the sandbox" : "Use an absolute path or ~/…, not used by another mount"}
                    spellCheck={false}
                    onChange={(e) => patchMount(m.id, { guestPath: e.target.value })}
                  />
                </div>
              );
            })}
            <button type="button" className="btn-add" onClick={addFolder}>
              <Plus size={14} color="#8FA6F0" />
              {hasPicker() ? "Add folder…" : "Add folder"}
            </button>
          </div>
        </Section>

        <Section
          title="Environment"
          id="sec-env"
          description="Variables forwarded from host to sandbox (names only; values are read from the host each time and never saved)."
        >
          {envRows.map((r) => (
            <EnvRowView
              key={r.id}
              row={r}
              set={envSet[r.name.trim()]}
              onChange={(v) => setEnvRows((all) => all.map((x) => (x.id === r.id ? { ...x, name: v } : x)))}
              onRemove={() => setEnvRows((all) => all.filter((x) => x.id !== r.id))}
            />
          ))}
          <button type="button" className="btn-add" onClick={() => setEnvRows((all) => [...all, { id: nextId++, name: "" }])}>
            <Plus size={14} color="#8FA6F0" />
            Add variable
          </button>
        </Section>

        <Section
          title={<label htmlFor="f-prov">Provisioning</label>}
          id="sec-prov"
          description={
            <>
              Bentomo first installs Claude Code, on <code className="mono">PATH</code> as <code className="mono">claude</code>. Then your script runs
              once, as the sandbox user, in the clone, with the forwarded variables set. <code className="mono">sudo</code> is available. Stops at the first
              failing command.
              {editing && " A new script runs when you save and recreate the sandbox."}
            </>
          }
        >
          <textarea
            id="f-prov"
            className="textarea mono"
            rows={7}
            spellCheck={false}
            value={provision}
            placeholder={"sudo apt-get update\nsudo apt-get install -y ripgrep fd-find jq"}
            onChange={(e) => setProvision(e.target.value)}
          />
        </Section>

        {!editing && (
          <details className="card details">
            <summary>Command preview</summary>
            <pre className="mono preview">{preview}</pre>
          </details>
        )}

        {/* Errors sit beside the buttons, growing downward, so the buttons never move. */}
        <div className="form-actions">
          <div className="form-errors" role="alert">
            {errors.length > 0 ? (
              <div className="banner banner-error">
                <ul>
                  {errors.map((e) => (
                    <li key={e}>{e}</li>
                  ))}
                </ul>
              </div>
            ) : (
              <>
                {/* What the two save buttons do, beside them. */}
                {editing && (
                  <p className="muted form-note">
                    <strong>Save</strong> keeps the sandbox: resource and mount changes need it stopped and apply on its next start, and disk can only
                    grow. <strong>Save and recreate sandbox</strong> deletes the sandbox and builds it again from these settings, provisioning included;
                    Claude's login and history stay.
                  </p>
                )}
                {inPlaceBlocked && <p className="muted form-note">{inPlaceBlocked}</p>}
              </>
            )}
          </div>
          <button type="button" className="btn btn-secondary" onClick={onCancel}>
            <Close />
            Cancel
          </button>
          {editing && (
            <button
              type="button"
              className="btn btn-secondary"
              disabled={submitting || Boolean(inPlaceBlocked)}
              title={inPlaceBlocked}
              onClick={() => {
                setTouched(true);
                void save();
              }}
            >
              <Save />
              Save
            </button>
          )}
          <button type="submit" className="btn btn-primary" disabled={submitting}>
            {editing ? <Redo /> : <Plus />}
            {editing ? (submitting ? "Saving…" : "Save and recreate sandbox") : submitting ? "Creating…" : "Create project"}
          </button>
        </div>

        {confirmRecreate && editing && (
          <ConfirmDialog
            title={`Recreate ${editing.vm}?`}
            confirmLabel="Save and recreate sandbox"
            danger
            onCancel={() => setConfirmRecreate(false)}
            onConfirm={() => {
              setConfirmRecreate(false);
              void save(true);
            }}
          >
            <p>
              The sandbox and its disk are deleted, then created again from these settings and provisioned from scratch. The clone, its worktrees and the
              project's Claude home are not touched.
            </p>
            {sessionsNote(editing)}
          </ConfirmDialog>
        )}
      </form>
    </>
  );
}

function Section({ title, id, description, children }: { title: React.ReactNode; id: string; description?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="card section" aria-labelledby={id}>
      <div className="section-head">
        <h2 id={id}>{title}</h2>
        {description && <span className="muted">{description}</span>}
      </div>
      {children}
    </section>
  );
}

interface FieldProps {
  label: string;
  htmlFor: string;
  hint?: React.ReactNode;
  /** Turns the hint red. The hint line is always reserved, so an error appearing moves nothing. */
  invalid?: boolean;
  children: React.ReactNode;
}

function Field({ label, htmlFor, hint, invalid, children }: FieldProps) {
  return (
    <div className="field">
      <label htmlFor={htmlFor}>{label}</label>
      {children}
      <span className={`hint${invalid ? " is-invalid" : ""}`}>{hint}</span>
    </div>
  );
}

/** Regular templates first, experimental ones in their own group. */
function templateGroups(t: TemplatesResponse | undefined, error: string | undefined): SelectGroup[] {
  if (error || !t) return [{ options: error ? ["template:default"] : [] }];
  const experimental = t.templates.filter((x) => x.startsWith("template:experimental/"));
  const regular = t.templates.filter((x) => !experimental.includes(x));
  return experimental.length ? [{ options: regular }, { label: "Experimental", options: experimental }] : [{ options: regular }];
}

/** A number input that flags what the server would refuse: below `min`, or a fraction when `whole`. */
function NumberField({ id, label, min, whole, value, onChange }: { id: string; label: string; min: number; whole?: boolean; value: string; onChange(v: string): void }) {
  const n = Number(value);
  const bad = value !== "" && (!Number.isFinite(n) || n < min || (whole && !Number.isInteger(n)));
  return (
    <Field label={label} htmlFor={id} hint={bad ? `${whole ? "A whole number, at" : "At"} least ${min}.` : undefined} invalid={bad}>
      <input id={id} className="input input-dark mono" type="number" min={min} step={whole ? 1 : "any"} value={value} aria-invalid={bad} onChange={(e) => onChange(e.target.value)} />
    </Field>
  );
}

function EnvRowView({ row, set, onChange, onRemove }: { row: EnvRow; set?: boolean; onChange(v: string): void; onRemove(): void }) {
  const id = useId();
  const name = row.name.trim();
  const valid = ENV_NAME_PATTERN.test(name);
  let state: { text: string; color: string } | undefined;
  if (name && !valid) state = { text: "Not a valid name", color: COLORS.failed };
  else if (valid && set === true) state = { text: "Set on host", color: COLORS.running };
  else if (valid && set === false) state = { text: "Not set: will be skipped", color: COLORS.warn };
  return (
    <div className="list-row list-row-env">
      <label htmlFor={id} className="sr-only">
        Variable name
      </label>
      <input
        id={id}
        className="input input-compact input-dark mono path"
        type="text"
        value={row.name}
        placeholder="GITHUB_TOKEN"
        autoFocus={!row.name}
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => onChange(e.target.value)}
      />
      <span className="env-state" style={state ? { color: state.color } : undefined} aria-live="polite">
        {state && (
          <>
            <span className="dot dot-small" style={{ background: state.color }} aria-hidden="true" />
            {state.text}
          </>
        )}
      </span>
      <button type="button" className="icon-btn icon-btn-small" aria-label={`Remove ${name || "variable"}`} onClick={onRemove}>
        <Cross />
      </button>
    </div>
  );
}
