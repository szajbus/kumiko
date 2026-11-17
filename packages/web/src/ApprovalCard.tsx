import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";
import { MAX_REASON, REVIEW, type ApprovalCard as Card, type DeliverCard, type ReviewState, type AttachmentInput, type CardDecision, type CardFlag, type CardFile } from "@kumiko/shared";
import { approveLabel, barShares, cardAction, cardClosed, cardVerb, commitsLabel, deliverChoices, deliverDecision, filesLabel, initialChoice, lostHeading, unsignedWarning, whereLabel, type DeliverChoice } from "./cards";
import { hasFiles, readFiles, toInput, type ComposerFile } from "./attachments";
import type { ChatItem } from "./chat";
import { FileChips } from "./Composer";
import { Markdown } from "./Markdown";
import { changesReason, getReview, onRequestChanges, reviewOf, setReview, subscribeReviews, viewedCount, type Review } from "./review";
import { WindowContext } from "./windowContext";

type AskItem = Extract<ChatItem, { type: "ask" }>;

/** What a card can ask the server to do; resolves to whether it went through. Missing where nobody can decide. */
export type CardAction = { action: "approve"; decision: CardDecision } | { action: "decline"; reason?: string; attachments?: AttachmentInput[] } | { action: "refresh" };
export const CardContext = createContext<((askId: string, action: CardAction) => Promise<boolean>) | undefined>(undefined);

const short = (sha: string) => sha.slice(0, 7);
const upperFirst = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * The card for one of Kumiko's tools that waits for the user's approval: what it acts on, what Kumiko found, and a
 * button that names what happens. Claude says why in the chat, just above it. Once decided it shrinks to a receipt.
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
  if (card.state === "done" || card.state === "failed" || card.state === "declined") return <Receipt card={card} />;
  if (closed) return <Receipt card={card} note={closed} />;
  if (card.state === "approved" || card.state === "working") {
    return (
      <div className="ac-receipt">
        <span className="ac-r-icon">…</span>
        {card.state === "approved" ? "Approved; waiting for Claude to go ahead" : `${upperFirst(cardAction(card))}…`}
      </div>
    );
  }
  // A card worked out again (a stale one reviewed) starts over: its choices and text were for the old state.
  return <OpenCard key={card.card.kind === "deliver" ? `${card.id}:${card.card.head}:${card.card.pr?.number ?? ""}` : card.id} card={card} decide={decide} />;
}

