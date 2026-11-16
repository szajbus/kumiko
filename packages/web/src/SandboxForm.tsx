import { useEffect, useId, useMemo, useState } from "react";
import {
  CLAUDE_HOME_IN_VM,
  KUMIKO_HOME_IN_VM,
  DEFAULTS,
  ENV_NAME_PATTERN,
  MINIMUMS,
  NAME_PATTERN,
  repoFolders,
  sandboxMountRole,
  sameMounts,
  vmName,
  WORKSPACE_DIR,
  workspaceDiskName,
  type CreateSandboxRequest,
  type GitHubRepo,
  type Mount,
  type MirrorView,
  WORKTREES_SUFFIX,
  type SandboxRepo,
  type SandboxView,
  type TemplatesResponse,
} from "@kumiko/shared";
import { api, errorMessage, RequestError, useDefaults } from "./api";
import { sessionsNote } from "./actions";
import { ConfirmDialog } from "./ConfirmDialog";
import { Breadcrumbs } from "./Breadcrumbs";
import { tilde } from "./format";
import { Cross, Disk, Folder, Plus, Redo, Restart, Save, Close } from "./icons";
import { guestPathProblem, type MountRow } from "./mounts";
import { AddRepoDialog } from "./ReposPage";
import { Select, type SelectGroup } from "./Select";
import { COLORS } from "./status";
import { LossList, useLossCheck } from "./Unpushed";
import { mustConfirm, stillChecking } from "./loss";

interface Props {
  /** Edit this sandbox instead of creating one. Its name and template are fixed; saving in place needs the VM stopped for resources and mounts. */
  editing?: SandboxView;
  /** The repository mirrors, which repos are picked from. */
  mirrors: MirrorView[];
  onCancel(): void;
  /** Called with the sandbox's name once it's created or the edit is saved. */
  onCreated(name: string): void;
}

interface EnvRow {
  id: number;
  name: string;
}

let nextId = 1;
const hasPicker = () => typeof window.kumiko?.pickFolder === "function";

