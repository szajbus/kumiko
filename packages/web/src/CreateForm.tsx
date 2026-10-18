import { useEffect, useId, useMemo, useState } from "react";
import { DEFAULTS, ENV_NAME_PATTERN, NAME_PATTERN, vmName, type SandboxSpec, type TemplatesResponse } from "@bentomo/shared";
import { api, RequestError } from "./api";
import { Header } from "./Header";
import { Cross, Folder, Plus } from "./icons";
import { Select, type SelectGroup } from "./Select";
import { COLORS } from "./status";

interface Props {
  onCancel(): void;
  onCreated(name: string): void;
}

interface MountRow {
  id: number;
  hostPath: string;
  writable: boolean;
}

interface EnvRow {
  id: number;
  name: string;
}

let nextId = 1;
const hasPicker = () => typeof window.bentomo?.pickFolder === "function";

export function CreateForm({ onCancel, onCreated }: Props) {
  const [name, setName] = useState("");
  const [templates, setTemplates] = useState<TemplatesResponse | undefined>();
  const [templatesError, setTemplatesError] = useState<string | undefined>();
  const [template, setTemplate] = useState("");
  const [cpus, setCpus] = useState(String(DEFAULTS.cpus));
  const [memory, setMemory] = useState(String(DEFAULTS.memoryGiB));
  const [disk, setDisk] = useState(String(DEFAULTS.diskGiB));
  const [mounts, setMounts] = useState<MountRow[]>([]);
  const [envRows, setEnvRows] = useState<EnvRow[]>([]);
  const [envSet, setEnvSet] = useState<Record<string, boolean>>({});
  const [provision, setProvision] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [touched, setTouched] = useState(false);

  useEffect(() => {
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

  const addFolder = async () => {
    if (hasPicker()) {
      const path = await window.bentomo!.pickFolder();
      if (path) setMounts((m) => [...m, { id: nextId++, hostPath: path, writable: false }]);
    } else {
      setMounts((m) => [...m, { id: nextId++, hostPath: "", writable: false }]);
    }
  };
  const changeFolder = async (id: number) => {
    const path = await window.bentomo!.pickFolder();
    if (path) setMounts((m) => m.map((r) => (r.id === id ? { ...r, hostPath: path } : r)));
  };

  const spec = (): SandboxSpec => ({
    name: name.trim(),
    template: template || undefined,
    cpus: Number(cpus),
    memoryGiB: Number(memory),
    diskGiB: Number(disk),
    mounts: mounts.filter((m) => m.hostPath.trim()).map(({ hostPath, writable }) => ({ hostPath: hostPath.trim(), writable })),
    env: envNames,
    provision: provision.trim() ? provision : undefined,
  });

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (!nameOk) {
      setErrors([]);
      document.getElementById("f-name")?.focus();
      return;
    }
    setSubmitting(true);
    setErrors([]);
    try {
      const res = await api.create(spec());
      onCreated(res.name);
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
    if (s.mounts.length === 0) parts.push("--mount-none");
    for (const m of s.mounts) parts.push(`--mount-only=${m.hostPath}${m.writable ? ":w" : ""}`);
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
      <Header>
        <a
          href="#/"
          className="link-back"
          onClick={(e) => {
            e.preventDefault();
            onCancel();
          }}
        >
          ← Back to sandboxes
        </a>
      </Header>

      <form className="form-main" onSubmit={submit} noValidate>
        <div className="form-intro">
          <h1 className="page-title page-title-lg">New sandbox</h1>
          <p className="muted">A VM that Bentomo creates, starts once and provisions. Settings are fixed after creation: delete and recreate to change them.</p>
        </div>

        <Section title="Basics" id="sec-basics">
          <div className="grid grid-220">
            <Field label="Adapter" htmlFor="f-adapter" hint="Where the sandbox runs. Lima is the only adapter for now.">
              <Select id="f-adapter" value="Lima" onValueChange={() => {}} groups={[{ options: ["Lima"] }]} />
            </Field>
            <Field
              label="Name"
              htmlFor="f-name"
              invalid={touched && !nameOk}
              hint={
                <>
                  Lowercase letters, digits and dashes. The VM will be <code className="mono">{vmName(shownName)}</code>.
                </>
              }
            >
              <div className={`input-prefixed${touched && !nameOk ? " is-invalid" : ""}`}>
                <span className="mono prefix">bm-</span>
                <input
                  id="f-name"
                  className="mono"
                  type="text"
                  value={name}
                  autoFocus
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
                templatesError ? (
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
                groups={templateGroups(templates, templatesError)}
                placeholder="Loading…"
                disabled={!templates && !templatesError}
              />
            </Field>
          </div>
        </Section>

        <Section title="Resources" id="sec-res">
          <div className="grid grid-160">
            <NumberField id="f-cpu" label="CPUs" min={1} value={cpus} onChange={setCpus} />
            <NumberField id="f-mem" label="Memory (GiB)" min={1} value={memory} onChange={setMemory} />
            <NumberField id="f-disk" label="Disk (GiB)" min={10} value={disk} onChange={setDisk} />
          </div>
        </Section>

        <Section title="Mounts" id="sec-mounts" description="Host folders shared into the VM at the same path. None by default.">
          {mounts.map((m) => (
            <div key={m.id} className="list-row">
              <Folder />
              {hasPicker() ? (
                <span className="mono path">{m.hostPath}</span>
              ) : (
                <input
                  className="input input-compact mono path"
                  type="text"
                  value={m.hostPath}
                  placeholder="/absolute/path/on/host"
                  aria-label="Host folder"
                  autoFocus={!m.hostPath}
                  spellCheck={false}
                  onChange={(e) => setMounts((all) => all.map((r) => (r.id === m.id ? { ...r, hostPath: e.target.value } : r)))}
                />
              )}
              <label className="check">
                <input
                  type="checkbox"
                  checked={m.writable}
                  onChange={(e) => setMounts((all) => all.map((r) => (r.id === m.id ? { ...r, writable: e.target.checked } : r)))}
                />
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
          ))}
          <button type="button" className="btn-add" onClick={addFolder}>
            <Plus size={14} color="#8FA6F0" />
            {hasPicker() ? "Add folder…" : "Add folder"}
          </button>
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

        <details className="card details">
          <summary>Command preview</summary>
          <pre className="mono preview">{preview}</pre>
        </details>

        {/* Errors sit beside the buttons, growing downward, so the buttons never move. */}
        <div className="form-actions">
          <div className="form-errors" role="alert">
            {errors.length > 0 && (
              <div className="banner banner-error">
                <ul>
                  {errors.map((e) => (
                    <li key={e}>{e}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
          <button type="button" className="btn btn-secondary" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={submitting}>
            {submitting ? "Creating…" : "Create sandbox"}
          </button>
        </div>
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