function Receipt({ card, note }: { card: Card; note?: string }) {
  const ok = card.state === "done" && card.receipt?.ok !== false;
  const text = note ? `${upperFirst(cardAction(card))}: ${note}` : card.state === "declined" ? `Declined: ${cardAction(card)}` : (card.receipt?.text ?? upperFirst(cardAction(card)));
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
  const [choice, setChoice] = useState<DeliverChoice>(c.kind === "deliver" ? initialChoice(c) : "merge");
  const [title, setTitle] = useState(c.kind === "deliver" || c.kind === "issue" ? c.title : "");
  const [body, setBody] = useState(c.body);
  const [labels, setLabels] = useState<string[]>(c.kind === "issue" ? c.labels : []);
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState("");
  const [files, setFiles] = useState<ComposerFile[]>([]);
  const [refused, setRefused] = useState<string>();
  const [dropping, setDropping] = useState(false);
  const [busy, setBusy] = useState(false);

  const send = async (action: CardAction) => {
    if (!decide || busy) return false;
    setBusy(true);
    const ok = await decide(card.id, action);
    setBusy(false);
    return ok;
  };
  const win = useContext(WindowContext);
  const review = useSyncExternalStore(subscribeReviews, () => (win && c.kind === "deliver" ? getReview(win.session, reviewOf(c)) : NO_REVIEW));
  const notes = review.notes;
  const box = useRef<HTMLDivElement>(null);
  // The review pane's Request changes: this card opens its box for a message to go with the notes.
  useEffect(
    () =>
      onRequestChanges((ask) => {
        if (ask !== card.id) return;
        setDeclining(true);
        box.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      }),
    [card.id],
  );
  const decision = (): CardDecision | undefined => {
    switch (c.kind) {
      case "deliver":
        return deliverDecision(choice, { title, body, original: c.title });
      case "issue":
        return title.trim() ? { kind: "issue", title: title.trim(), body, labels } : undefined;
      case "comment":
        return body.trim() ? { kind: "comment", body } : undefined;
    }
  };
  const approve = () => {
    const d = decision();
    if (d && card.state === "open") void send({ action: "approve", decision: d });
  };

  const declineNow = () => {
    if (!decide || busy) return;
    const text = c.kind === "deliver" && notes.length ? changesReason(c, notes, reason) : reason.trim();
    // Cut, the notes at the end would be lost without a word: the user shortens them instead.
    if (text.length > MAX_REASON) {
      setRefused(`That's ${text.length.toLocaleString()} characters with the notes, more than the ${MAX_REASON.toLocaleString()} Claude is sent. Shorten or delete some notes.`);
      return;
    }
    void send({ action: "decline", ...(text ? { reason: text } : {}), ...(files.length ? { attachments: files.map(toInput) } : {}) }).then((ok) => {
      // The notes went to Claude with it.
      if (ok && win && notes.length && c.kind === "deliver") setReview(win.session, reviewOf(c), (r) => ({ ...r, notes: [] }));
    });
  };
  const attach = async (picked: File[]) => {
    if (!picked.length) return;
    const read = await readFiles(picked, files);
    setFiles((have) => [...have, ...read.files]);
    setRefused(read.errors.join(" ") || undefined);
  };

  const stale = card.state === "stale";
  const head = (
    <div className="ac-head">
      <div className="ac-title">
        {cardVerb(c, choice)}
        {c.kind === "deliver" && (
          <>
            <code className="ac-ref">{c.base}</code> <span className="ac-arrow">←</span> <code className="ac-ref">{c.branch}</code>
            {c.pr && <span className="badge">#{c.pr.number}</span>}
          </>
        )}
        {c.kind === "comment" && (
          <a className="ac-target" href={c.target.url} target="_blank" rel="noreferrer">
            {c.target.title}
          </a>
        )}
        {stale && <span className="badge badge-warn">out of date</span>}
      </div>
      <span className="ac-repo">{c.repo}</span>
    </div>
  );

  const decline = (
    <button type="button" className={`btn btn-compact ${notes.length ? "btn-warn" : "btn-secondary"}`} disabled={busy || !decide} onClick={() => setDeclining(true)}>
      {notes.length ? `Request changes (${notes.length})` : "Decline…"}
    </button>
  );
  const primary = stale ? (
    <button key="refresh" type="button" className="btn btn-primary btn-compact" disabled={busy || !decide} onClick={() => void send({ action: "refresh" })}>
      Review again
    </button>
  ) : c.kind === "deliver" ? (
    <SplitButton key="approve" label={approveLabel(c, choice)} disabled={busy || !decide || !decision()} menuDisabled={busy || !decide} onClick={approve} choices={deliverChoices(c)} choice={choice} onChoose={setChoice} />
  ) : (
    <button key="approve" type="button" className="btn btn-primary btn-compact" disabled={busy || !decide || !decision()} onClick={approve}>
      {approveLabel(c)}
    </button>
  );

  return (
    <div className="ac-card is-pending" role="group" aria-label={cardVerb(c, choice)} ref={box}>
      {head}
      {c.kind === "deliver" && <Facts commits={c.commits} files={c.files} added={c.added} deleted={c.deleted} where={whereLabel(c)} />}
      {c.kind === "deliver" && !stale && c.lost.length > 0 && (
        <div className="ac-lost">
          <b>{lostHeading(c)}</b>
          {c.lost.map((l) => (
            <div key={l.sha} className="ac-row">
              <code className="ac-sha">{short(l.sha)}</code>
              <span>
                {l.subject} <i>{l.how}</i>
              </span>
            </div>
          ))}
          <div className="ac-why">Your team can see these on GitHub already. The branch was rewritten since.</div>
        </div>
      )}
      {c.kind === "deliver" && !stale && <Flags flags={c.flags} />}
      {c.kind === "deliver" && win && <ReviewStrip c={c} review={review} open={reviewOpen(win.window, card.id)} onToggle={() => win.review(card.id)} />}
      {stale && c.kind === "deliver" && (
        <div className="ac-stale">
          {c.branch} moved to {short(card.moved?.to ?? "")} ({card.moved?.commits ?? 0} new commit{card.moved?.commits === 1 ? "" : "s"}) after this card was shown.
        </div>
      )}
      {!stale && c.kind === "deliver" && choice === "pr" && (
        <div className="ac-fields">
          <input className="ac-fld" value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Pull request title" />
          <BodyField value={body} onChange={setBody} label="Pull request description" />
        </div>
      )}
      {c.kind === "issue" && (
        <div className="ac-fields">
          <input className="ac-fld" value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Issue title" />
          <BodyField value={body} onChange={setBody} label="Issue description" />
          <Labels all={c.repoLabels} picked={labels} onChange={setLabels} />
        </div>
      )}
      {c.kind === "comment" && (
        <div className="ac-fields">
          <BodyField value={body} onChange={setBody} label="Comment" />
        </div>
      )}
      {!stale && c.kind === "deliver" && unsignedWarning(c, choice) && <div className="ac-unsigned">{unsignedWarning(c, choice)}</div>}
      {declining && (
        <>
          <div
            className={`ac-decline ac-fld${dropping ? " is-dropping" : ""}`}
            onDragOver={(e) => {
              if (!hasFiles(e.dataTransfer)) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = "copy";
              setDropping(true);
            }}
            // Leaving for one of its own children isn't leaving.
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropping(false);
            }}
            onDrop={(e) => {
              if (!hasFiles(e.dataTransfer)) return;
              e.preventDefault();
              setDropping(false);
              void attach([...e.dataTransfer.files]);
            }}
          >
            <textarea
              className="ac-ta"
              autoFocus
              placeholder={notes.length ? `Anything to add to your ${notes.length === 1 ? "note" : `${notes.length} notes`}, for Claude (optional)` : "Why not, for Claude (optional)"}
              aria-label="Reason for declining, for Claude"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== "Enter" || !(e.metaKey || e.ctrlKey)) return;
                e.preventDefault();
                declineNow();
              }}
              onPaste={(e) => {
                // A screenshot, or files copied as such; text that comes with them wins, as in the composer.
                if (e.clipboardData.files.length === 0 || e.clipboardData.getData("text/plain")) return;
                e.preventDefault();
                void attach([...e.clipboardData.files]);
              }}
            />
            <FileChips files={files} onChange={setFiles} />
          </div>
          {refused && <div className="ac-refused">{refused}</div>}
        </>
      )}
      <div className="ac-foot-bar">
        <span className="chat-proposal-buttons">
          {declining ? (
            <>
              <button type="button" className="btn btn-secondary btn-compact" disabled={busy} onClick={() => setDeclining(false)}>
                Back
              </button>
              <button type="button" className="btn btn-secondary btn-compact" disabled={busy || !decide} onClick={declineNow}>
                {notes.length ? "Request changes" : "Decline and tell Claude"}
              </button>
            </>
          ) : (
            <>
              {decline}
              {primary}
            </>
          )}
        </span>
      </div>
    </div>
  );
}