export function SandboxForm({ editing, mirrors, onCancel, onCreated }: Props) {
  const was = editing?.meta?.spec;
  const defaults = useDefaults();
  const home = defaults?.home;
  const [name, setNameRaw] = useState(editing?.name ?? "");
  // The repos the sandbox has, which keep their folders, and the ones ticked to add.
  const kept = editing?.sandbox.repos ?? [];
  const [picked, setPicked] = useState<string[]>([]);
  /** The sandbox's repos unticked, to take out of it on save. */
  const [dropped, setDropped] = useState<string[]>([]);
  /** Saving waits on the user confirming the repos that go, and how it saves then. */
  const [confirmRemove, setConfirmRemove] = useState<{ how?: "restart" | "recreate" } | undefined>();
  const [repoFilter, setRepoFilter] = useState("");
  const [adding, setAdding] = useState<{ login?: string } | undefined>();
  const [templates, setTemplates] = useState<TemplatesResponse | undefined>();
  const [templatesError, setTemplatesError] = useState<string | undefined>();
  const [template, setTemplate] = useState(was ? was.template || "template:default" : "");
  // Lima's current values win over the stored spec, in case the VM was edited outside Kumiko.
  const [cpus, setCpus] = useState(String(editing?.cpus ?? was?.cpus ?? DEFAULTS.cpus));
  const [memory, setMemory] = useState(String(editing?.memoryGiB ?? was?.memoryGiB ?? DEFAULTS.memoryGiB));
  const [disk, setDisk] = useState(String(editing?.diskGiB ?? was?.diskGiB ?? DEFAULTS.diskGiB));
  const [workspace, setWorkspace] = useState(String(editing?.workspaceGiB ?? was?.workspaceGiB ?? DEFAULTS.workspaceGiB));
  const extraWas = useMemo(() => (was ? was.mounts.filter((m) => !sandboxMountRole(m)) : []), [was]);
  const [mounts, setMounts] = useState<MountRow[]>(() =>
    extraWas.map((m) => ({ id: nextId++, hostPath: m.hostPath, guestPath: m.guestPath && m.guestPath !== m.hostPath ? m.guestPath : "", writable: m.writable })),
  );
  const [envRows, setEnvRows] = useState<EnvRow[]>(() => (was?.env ?? []).map((n) => ({ id: nextId++, name: n })));
  const [envSet, setEnvSet] = useState<Record<string, boolean>>({});
  const [provision, setProvision] = useState(was?.provision ?? "");
  const [hostLoopback, setHostLoopback] = useState(was?.hostLoopback === true);
  const [submitting, setSubmitting] = useState(false);
  const [confirmRecreate, setConfirmRecreate] = useState(false);
  const [confirmRestart, setConfirmRestart] = useState(false);
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
  const shownName = name || "<name>";
  const setName = (v: string) => setNameRaw(v.toLowerCase());

  const isKept = (repo: string) => kept.some((k) => k.repo.toLowerCase() === repo.toLowerCase());
  // In the mirrors' order, so the folders shown don't move about as repos are ticked.
  const adds = mirrors.map((m) => m.repo).filter((r) => picked.includes(r) && !isKept(r));
  const folders = useMemo(() => new Map(repoFolders(adds, kept).map((r) => [r.repo, r.folder])), [adds.join(), kept]);
  const toggleRepo = (repo: string, on: boolean) => {
    if (isKept(repo)) return setDropped((all) => (on ? all.filter((r) => r !== repo) : [...all, repo]));
    setPicked((all) => (on ? [...all.filter((r) => r !== repo), repo] : all.filter((r) => r !== repo)));
  };
  const isDropped = (repo: string) => dropped.some((d) => d.toLowerCase() === repo.toLowerCase());
  const shownMirrors = mirrors.filter((m) => m.repo.toLowerCase().includes(repoFilter.trim().toLowerCase()));
  const openAdd = () => {
    setAdding({});
    // The dialog lists the account's own repos first, once it knows whose.
    api.githubAccount().then((a) => a.status === "signed-in" && setAdding((cur) => cur && { login: a.login }), () => {});
  };
  const addMirror = (r: GitHubRepo) => {
    api.addMirror(r.repo, r.private).then(
      () => toggleRepo(r.repo, true),
      (err) => setErrors([errorMessage(err)]),
    );
  };

  const addFolder = async () => {
    if (hasPicker()) {
      const path = await window.kumiko!.pickFolder();
      if (path) setMounts((all) => [...all, { id: nextId++, hostPath: path, guestPath: "", writable: false }]);
    } else {
      setMounts((all) => [...all, { id: nextId++, hostPath: "", guestPath: "", writable: false }]);
    }
  };
  const changeFolder = async (id: number) => {
    const path = await window.kumiko!.pickFolder();
    if (path) patchMount(id, { hostPath: path });
  };
  const patchMount = (id: number, patch: Partial<MountRow>) => setMounts((all) => all.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  const extraMounts = (): Mount[] =>
    mounts
      .filter((m) => m.hostPath.trim())
      .map((m) => ({ hostPath: m.hostPath.trim(), writable: m.writable, guestPath: m.guestPath.trim() || m.hostPath.trim() }));

  const request = (): CreateSandboxRequest => ({
    name: name.trim(),
    repos: [...kept.map((k) => k.repo).filter((r) => !isDropped(r)), ...adds],
    template: template || undefined,
    cpus: Number(cpus),
    memoryGiB: Number(memory),
    diskGiB: Number(disk),
    workspaceGiB: Number(workspace),
    mounts: extraMounts(),
    env: envNames,
    provision: provision.trim() ? provision : undefined,
    hostLoopback: hostLoopback || undefined,
  });

  const diskNow = Math.ceil(editing?.diskGiB ?? was?.diskGiB ?? 0);
  const workspaceNow = Math.ceil(editing?.workspaceGiB ?? was?.workspaceGiB ?? 0);
  /** Resources and mounts go through `limactl edit`, which needs the VM stopped: a running one is restarted to save them. */
  const vmChanged = (() => {
    if (!editing) return false;
    const s = request();
    return (
      s.cpus !== (editing.cpus ?? was?.cpus) ||
      s.memoryGiB !== (editing.memoryGiB ?? was?.memoryGiB) ||
      s.diskGiB !== diskNow ||
      s.workspaceGiB !== workspaceNow ||
      !sameMounts(s.mounts, extraWas) ||
      hostLoopback !== (was?.hostLoopback === true)
    );
  })();
  const needsRestart = vmChanged && editing?.status === "running";

  /** Why saving in place won't work, if it won't. `limactl edit` can't shrink the disk; recreating has no such limit. */
  const inPlaceBlocked = (() => {
    if (!editing) return undefined;
    if (editing.status === "absent") return `${editing.vm} doesn't exist, so it can only be created again.`;
    if (Number(disk) < diskNow) return `The system disk can only shrink by rebuilding; it is ${diskNow} GiB now.`;
    if (Number(workspace) < workspaceNow) return `The workspace disk can only grow; it is ${workspaceNow} GiB now.`;
    if (vmChanged && !needsRestart && editing.status !== "stopped") return `Stop ${editing.vm} to save resource or mount changes without rebuilding it.`;
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

  /** Saves, once the user has confirmed the repos it takes out of the sandbox, if any. */
  const save = (how?: "restart" | "recreate") => {
    if (editing && dropped.length) setConfirmRemove({ how });
    else void send(how);
  };

  const send = async (how?: "restart" | "recreate") => {
    setSubmitting(true);
    setErrors([]);
    try {
      if (editing) {
        const { repos, cpus, memoryGiB, diskGiB, workspaceGiB, mounts, env, provision } = request();
        await api.edit(editing.name, { repos, cpus, memoryGiB, diskGiB, workspaceGiB, mounts, env, provision: provision ?? "", hostLoopback }, how);
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
    const disk = workspaceDiskName(s.name || "<name>");
    const fixed = [
      `#   the workspace disk ${disk}  at ${WORKSPACE_DIR}, kept when the sandbox is rebuilt`,
      `#   the sandbox's Claude home  at ${CLAUDE_HOME_IN_VM}, writable (CLAUDE_CONFIG_DIR)`,
      `#   the sandbox's Kumiko folder  at ${KUMIKO_HOME_IN_VM}, writable`,
      ...s.mounts.map((m) => `#   ${m.hostPath}  at ${m.guestPath === m.hostPath ? "the same path" : m.guestPath}${m.writable ? ", writable" : ""}`),
    ];
    const lines = [
      `limactl disk create ${disk} --size=${s.workspaceGiB}GiB --format=raw`,
      "# mounts:",
      ...fixed,
      `limactl create --tty=false --name=${vm} --cpus=${s.cpus} --memory=${s.memoryGiB} --disk=${s.diskGiB} --set '.mounts = […] | .additionalDisks = […]' ${s.template || "template:default"}`,
      ...(s.hostLoopback ? [] : [`limactl edit --tty=false ${vm} --set '.networkOpts.hostLoopback = false'   # with Lima 2.3 or later, on vz`]),
      `limactl start --tty=false ${vm}`,
      "# then Claude Code's installer over ssh, linked to /usr/local/bin/claude",
    ];
    if (s.provision) {
      const fwd = s.env.filter((n) => envSet[n]);
      lines.push(`# then the provisioning script in ${WORKSPACE_DIR}${fwd.length ? `, with ${fwd.join(", ")} forwarded` : ""}`);
    }
    for (const r of repoFolders(s.repos)) lines.push(`# then in the sandbox: git clone git@github.com:${r.repo}.git ${WORKSPACE_DIR}/${r.folder}   # from the mirror`);
    return lines.join("\n");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, picked, template, cpus, memory, disk, workspace, mounts, envNames, envSet, provision, hostLoopback]);

  return (
    <>
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
            </>
          ) : (
            <>
              <h1 className="page-title page-title-lg">New sandbox</h1>
              <p className="muted">
                A VM of its own for Claude. The repos you pick are cloned from your mirrors onto the sandbox's own disk, at{" "}
                <code className="mono">{WORKSPACE_DIR}</code>, where every session starts.
              </p>
            </>
          )}
        </div>

        {/* The field's own label names it; a heading would say it twice. */}
        <section className="card section" aria-label="Name">
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
              autoFocus={!editing}
              onChange={(e) => setName(e.target.value)}
              onBlur={() => name && setTouched(true)}
            />
          </Field>
        </section>

        <Section
          title="Repos"
          id="sec-repos"
          description={
            <>
              From your mirrors. Each is cloned into <code className="mono">{WORKSPACE_DIR}</code>, its worktrees beside it.
              {editing && " A repo added now is cloned when you save, or on the sandbox's next start; one unticked is deleted from it."}
            </>
          }
        >
          <div className="repo-picker">
            {mirrors.length > 6 && (
              <input
                className="input input-dark repo-picker-filter"
                type="search"
                placeholder="Filter mirrors"
                aria-label="Filter mirrors"
                value={repoFilter}
                onChange={(e) => setRepoFilter(e.target.value)}
              />
            )}
            {mirrors.length === 0 ? (
              <p className="muted">No mirrors yet. Mirror a repository from GitHub to pick it here.</p>
            ) : (
              <ul className="repo-picker-list" aria-label="Mirrors">
                {shownMirrors.map((m) => {
                  const has = kept.find((k) => k.repo.toLowerCase() === m.repo.toLowerCase());
                  const on = has ? !isDropped(m.repo) : picked.includes(m.repo);
                  const folder = has?.folder ?? folders.get(m.repo);
                  const slash = m.repo.indexOf("/");
                  return (
                    <li key={m.repo} className={`repo-picker-item${on ? " is-on" : ""}`}>
                      <label className="check repo-picker-check">
                        <input
                          type="checkbox"
                          checked={on}
                          title={has && !on ? `Taken out of the sandbox on save: ${WORKSPACE_DIR}/${has.folder} and its worktrees are deleted.` : undefined}
                          onChange={(e) => toggleRepo(m.repo, e.target.checked)}
                        />
                        <span className="repo-picker-name">
                          <span className="dim">{m.repo.slice(0, slash + 1)}</span>
                          {m.repo.slice(slash + 1)}
                        </span>
                        {m.private && <span className="badge">private</span>}
                      </label>
                      {on && folder && (
                        <span className="mono dim repo-picker-to">
                          → {WORKSPACE_DIR}/{folder}
                        </span>
                      )}
                    </li>
                  );
                })}
                {shownMirrors.length === 0 && <li className="repo-picker-item muted">No mirror matches.</li>}
              </ul>
            )}
            <button type="button" className="btn-add" onClick={openAdd}>
              <Plus size={14} color="#8FA6F0" />
              Mirror another repository from GitHub…
            </button>
          </div>
          <p className="muted form-note">
            Repos picked together that share a name each get their owner in front. A folder, once given, never changes.
          </p>
        </Section>

        <div className="form-group-head">
          <h2>Sandbox</h2>
          <p className="muted">
            The Lima instance Claude runs in, <code className="mono">{vmName(shownName)}</code>.
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
            <NumberField id="f-workspace" label="Workspace disk (GiB)" min={MINIMUMS.workspaceGiB} whole value={workspace} onChange={setWorkspace} hint={`Persistent, at ${WORKSPACE_DIR}. Can only grow.`} />
            <NumberField id="f-disk" label="System disk (GiB)" min={MINIMUMS.diskGiB} value={disk} onChange={setDisk} hint="Rebuilt with the VM." />
          </div>
        </Section>

        <Section title="Default mounts" id="sec-default-mounts" description="Every sandbox has these; they can't be changed.">
          <div className="fieldset-stack">
            <div className="detail-mount mount-grid">
              <span className="mount-icon">
                <Disk />
              </span>
              <span className="mono path">
                Workspace disk <span className="dim">{workspaceDiskName(shownName)}</span>
              </span>
              <span className="row-sub">
                <span className="badge">Persistent</span>
              </span>
              <span className="mount-at">at</span>
              <span className="mono path">
                {WORKSPACE_DIR} <span className="dim">· repos and their worktrees, kept when the sandbox is rebuilt</span>
              </span>
            </div>
            {[
              {
                host: defaults ? `${tilde(defaults.claudeHomes, home)}/${name.trim() || "<name>"}` : "The sandbox's Claude home",
                at: CLAUDE_HOME_IN_VM,
                what: "Claude home: login, settings, history",
              },
              {
                host: defaults ? `${tilde(defaults.kumikoHomes, home)}/${name.trim() || "<name>"}` : "The sandbox's Kumiko folder",
                at: KUMIKO_HOME_IN_VM,
                what: "Kumiko folder: the agent's setup scripts, artifacts",
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
              Other folders from this Mac, at the same path in the sandbox unless you set another. <code className="mono">~</code> is the sandbox user's
              home. Just folders: Kumiko doesn't treat them as repos. None can be in <code className="mono">{WORKSPACE_DIR}</code>.
            </>
          }
        >
          <div className="fieldset-stack">
            {mounts.map((m) => {
              const guestProblem = guestPathProblem(m, mounts);
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
                    aria-invalid={Boolean(guestProblem)}
                    aria-describedby={guestProblem ? `guest-${m.id}-problem` : undefined}
                    title="Where the folder appears in the sandbox"
                    spellCheck={false}
                    onChange={(e) => patchMount(m.id, { guestPath: e.target.value })}
                  />
                  {guestProblem && (
                    <span id={`guest-${m.id}-problem`} className="hint is-invalid mount-problem">
                      {guestProblem}
                    </span>
                  )}
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
          title="This Mac's localhost"
          id="sec-loopback"
          description={
            <>
              A sandbox can reach what listens on your Mac's <code className="mono">127.0.0.1</code> (databases, dev servers, other apps' local
              APIs) unless Lima blocks it. Kumiko has it blocked, which takes Lima 2.3 or later.
              {editing && " A change applies when the sandbox next starts."}
            </>
          }
        >
          <label className="check">
            <input type="checkbox" checked={hostLoopback} onChange={(e) => setHostLoopback(e.target.checked)} />
            Let Claude reach services on this Mac's localhost
          </label>
        </Section>

        <Section
          title={<label htmlFor="f-prov">Provisioning</label>}
          id="sec-prov"
          description={
            <>
              Kumiko first installs Claude Code, on <code className="mono">PATH</code> as <code className="mono">claude</code>. Then your script runs
              once, as the sandbox user, in <code className="mono">{WORKSPACE_DIR}</code>, with the forwarded variables set. <code className="mono">sudo</code> is available. Stops at the first
              failing command. Claude gets a copy, so its own setup scripts don't repeat it: use forwarded variables for secrets.
              {editing && " A new script runs when you save and rebuild the sandbox."}
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
                    <strong>Save</strong> keeps the VM: resource and mount changes apply on its next start, so a running sandbox is restarted for
                    them, and disks can only grow. <strong>Save and rebuild sandbox</strong> deletes the VM and builds it again from these settings,
                    provisioning included; {WORKSPACE_DIR}, Claude's login and history stay.
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
                if (!needsRestart) void save();
                else if (editing.sessions > 0) setConfirmRestart(true);
                else void save("restart");
              }}
            >
              {needsRestart ? <Restart /> : <Save />}
              {needsRestart ? "Save and restart sandbox" : "Save"}
            </button>
          )}
          <button type="submit" className="btn btn-primary" disabled={submitting}>
            {editing ? <Redo /> : <Plus />}
            {editing ? (submitting ? "Saving…" : "Save and rebuild sandbox") : submitting ? "Creating…" : "Create sandbox"}
          </button>
        </div>

        {confirmRecreate && editing && (
          <ConfirmDialog
            title={`Rebuild ${editing.vm}?`}
            confirmLabel="Save and rebuild sandbox"
            onCancel={() => setConfirmRecreate(false)}
            onConfirm={() => {
              setConfirmRecreate(false);
              void save("recreate");
            }}
          >
            <p>The VM is deleted, then created again from these settings and provisioned from scratch.</p>
            <p>
              <span className="mono">{WORKSPACE_DIR}</span> stays as it is: clones, worktrees, stashes, uncommitted work,{" "}
              <span className="mono">node_modules</span>. So do Claude's home and the Kumiko folder.
            </p>
            {sessionsNote(editing)}
          </ConfirmDialog>
        )}
        {confirmRemove && editing && (
          <RemoveReposDialog
            sandbox={editing}
            repos={kept.filter((k) => isDropped(k.repo))}
            onCancel={() => setConfirmRemove(undefined)}
            onConfirm={() => {
              const { how } = confirmRemove;
              setConfirmRemove(undefined);
              void send(how);
            }}
          />
        )}
        {confirmRestart && editing && (
          <ConfirmDialog
            title={`Restart ${editing.vm}?`}
            confirmLabel="Save and restart sandbox"
            onCancel={() => setConfirmRestart(false)}
            onConfirm={() => {
              setConfirmRestart(false);
              void save("restart");
            }}
          >
            <p>The sandbox shuts down, takes the new resources and mounts, and starts again with its disks as they were.</p>
            {sessionsNote(editing)}
          </ConfirmDialog>
        )}
      </form>
      {adding && <AddRepoDialog login={adding.login} added={mirrors} onAdd={addMirror} onClose={() => setAdding(undefined)} />}
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
function NumberField({ id, label, min, whole, value, hint, onChange }: { id: string; label: string; min: number; whole?: boolean; value: string; hint?: string; onChange(v: string): void }) {
  const n = Number(value);
  const bad = value !== "" && (!Number.isFinite(n) || n < min || (whole && !Number.isInteger(n)));
  return (
    <Field label={label} htmlFor={id} hint={bad ? `${whole ? "A whole number, at" : "At"} least ${min}.` : hint} invalid={bad}>
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

/**
 * Confirms taking repos out of a sandbox, whose folders are deleted from /workspace: with what isn't pushed in them,
 * while the VM runs; a stopped one has its folders deleted when it next starts, and nothing can be looked at before.
 */
function RemoveReposDialog({ sandbox, repos, onCancel, onConfirm }: { sandbox: SandboxView; repos: SandboxRepo[]; onCancel(): void; onConfirm(): void }) {
  const title = repos.length === 1 ? `Remove ${repos[0].repo} from ${sandbox.name}?` : `Remove ${repos.length} repos from ${sandbox.name}?`;
  const folders = repos.flatMap((r) => [`${WORKSPACE_DIR}/${r.folder}`, `${WORKSPACE_DIR}/${r.folder}${WORKTREES_SUFFIX}`]);
  const what = (
    <p>
      {repos.length === 1 ? "Its mirror stops" : "Their mirrors stop"} being served to this sandbox, and Kumiko deletes{" "}
      {folders.map((f, i) => (
        <span key={f}>
          {i > 0 && (i === folders.length - 1 ? " and " : ", ")}
          <code className="mono">{f}</code>
        </span>
      ))}
      {sandbox.status === "running" ? "." : " when the sandbox next starts."}
    </p>
  );
  if (sandbox.status !== "running") {
    return (
      <ConfirmDialog title={title} confirmLabel="Remove" danger onCancel={onCancel} onConfirm={onConfirm}>
        {what}
        <p className="dialog-note">Branches on GitHub stay. Adding a repo again clones it again.</p>
      </ConfirmDialog>
    );
  }
  return <RemoveReposChecked title={title} sandbox={sandbox} repos={repos} what={what} onCancel={onCancel} onConfirm={onConfirm} />;
}

function RemoveReposChecked(props: { title: string; sandbox: SandboxView; repos: SandboxRepo[]; what: React.ReactNode; onCancel(): void; onConfirm(): void }) {
  const { check, startAndCheck } = useLossCheck(props.sandbox.name, props.repos.map((r) => r.repo));
  const clean = check.kind === "done" && !mustConfirm(check);
  return (
    <ConfirmDialog
      title={props.title}
      confirmLabel={clean ? "Remove" : "Remove and delete the folders"}
      danger
      confirmDisabled={stillChecking(check)}
      onCancel={props.onCancel}
      onConfirm={props.onConfirm}
    >
      {props.what}
      <LossList check={check} onStart={startAndCheck} />
      <p className="dialog-note">Branches on GitHub stay. Adding a repo again clones it again.</p>
    </ConfirmDialog>
  );
}
