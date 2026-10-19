import { useEffect, useId, useMemo, useState } from "react";
import {
  DEFAULTS,
  defaultGuestPath,
  ENV_NAME_PATTERN,
  mountsExpression,
  NAME_PATTERN,
  vmName,
  type SandboxSpec,
  type SandboxView,
  type TemplatesResponse,
} from "@bentomo/shared";
import { api, RequestError } from "./api";
import { ConfirmDialog } from "./ConfirmDialog";
import { Breadcrumbs } from "./Breadcrumbs";
import { Header } from "./Header";
import { Cross, Folder, Plus } from "./icons";
import { Select, type SelectGroup } from "./Select";
import { COLORS } from "./status";

interface Props {
  /** Edit this sandbox instead of creating one. Name and template are fixed; saving in place needs it stopped for resources and mounts. */
  editing?: SandboxView;
  onCancel(): void;
  /** Called with the sandbox's name once it's created or the edit is saved. */
  onCreated(name: string): void;
}

interface MountRow {
  id: number;
  hostPath: string;
  /** Where it lands in the VM; follows the host folder's name until the user edits it. */
  guestPath: string;
  guestEdited: boolean;
  writable: boolean;
}

/** /workspace/<name>, with -2, -3… if another row already uses it. */
function freeGuestPath(hostPath: string, rows: MountRow[], self?: number): string {
  const base = defaultGuestPath(hostPath);
  const taken = new Set(rows.filter((r) => r.id !== self).map((r) => r.guestPath.trim()));
  let p = base;
  for (let i = 2; taken.has(p); i++) p = `${base}-${i}`;
  return p;
}

function guestPathOk(p: string, rows: MountRow[], self: number): boolean {
  const t = p.trim();
  if (!t) return true; // falls back to the default
  const shape = (t.startsWith("/") && t !== "/") || (t.startsWith("~/") && t.length > 2);
  return shape && !rows.some((r) => r.id !== self && r.guestPath.trim() === t);
}

interface EnvRow {
  id: number;
  name: string;
}

let nextId = 1;
const hasPicker = () => typeof window.bentomo?.pickFolder === "function";

