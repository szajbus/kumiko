import { createContext, useContext, useState, type KeyboardEvent, type ReactNode } from "react";
import { FOOTERS, type ApprovalCard as Card, type CardDecision, type DeliverCard, type DeliverMethod, type DeliverRoute } from "@kumiko/shared";
import { approveLabel, barShares, isApproveKey, cardClosed, cardTitle, commitsLabel, effectLine, filesLabel } from "./cards";
import type { ChatItem } from "./chat";
import { Markdown } from "./Markdown";

type AskItem = Extract<ChatItem, { type: "ask" }>;

/** What a card can ask the server to do; resolves to whether it went through. Missing where nobody can decide. */
export type CardAction = { action: "approve"; decision: CardDecision } | { action: "decline"; reason?: string } | { action: "refresh" };
export const CardContext = createContext<((askId: string, action: CardAction) => Promise<boolean>) | undefined>(undefined);

const short = (sha: string) => sha.slice(0, 7);
/** The keys that approve, as this platform writes them. */
const APPROVE_KEYS = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘↩" : "Ctrl+Enter";
const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/**
 * The card for one of Kumiko's tools that waits for the user's approval: Kumiko's facts, Claude's note, the choices,
 * and a button that names what happens. Once decided it shrinks to a one-line receipt.
 */
export function ApprovalCardView({ item }: { item: AskItem }) {
  const decide = useContext(CardContext);
  const card = item.card;
  const closed = cardClosed(card, item.answer, item.closed);
  if (!card) {
    if (item.answer?.kind === "deny") return <div className="chat-quiet">No card: {item.answer.message}</div>;
    if (closed || item.answer) return null;
    return <div className="chat-quiet">Kumiko is checking what Claude asked for…</div>;
  }
  if (card.state === "done" || card.state === "failed") return <Receipt card={card} />;
  if (card.state === "declined") return <Receipt card={card} />;
  if (closed) return <Receipt card={card} note={closed} />;
  if (card.state === "approved" || card.state === "working") {
    return (
      <div className="ac-receipt">
        <span className="ac-r-icon">…</span>
        {card.state === "approved" ? (card.card.kind === "push" ? "Allowed; pushing to GitHub" : "Approved; waiting for Claude to go ahead") : `Working on it: ${lowerFirst(cardTitle(card.card, card.decision?.kind === "deliver" ? card.decision.route : undefined))}`}
      </div>
    );
  }
  // A card worked out again (a stale one reviewed) starts over: its choices and text were for the old state.
  return <OpenCard key={card.card.kind === "deliver" ? `${card.id}:${card.card.head}:${card.card.pr?.number ?? ""}` : card.id} card={card} decide={decide} />;
}

function Receipt({ card, note }: { card: Card; note?: string }) {
  const ok = card.state === "done" && card.receipt?.ok !== false;
  const text = note
    ? `${cardTitle(card.card)}: ${note}`
    : card.state === "declined"
      ? `Declined: ${lowerFirst(cardTitle(card.card))}${card.card.kind === "deliver" ? ` ${card.card.branch}` : ""}`
      : (card.receipt?.text ?? cardTitle(card.card));
  const meta = card.state === "declined" ? (card.reason ? `“${card.reason}”` : undefined) : card.receipt?.meta;
  return (
    <div className={`ac-receipt ${ok ? "is-ok" : note ? "" : "is-no"}`}>
      <span className="ac-r-icon">{ok ? "✓" : note ? "–" : "✕"}</span>
      <span>{text}</span>
      {meta && <span className="ac-r-meta">{meta}</span>}
      {card.receipt?.url && (
        <a href={card.receipt.url} target="_blank" rel="noreferrer">
          {card.receipt.link ?? "Open"}
        </a>
      )}
    </div>
  );
}