function Facts({ commits, files, added, deleted, where }: { commits: { sha: string; subject: string; claude: boolean }[]; files: CardFile[]; added: number; deleted: number; where?: string }) {
  const [open, setOpen] = useState<"commits" | "files">();
  return (
    <>
      <div className="ac-facts">
        <button type="button" aria-expanded={open === "commits"} className={`ac-tog${open === "commits" ? " is-on" : ""}`} onClick={() => setOpen(open === "commits" ? undefined : "commits")}>
          {commitsLabel({ commits })} <span className="tri" aria-hidden="true" />
        </button>
        <span>
          <button type="button" aria-expanded={open === "files"} className={`ac-tog${open === "files" ? " is-on" : ""}`} onClick={() => setOpen(open === "files" ? undefined : "files")}>
            {filesLabel({ files })} <span className="tri" aria-hidden="true" />
          </button>{" "}
          <span className="ac-add">+{added}</span> <span className="ac-del">−{deleted}</span>
        </span>
        {where && <span className="ac-where">{where}</span>}
      </div>
      {open === "commits" && (
        <div className="ac-panel">
          {commits.map((x) => (
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
          {files.map((f) => {
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
    </>
  );
}

function Flags({ flags }: { flags: CardFlag[] }) {
  if (!flags.length) return null;
  return (
    <div className="ac-flags">
      {flags.map((f, i) => (
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
  );
}

/**
 * The primary button with a list of the other ways to do it; the main part does the one it shows. A disclosure, not an
 * ARIA menu: the choices are buttons Tab reaches, and focus goes back to the caret once one is picked or the list closes.
 */
function SplitButton({ label, disabled, menuDisabled, onClick, choices, choice, onChoose }: { label: string; disabled: boolean; menuDisabled: boolean; onClick(): void; choices: { choice: DeliverChoice; label: string; description: string }[]; choice: DeliverChoice; onChoose(c: DeliverChoice): void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  const caret = useRef<HTMLButtonElement>(null);
  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) caret.current?.focus();
  };
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const escape = (e: globalThis.KeyboardEvent) => e.key === "Escape" && close(true);
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", escape);
    return () => (document.removeEventListener("mousedown", away), document.removeEventListener("keydown", escape));
  }, [open]);
  return (
    <span className="ac-split" ref={ref}>
      <button type="button" className="btn btn-primary btn-compact" disabled={disabled} onClick={onClick}>
        {label}
      </button>
      <button ref={caret} type="button" className="btn btn-primary btn-compact ac-caret" aria-label="Other ways" aria-expanded={open} aria-controls={open ? "ac-choices" : undefined} disabled={menuDisabled} onClick={() => setOpen(!open)}>
        <span className="tri" aria-hidden="true" />
      </button>
      {open && (
        <div className="ac-menu" id="ac-choices">
          {choices.map((c) => (
            <button key={c.choice} type="button" aria-pressed={c.choice === choice} className={`ac-opt${c.choice === choice ? " is-on" : ""}`} onClick={() => (onChoose(c.choice), close(true))}>
              <span className="ac-ck">{c.choice === choice ? "✓" : ""}</span>
              <span>
                <b>{c.label}</b>
                <span className="ac-opt-d">{c.description}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </span>
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

/** Text that goes public: rendered as GitHub would until clicked, then a box to edit, which it stays. */
export function BodyField({ value, onChange, label }: { value: string; onChange(v: string): void; label: string }): ReactNode {
  const [editing, setEditing] = useState(false);
  return (
    <div className="ac-fld ac-body">
      {editing ? (
        // Once editing, it stays a box: going back to the preview on blur would move the buttons under the pointer.
        <textarea className="ac-ta" autoFocus value={value} onChange={(e) => onChange(e.target.value)} aria-label={label} />
      ) : (
        <div className="ac-md" role="button" tabIndex={0} aria-label={`${label}: click to edit`} onClick={(e) => !(e.target as HTMLElement).closest("a") && setEditing(true)} onKeyDown={(e) => {
            if (e.key !== "Enter" && e.key !== " ") return;
            e.preventDefault();
            setEditing(true);
          }}>
          {value.trim() ? <Markdown text={value} /> : <span className="dim">Empty</span>}
        </div>
      )}
    </div>
  );
}

const NO_REVIEW: Review = { viewed: {}, notes: [], seen: [] };

/** Whether the window's review pane is on screen, showing card `ask`. */
const reviewOpen = (w: { panes: Record<string, string>; widgets: Record<string, { state?: unknown }> }, ask: string) =>
  Object.values(w.panes).includes(REVIEW) && (w.widgets[REVIEW]?.state as ReviewState | undefined)?.ask === ask;

/** How far the user got reading the card's changes in the review pane, and the button that opens it. */
function ReviewStrip({ c, review, open, onToggle }: { c: DeliverCard; review: Review; open: boolean; onToggle(): void }) {
  const done = viewedCount(review, c);
  const all = c.files.length;
  const notes = review.notes.length;
  return (
    <div className={`ac-review${open ? " is-open" : ""}${all && done === all ? " is-done" : ""}`}>
      <span className="ac-ring" style={{ "--p": all ? Math.round((done / all) * 100) : 0 } as CSSProperties} aria-hidden="true" />
      <div className="ac-review-text">
        <b>{all && done === all ? `All ${all} files reviewed` : `${done} of ${all} file${all === 1 ? "" : "s"} reviewed`}</b>
        {notes > 0 && <div className="ac-review-sub">{notes === 1 ? "1 note" : `${notes} notes`} for Claude</div>}
      </div>
      <button type="button" className="btn btn-secondary btn-compact" aria-pressed={open} onClick={onToggle}>
        {open ? "Close review" : "Review"}
      </button>
    </div>
  );
}