export function CreateForm({ editing, onCancel, onCreated }: Props) {
  const was = editing?.meta?.spec;
  const [name, setName] = useState(editing?.name ?? "");
  const [templates, setTemplates] = useState<TemplatesResponse | undefined>();
  const [templatesError, setTemplatesError] = useState<string | undefined>();
  const [template, setTemplate] = useState(was ? was.template || "template:default" : "");
  // Lima's current values win over the stored spec, in case the VM was edited outside Bentomo.
  const [cpus, setCpus] = useState(String(editing?.cpus ?? was?.cpus ?? DEFAULTS.cpus));
  const [memory, setMemory] = useState(String(editing?.memoryGiB ?? was?.memoryGiB ?? DEFAULTS.memoryGiB));
  const [disk, setDisk] = useState(String(editing?.diskGiB ?? was?.diskGiB ?? DEFAULTS.diskGiB));
  const [mounts, setMounts] = useState<MountRow[]>(() =>
    (was?.mounts ?? []).map((m) => ({ id: nextId++, hostPath: m.hostPath, guestPath: m.guestPath ?? m.hostPath, guestEdited: true, writable: m.writable })),
  );
  const [home, setHome] = useState<string | undefined>();
  const [envRows, setEnvRows] = useState<EnvRow[]>(() => (was?.env ?? []).map((n) => ({ id: nextId++, name: n })));
  const [envSet, setEnvSet] = useState<Record<string, boolean>>({});
  const [provision, setProvision] = useState(was?.provision ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [confirmRecreate, setConfirmRecreate] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [touched, setTouched] = useState(false);

  // Start from the server's default mounts (~/.claude when the host has one), unless the user already added rows.
  useEffect(() => {
    api.defaults().then(
      (d) => {
        setHome(d.home);
        if (editing) return;
        setMounts((cur) =>
          cur.length
            ? cur
            : d.mounts.map((m) => ({ id: nextId++, hostPath: m.hostPath, guestPath: m.guestPath ?? m.hostPath, guestEdited: true, writable: m.writable })),
        );
      },
      () => {},
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
  const shownName = name || "<name>";

  const tilde = (p: string) => (home && (p === home || p.startsWith(home + "/")) ? `~${p.slice(home.length)}` : p);

  const addFolder = async () => {
    if (hasPicker()) {
      const path = await window.bentomo!.pickFolder();
      if (path) setMounts((all) => [...all, { id: nextId++, hostPath: path, guestPath: freeGuestPath(path, all), guestEdited: false, writable: false }]);
    } else {
      setMounts((all) => [...all, { id: nextId++, hostPath: "", guestPath: "", guestEdited: false, writable: false }]);
    }
  };
  /** A new host folder also moves the VM path along, unless the user chose that path themselves. */
  const setHost = (id: number, path: string) =>
    setMounts((all) =>
      all.map((r) =>
        r.id !== id ? r : { ...r, hostPath: path, guestPath: r.guestEdited ? r.guestPath : path.trim() ? freeGuestPath(path, all, id) : "" },
      ),
    );
  const changeFolder = async (id: number) => {
    const path = await window.bentomo!.pickFolder();
    if (path) setHost(id, path);
  };
  const patchMount = (id: number, patch: Partial<MountRow>) => setMounts((all) => all.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  const spec = (): SandboxSpec => ({
    name: name.trim(),
    template: template || undefined,
    cpus: Number(cpus),
    memoryGiB: Number(memory),
    diskGiB: Number(disk),
    mounts: mounts
      .filter((m) => m.hostPath.trim())
      .map((m) => ({ hostPath: m.hostPath.trim(), writable: m.writable, guestPath: m.guestPath.trim() || defaultGuestPath(m.hostPath.trim()) })),
    env: envNames,
    provision: provision.trim() ? provision : undefined,
  });

  /**
   * Why saving in place won't work, if it won't. Resources and mounts go through `limactl edit`,
   * which needs the VM stopped and can't shrink the disk; recreating has neither limit.
   */
  const inPlaceBlocked = (() => {
    if (!editing) return undefined;
    const s = spec();
    const key = (ms: SandboxSpec["mounts"]) => JSON.stringify(ms.map((m) => [m.hostPath, m.guestPath ?? m.hostPath, m.writable]));
    const diskNow = Math.ceil(editing.diskGiB ?? was?.diskGiB ?? 0);
    const vmChanged =
      s.cpus !== (editing.cpus ?? was?.cpus) ||
      s.memoryGiB !== (editing.memoryGiB ?? was?.memoryGiB) ||
      s.diskGiB !== diskNow ||
      key(s.mounts) !== key(was?.mounts ?? []);
    if (s.diskGiB < diskNow) return `Disk can only shrink by recreating; it is ${diskNow} GiB now.`;
    if (vmChanged && editing.status !== "stopped") return `Stop ${editing.vm} to save resource or mount changes without recreating it.`;
    return undefined;
  })();

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setTouched(true);
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
        const { cpus, memoryGiB, diskGiB, mounts, env, provision } = spec();
        await api.edit(editing.name, { cpus, memoryGiB, diskGiB, mounts, env, provision: provision ?? "" }, recreate);
        onCreated(editing.name);
      } else {
        const res = await api.create(spec());
        onCreated(res.name);
      }
    } catch (err) {
      if (err instanceof RequestError) setErrors(err.details.length ? err.details : [err.message]);
      else setErrors([String(err)]);
      setSubmitting(false);
    }
  };

  const preview = useMemo(() => {
    const s = spec();
    const vm = vmName(s.name || "<name>");
    const parts = [`limactl create --tty=false --name=${vm} --cpus=${s.cpus} --memory=${s.memoryGiB} --disk=${s.diskGiB}`];
    parts.push(s.mounts.length === 0 ? "--mount-none" : `--set '${mountsExpression(s.mounts).replace(/'/g, `'\\''`)}'`);
    parts.push(s.template || "template:default");
    const lines = [parts.join(" \\\n  "), `limactl start --tty=false ${vm}`];
    if (s.provision) {
      const fwd = s.env.filter((n) => envSet[n]);
      lines.push(`# then the provisioning script over ssh${fwd.length ? `, with ${fwd.join(", ")} forwarded` : ""}`);
    }
    return lines.join("\n");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, template, cpus, memory, disk, mounts, envNames, envSet, provision]);

  return (
    <div className="app">
      <Header />

      <form className="form-main" onSubmit={submit} noValidate>
        <Breadcrumbs
          items={
            editing
              ? [{ label: "Sandboxes", href: "#/" }, { label: editing.name, href: `#/sandbox/${editing.name}` }, { label: "Edit" }]
              : [{ label: "Sandboxes", href: "#/" }, { label: "New sandbox" }]
          }
        />
        <div className="form-intro">
          {editing ? (
            <>
              <h1 className="page-title page-title-lg">Edit {editing.name}</h1>
              <p className="muted">
                <strong>Save and recreate</strong> deletes the VM and builds it again from these settings, provisioning included. <strong>Save</strong>{" "}
                keeps the VM: resource and mount changes need it stopped and apply on its next start, and disk can only grow.
              </p>
            </>
          ) : (
            <>
              <h1 className="page-title page-title-lg">New sandbox</h1>
              <p className="muted">A VM that Bentomo creates, starts once and provisions. Name and template are fixed after creation.</p>
            </>
          )}
        </div>

        <Section title="Basics" id="sec-basics">
          <div className="grid grid-220">
            <Field label="Adapter" htmlFor="f-adapter" hint="Where the sandbox runs. Lima is the only adapter for now.">
              <Select id="f-adapter" value="Lima" onValueChange={() => {}} groups={[{ options: ["Lima"] }]} disabled={Boolean(editing)} />
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
                    Lowercase letters, digits and dashes. The VM will be <code className="mono">{vmName(shownName)}</code>.
                  </>
                )
              }
            >
              <div className={`input-prefixed${touched && !nameOk ? " is-invalid" : ""}`}>
                <span className="mono prefix">bm-</span>
                <input
                  id="f-name"
                  className="mono"
                  type="text"
                  value={name}
                  disabled={Boolean(editing)}
                  autoFocus={!editing}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="web"
                  aria-invalid={touched && !nameOk}
                  onChange={(e) => setName(e.target.value.toLowerCase())}
                  onBlur={() => name && setTouched(true)}
                />
              </div>
            </Field>
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
        </Section>

        <Section title="Resources" id="sec-res">
          <div className="grid grid-160">
            <NumberField id="f-cpu" label="CPUs" min={1} value={cpus} onChange={setCpus} />
            <NumberField id="f-mem" label="Memory (GiB)" min={1} value={memory} onChange={setMemory} />
            <NumberField id="f-disk" label="Disk (GiB)" min={1} value={disk} onChange={setDisk} />
          </div>
        </Section>

        <Section
          title="Mounts"
          id="sec-mounts"
          description={
            <>
              Host folders shared into the VM, each at <code className="mono">/workspace/&lt;folder&gt;</code> unless you change it.{" "}
              <code className="mono">~</code> in the VM is the VM user's home.
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
                    {tilde(m.hostPath)}
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
                    onChange={(e) => setHost(m.id, e.target.value)}
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
                  placeholder={m.hostPath.trim() ? defaultGuestPath(m.hostPath.trim()) : "/workspace/…"}
                  aria-invalid={!guestOk}
                  title={guestOk ? "Where the folder appears in the VM" : "Use an absolute path or ~/…, not used by another mount"}
                  spellCheck={false}
                  onChange={(e) => patchMount(m.id, { guestPath: e.target.value, guestEdited: true })}
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
          description="Host variables forwarded on provisioning and every session. Names only: values are read from the host each time and never saved."
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
              Runs once after the first start, as the VM user, with the forwarded variables set. <code className="mono">sudo</code> is available. Stops at
              the first failing command.
              {editing && " A new script runs when you save and recreate."}
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
              inPlaceBlocked && <p className="muted form-note">{inPlaceBlocked}</p>
            )}
          </div>
          <button type="button" className="btn btn-secondary" onClick={onCancel}>
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
              Save
            </button>
          )}
          <button type="submit" className="btn btn-primary" disabled={submitting}>
            {editing ? (submitting ? "Saving…" : "Save and recreate") : submitting ? "Creating…" : "Create sandbox"}
          </button>
        </div>

        {confirmRecreate && editing && (
          <ConfirmDialog
            title={`Recreate ${editing.vm}?`}
            confirmLabel={`Save and recreate`}
            danger
            onCancel={() => setConfirmRecreate(false)}
            onConfirm={() => {
              setConfirmRecreate(false);
              void save(true);
            }}
          >
            <p>The VM and its disk are deleted, then created again from these settings and provisioned from scratch. Mounted host folders are not touched.</p>
          </ConfirmDialog>
        )}
      </form>
    </div>
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

function NumberField({ id, label, min, value, onChange }: { id: string; label: string; min: number; value: string; onChange(v: string): void }) {
  const bad = value !== "" && (!Number.isFinite(Number(value)) || Number(value) < min);
  return (
    <Field label={label} htmlFor={id} hint={bad ? `At least ${min}.` : undefined} invalid={bad}>
      <input id={id} className="input input-dark mono" type="number" min={min} value={value} aria-invalid={bad} onChange={(e) => onChange(e.target.value)} />
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