function OpenCard({ card, decide }: { card: Card; decide?: (askId: string, action: CardAction) => Promise<boolean> }) {
  const c = card.card;
  const [route, setRoute] = useState<DeliverRoute>(c.kind === "deliver" ? c.route : "main");
  const [method, setMethod] = useState<DeliverMethod>(c.kind === "deliver" ? c.method : "merge");
  const [title, setTitle] = useState(c.kind === "deliver" || c.kind === "issue" ? c.title : "");
  const [body, setBody] = useState(c.kind === "comment" || c.kind === "deliver" || c.kind === "issue" ? c.body : "");
  const [message, setMessage] = useState(c.kind === "deliver" ? c.squashBody : "");
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<"commits" | "files">();
  const [labels, setLabels] = useState<string[]>(c.kind === "issue" ? c.labels : []);

  const send = async (action: CardAction) => {
    if (!decide || busy) return;
    setBusy(true);
    await decide(card.id, action);
    setBusy(false);
  };
  const decision = (): CardDecision | undefined => {
    if (c.kind === "deliver") {
      if (route === "pr") return title.trim() ? { kind: "deliver", route, method, title: title.trim(), body } : undefined;
      if (method === "squash") return title.trim() ? { kind: "deliver", route, method, title: title.trim(), message } : undefined;
      return { kind: "deliver", route, method };
    }
    if (c.kind === "issue") return title.trim() ? { kind: "issue", title: title.trim(), body, labels } : undefined;
    if (c.kind === "push") return { kind: "push" };
    return body.trim() ? { kind: "comment", body } : undefined;
  };
  const approve = () => {
    const d = decision();
    if (d && card.state === "open") void send({ action: "approve", decision: d });
  };
  // Plain Enter does nothing: approving is ⌘↩ or a click, so it can't happen by accident while typing.
  const onKey = (e: KeyboardEvent) => {
    if (isApproveKey(e) && !declining) {
      e.preventDefault();
      approve();
    }
  };

  const footBar = (sig: string) => (
      <div className="ac-foot-bar">
        <span className="ac-sig">{sig}</span>
        <span className="chat-proposal-buttons">
          {declining ? (
            <>
              <button type="button" className="btn btn-secondary btn-compact" disabled={busy} onClick={() => setDeclining(false)}>
                Back
              </button>
              <button type="button" className="btn btn-secondary btn-compact" disabled={busy || !decide} onClick={() => void send({ action: "decline", ...(reason.trim() ? { reason: reason.trim() } : {}) })}>
                Decline and tell Claude
              </button>
            </>
          ) : (
            <>
              <button type="button" className="btn btn-secondary btn-compact" disabled={busy || !decide} onClick={() => setDeclining(true)}>
                Decline…
              </button>
              {card.state === "stale" ? (
                <button key="refresh" type="button" className="btn btn-primary btn-compact" disabled={busy || !decide} onClick={() => void send({ action: "refresh" })}>
                  Review the new state
                </button>
              ) : (
                <button key="approve" type="button" className="btn btn-primary btn-compact" disabled={busy || !decide || !decision()} onClick={approve}>
                  {approveLabel(c, route, method)} <span className="ac-kbd">{APPROVE_KEYS}</span>
                </button>
              )}
            </>
          )}
        </span>
      </div>
  );

  if (c.kind === "push") {
    return (
      <div className="ac-card is-pending" role="group" aria-label={cardTitle(c)} onKeyDown={onKey}>
        <div className="ac-head">
          <div className="ac-title">
            Push <code className="ac-ref">{c.branch}</code>, which changes CI
          </div>
          <div className="ac-sub">Claude's branch · {c.repo} · its git push waits for you</div>
        </div>
        <div className="ac-facts">
          <span>
            {c.old ? <code>{short(c.old)}</code> : "new branch"} → <code>{short(c.new)}</code>
          </span>
          <span>{c.old ? (c.fastForward ? "fast-forward" : "force-push") : `from ${c.base}`}</span>
          <span>
            {c.commits} commit{c.commits === 1 ? "" : "s"}
          </span>
          <span className="ac-by">✓ checked by Kumiko</span>
        </div>
        <div className="ac-flags">
          {(c.files.length ? c.files : [{ path: ".github/", added: undefined, deleted: undefined }]).map((f) => (
            <div key={f.path} className="ac-flag">
              <span className="ac-warn">⚠</span>
              <div>
                Changes <code>{f.path}</code> compared with {c.base}
                {f.added !== undefined && (
                  <>
                    {" "}
                    <span className="ac-add">+{f.added}</span> <span className="ac-del">−{f.deleted}</span>
                  </>
                )}
              </div>
            </div>
          ))}
          <div className="ac-flag">
            <span />
            <div className="ac-why">GitHub runs a branch's own workflows when it's pushed, with the repository's secrets. Once you allow it, later pushes with the same .github/ go through by themselves.</div>
          </div>
        </div>
        {declining && (
          <div className="ac-decline">
            <textarea className="ac-ta ac-fld" autoFocus placeholder="Why not, for Claude (optional)" aria-label="Reason for declining, for Claude" value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
        )}
        {footBar("Pushes with your gh login")}
      </div>
    );
  }

  if (c.kind === "issue" || c.kind === "comment") {
    const footer = c.kind === "issue" ? FOOTERS.issue : FOOTERS.comment;
    return (
      <div className="ac-card is-pending" role="group" aria-label={cardTitle(c)} onKeyDown={onKey}>
        <div className="ac-head">
          <div className="ac-title">{cardTitle(c)}</div>
          <div className="ac-sub">
            {c.kind === "comment" ? (
              <>
                <a href={c.target.url} target="_blank" rel="noreferrer">
                  “{c.target.title}”
                </a>{" "}
                · {c.target.state} · by {c.target.author} · {c.repo}
              </>
            ) : (
              <>
                {c.repo} · asked {new Date(card.at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
              </>
            )}
          </div>
        </div>
        {card.note && (
          <div className="ac-note">
            <div className="ac-who">Claude's note</div>
            <div>{card.note}</div>
          </div>
        )}
        <Fields hint={c.kind === "issue" ? "Written by Claude, shown as GitHub will show it. Everything above is editable. Labels come from the repository's own." : "Exactly as it will appear, under your name. Editable."}>
          {c.kind === "issue" && <input className="ac-fld" value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Issue title" />}
          <BodyField value={body} onChange={setBody} footer={footer} label={c.kind === "issue" ? "Issue description" : "Comment"} />
          {c.kind === "issue" && <Labels all={c.repoLabels} picked={labels} onChange={setLabels} />}
        </Fields>
        {declining && (
          <div className="ac-decline">
            <textarea className="ac-ta ac-fld" autoFocus placeholder="Why not, for Claude (optional)" aria-label="Reason for declining, for Claude" value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
        )}
        {footBar("Opens as you (gh on the Mac)".replace("Opens", c.kind === "comment" ? "Posts" : "Opens"))}
      </div>
    );
  }

  const pr = route === "pr";
  return (
    <div className="ac-card is-pending" role="group" aria-label={cardTitle(c, route)} onKeyDown={onKey}>
      <div className="ac-head">
        <div className="ac-title">
          {cardTitle(c, route)} <code className="ac-ref">{c.branch}</code> <span className="ac-arrow">→</span> <code className="ac-ref">{c.base}</code>
          {c.pr && <span className="badge">PR #{c.pr.number}</span>}
          {card.state === "stale" && <span className="badge badge-warn">out of date</span>}
        </div>
        <div className="ac-sub">
          {c.pr ? `${c.pr.title} · ` : ""}
          {c.repo} · asked {new Date(card.at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
        </div>
      </div>
      {card.note && (
        <div className="ac-note">
          <div className="ac-who">Claude's note</div>
          <div>{card.note}</div>
        </div>
      )}
      <div className="ac-facts">
        <span>
          <span className="ac-k">head</span> <code>{short(c.head)}</code>
        </span>
        <button type="button" aria-expanded={open === "commits"} className={`ac-tog${open === "commits" ? " is-on" : ""}`} onClick={() => setOpen(open === "commits" ? undefined : "commits")}>
          {commitsLabel(c)} ▾
        </button>
        <span>
          <button type="button" aria-expanded={open === "files"} className={`ac-tog${open === "files" ? " is-on" : ""}`} onClick={() => setOpen(open === "files" ? undefined : "files")}>
            {filesLabel(c)} ▾
          </button>{" "}
          <span className="ac-add">+{c.added}</span> <span className="ac-del">−{c.deleted}</span>
        </span>
        <span>
          <span className="ac-dot" /> merges cleanly
        </span>
        <span className="ac-by">✓ checked by Kumiko</span>
      </div>
      {open === "commits" && (
        <div className="ac-panel">
          {c.commits.map((x) => (
            <div key={x.sha} className="ac-row">
              <code className="ac-sha">{short(x.sha)}</code>
              <span>{x.subject}</span>
              {x.claude ? <span className="ac-co">+ Claude</span> : <span />}
            </div>
          ))}
        </div>
      )}
      {open === "files" && (
        <div className="ac-panel">
          {c.files.map((f) => {
            const bar = barShares(f.added, f.deleted);
            return (
              <div key={f.path} className="ac-row ac-file">
                <span className={`ac-path${f.flagged ? " is-flagged" : ""}`}>{f.path}</span>
                <span className="ac-n">{f.added === undefined ? "binary" : `+${f.added} −${f.deleted}`}</span>
                <span className="ac-bar">
                  <i className="a" style={{ width: `${bar.add}%` }} />
                  <i className="d" style={{ width: `${bar.del}%` }} />
                </span>
              </div>
            );
          })}
        </div>
      )}
      {c.flags.length > 0 && (
        <div className="ac-flags">
          {c.flags.map((f, i) => (
            <div key={`${i}:${f.rule}:${f.subject}`} className="ac-flag">
              <span className="ac-warn">⚠</span>
              <div>
                {f.rule === "ci" ? "Changes CI config: " : f.rule === "author" ? "Not authored by you: " : "No Claude trailer: "}
                <code>{f.subject}</code>
                <div className="ac-why">{f.why}</div>
              </div>
            </div>
          ))}
        </div>
      )}
      {card.state === "stale" ? (
        <div className="ac-stale">
          {c.branch} moved from {short(c.head)} to {short(card.moved?.to ?? "")} ({card.moved?.commits ?? 0} new commit{card.moved?.commits === 1 ? "" : "s"}) after this card was shown. Nothing was delivered.
        </div>
      ) : (
        <>
          <div className="ac-choose">
            {!c.pr && (
              <>
                <span className="ac-lbl">Route</span>
                <Segments<DeliverRoute> label="Route" value={route} onChange={setRoute} options={[["main", `Straight to ${c.base}`], ["pr", "Open a PR first"]]} />
              </>
            )}
            {!pr && (
              <>
                <span className="ac-lbl">Method</span>
                <Segments<DeliverMethod> label="Method" value={method} onChange={setMethod} options={[["merge", "Merge commit"], ["squash", "Squash"]]} />
              </>
            )}
            <span className="ac-effect">{effectLine(c, route, method)}</span>
          </div>
          {pr && (
            <Fields hint="Written by Claude, shown as GitHub will show it. Edit before opening, if you like.">
              <input className="ac-fld" value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Pull request title" />
              <BodyField value={body} onChange={setBody} footer={FOOTERS.pr} label="Pull request description" />
            </Fields>
          )}
          {!pr && method === "squash" && (
            <Fields hint="The squash commit's message: the title from Claude, one line per commit.">
              <input className="ac-fld" value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Commit subject" />
              <div className="ac-fld ac-body">
                <textarea className="ac-ta mono" value={message} onChange={(e) => setMessage(e.target.value)} aria-label="Commit message" />
                {c.trailers.length > 0 && <span className="ac-foot mono">{c.trailers.join("\n")} · carried over by Kumiko</span>}
              </div>
            </Fields>
          )}
        </>
      )}
      {declining && (
        <div className="ac-decline">
          <textarea className="ac-ta ac-fld" autoFocus placeholder="Why not, for Claude (optional)" aria-label="Reason for declining, for Claude" value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
      )}
      {footBar(pr ? "Opens as you (gh on the Mac)" : c.signs ? "Signs with your key" : "Not signed: no signing key in your git config")}
    </div>
  );
}

/** The issue's labels: only the repository's own, removed with ×, added from a list of the rest. */
function Labels({ all, picked, onChange }: { all: { name: string; color?: string }[]; picked: string[]; onChange(l: string[]): void }) {
  const rest = all.filter((l) => !picked.includes(l.name));
  const color = (name: string) => all.find((l) => l.name === name)?.color;
  return (
    <div className="ac-labels">
      Labels
      {picked.map((l) => (
        <span key={l} className="ac-label" style={color(l) ? { borderColor: `#${color(l)}`, color: `#${color(l)}` } : undefined}>
          {l}
          <button type="button" aria-label={`Remove ${l}`} onClick={() => onChange(picked.filter((x) => x !== l))}>
            ×
          </button>
        </span>
      ))}
      {rest.length > 0 && (
        <select className="ac-label-add" value="" aria-label="Add a label" onChange={(e) => e.target.value && onChange([...picked, e.target.value])}>
          <option value="">+ label</option>
          {rest.map((l) => (
            <option key={l.name} value={l.name}>
              {l.name}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}

function Segments<T extends string>({ label, value, onChange, options }: { label: string; value: T; onChange(v: T): void; options: [T, string][] }) {
  return (
    <span className="ac-seg" role="radiogroup" aria-label={label}>
      {options.map(([v, label]) => (
        <button type="button" role="radio" aria-checked={v === value} key={v} className={v === value ? "is-on" : ""} onClick={() => onChange(v)}>
          {label}
        </button>
      ))}
    </span>
  );
}

function Fields({ hint, children }: { hint: string; children: ReactNode }) {
  return (
    <div className="ac-fields">
      {children}
      <span className="ac-hint">{hint}</span>
    </div>
  );
}

/** Text that goes public: rendered as GitHub would until clicked, then a box to edit; Kumiko's footer under it. */
export function BodyField({ value, onChange, footer, label }: { value: string; onChange(v: string): void; footer: string; label: string }) {
  const [editing, setEditing] = useState(false);
  return (
    <div className="ac-fld ac-body">
      {editing ? (
        // Once editing, it stays a box: going back to the preview on blur would move the buttons under the pointer.
        <textarea className="ac-ta" autoFocus value={value} onChange={(e) => onChange(e.target.value)} aria-label={label} />
      ) : (
        <div className="ac-md" role="button" tabIndex={0} aria-label={`${label}: click to edit`} onClick={(e) => !(e.target as HTMLElement).closest("a") && setEditing(true)} onKeyDown={(e) => e.key === "Enter" && !e.metaKey && !e.ctrlKey && setEditing(true)}>
          {value.trim() ? <Markdown text={value} /> : <span className="dim">Empty</span>}
        </div>
      )}
      <span className="ac-foot">{footer} · added by Kumiko, not editable</span>
    </div>
  );
}
