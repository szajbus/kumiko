import { createContext, useContext, useId, useState, type KeyboardEvent } from "react";
import type { AgentQuestion, AskAnswer } from "@kumiko/shared";
import { answersOf, askOutcome, askPosition, noPicks, pick, pickOwn, planTitle, splitAnswer, typeOwn, type Picks } from "./asks";
import type { ChatItem } from "./chat";
import { Markdown } from "./Markdown";

type AskItem = Extract<ChatItem, { type: "ask" }>;

/** Sends the user's answer to what Claude asked; resolves to whether it went through. Missing where nobody can answer. */
export const AskContext = createContext<((id: string, answer: AskAnswer) => Promise<boolean>) | undefined>(undefined);

/** Claude asking the user mid-turn: its questions, or its plan to approve. Answered or not, it stays in the chat. */
export function AskCard({ item }: { item: AskItem }) {
  return item.ask.kind === "plan" ? <PlanCard item={item} plan={item.ask.plan} /> : <QuestionsCard item={item} questions={item.ask.questions} />;
}

function QuestionsCard({ item, questions }: { item: AskItem; questions: AgentQuestion[] }) {
  const send = useContext(AskContext);
  const [picks, setPicks] = useState<Picks[]>(() => questions.map(noPicks));
  const [sending, setSending] = useState<"answers" | "skip">();
  const over = item.answer !== undefined || item.closed !== undefined;
  const answers = answersOf(questions, picks);
  const set = (i: number, p: Picks) => setPicks((all) => all.map((x, k) => (k === i ? p : x)));
  const answer = async (a: AskAnswer) => {
    setSending(a.kind === "skip" ? "skip" : "answers");
    if (!(await send!(item.ask.id, a))) setSending(undefined);
  };

  if (over || !send) {
    const given = item.answer?.kind === "answers" ? item.answer.answers : {};
    const outcome = askOutcome("questions", item.answer, item.closed);
    return (
      <div className="chat-proposal chat-ask is-answered">
        <strong>{over ? "Claude asked:" : "Claude asks:"}</strong>
        <div className="ask-done">
          {questions.map((q) => {
            const { labels, own } = splitAnswer(q, given[q.question]);
            return (
              <div className="ask-done-row" key={q.question}>
                <span className="ask-done-q">{q.question}</span>
                <span className="ask-done-a">
                  {labels.join(", ")}
                  {own.map((o) => (
                    <span key={o}>
                      {labels.length ? ", " : ""}
                      <span className="ask-own">Other:</span> {o}
                    </span>
                  ))}
                </span>
              </div>
            );
          })}
        </div>
        {outcome && <span className="ask-outcome">{outcome}</span>}
      </div>
    );
  }

  return (
    <div className="chat-proposal chat-ask" role="group" aria-label="Claude asks">
      <strong>Claude asks:</strong>
      {questions.map((q, i) => (
        <Question key={q.question} q={q} n={i} total={questions.length} picks={picks[i]} disabled={sending !== undefined} onChange={(p) => set(i, p)} />
      ))}
      <div className="ask-foot">
        <span>Claude is waiting for your answer.</span>
        <span className="chat-proposal-buttons">
          <button type="button" className="btn btn-secondary btn-compact" disabled={sending !== undefined} onClick={() => void answer({ kind: "skip" })}>
            {sending === "skip" ? "Skipping…" : "Skip"}
          </button>
          <button type="button" className="btn btn-primary btn-compact" disabled={sending !== undefined || !Object.keys(answers).length} onClick={() => void answer({ kind: "answers", answers })}>
            {sending === "answers" ? "Sending…" : "Send answers"}
          </button>
        </span>
      </div>
    </div>
  );
}

/** One question: its options, then a box for an answer of the user's own. The digits pick options while it has the focus. */
function Question({ q, n, total, picks, disabled, onChange }: { q: AgentQuestion; n: number; total: number; picks: Picks; disabled: boolean; onChange(p: Picks): void }) {
  // Unique on the page: chats in other tabs stay mounted, and may ask the same question, which would share the group.
  const name = `${useId()}-${n}`;
  const type = q.multiSelect ? "checkbox" : "radio";
  const position = askPosition(n, total);
  const onKeyDown = (e: KeyboardEvent<HTMLFieldSetElement>) => {
    if (e.target instanceof HTMLInputElement && e.target.type === "text") return;
    const k = Number(e.key);
    if (!Number.isInteger(k) || k < 1 || k > q.options.length || e.metaKey || e.ctrlKey || e.altKey) return;
    e.preventDefault();
    onChange(pick(q, picks, q.options[k - 1].label));
  };
  return (
    <fieldset className="ask-q" disabled={disabled} onKeyDown={onKeyDown}>
      <legend className="ask-q-head">
        {(position || q.header || q.multiSelect) && (
          <span className="ask-q-top">
            <span className="ask-q-label">
              {position && <span className="ask-q-pos">{position}</span>}
              {position && q.header && " · "}
              {q.header}
            </span>
            {q.multiSelect && <span className="ask-q-kind">Pick any</span>}
          </span>
        )}
        <span>{q.question}</span>
      </legend>
      {q.options.map((o, k) => (
        <label className="ask-option" key={o.label}>
          <input type={type} name={name} checked={picks.labels.includes(o.label)} onChange={() => onChange(pick(q, picks, o.label))} />
          <span className="ask-label">
            <span className="ask-key" aria-hidden="true">
              {k + 1}
            </span>
            {o.label}
          </span>
          {o.description && <span className="ask-desc">{o.description}</span>}
        </label>
      ))}
      <label className="ask-option">
        <input type={type} name={name} aria-label="Your own answer" checked={picks.ownOn} onChange={() => onChange(pickOwn(q, picks))} />
        <input className="ask-other-input" placeholder="Other: your own answer" value={picks.own} onChange={(e) => onChange(typeOwn(q, picks, e.target.value))} />
      </label>
    </fieldset>
  );
}

function PlanCard({ item, plan }: { item: AskItem; plan: string }) {
  const send = useContext(AskContext);
  const [feedback, setFeedback] = useState<string>();
  const [sending, setSending] = useState<"approve" | "feedback">();
  const [shown, setShown] = useState(false);
  const over = item.answer !== undefined || item.closed !== undefined;
  const answer = async (a: AskAnswer) => {
    setSending(a.kind === "approve" ? "approve" : "feedback");
    if (!(await send!(item.ask.id, a))) setSending(undefined);
  };

  if (over || !send) {
    const outcome = askOutcome("plan", item.answer, item.closed);
    return (
      <div className="chat-proposal chat-ask is-answered">
        <strong>Claude's plan:</strong>
        {shown ? (
          <div className="plan-box">
            <Markdown text={plan} />
            <button type="button" className="link-btn plan-hide" onClick={() => setShown(false)}>
              Hide plan
            </button>
          </div>
        ) : (
          <div className="plan-box is-folded">
            <span className="plan-first">{planTitle(plan)}</span>
            <button type="button" className="link-btn" onClick={() => setShown(true)}>
              Show plan
            </button>
          </div>
        )}
        {outcome && <span className="ask-outcome">{outcome}</span>}
        {item.answer?.kind === "feedback" && <div className="plan-quote">{item.answer.text}</div>}
      </div>
    );
  }

  const writing = feedback !== undefined;
  return (
    <div className="chat-proposal chat-ask" role="group" aria-label="Claude's plan">
      <strong>Claude's plan, for you to approve:</strong>
      <div className="plan-box">
        <Markdown text={plan} />
      </div>
      {writing && (
        <textarea
          className="plan-feedback"
          aria-label="What Claude should change"
          placeholder="What should Claude change?"
          autoFocus
          value={feedback}
          disabled={sending !== undefined}
          onChange={(e) => setFeedback(e.target.value)}
        />
      )}
      <div className="ask-foot">
        <span>{writing ? "Claude revises the plan and asks again." : "Claude is waiting for your approval before it changes anything."}</span>
        <span className="chat-proposal-buttons">
          {writing ? (
            <>
              <button type="button" className="btn btn-secondary btn-compact" disabled={sending !== undefined} onClick={() => setFeedback(undefined)}>
                Cancel
              </button>
              <button type="button" className="btn btn-primary btn-compact" disabled={sending !== undefined || !feedback.trim()} onClick={() => void answer({ kind: "feedback", text: feedback })}>
                {sending === "feedback" ? "Sending…" : "Send back"}
              </button>
            </>
          ) : (
            <>
              <button type="button" className="btn btn-secondary btn-compact" disabled={sending !== undefined} onClick={() => setFeedback("")}>
                Keep planning…
              </button>
              <button type="button" className="btn btn-primary btn-compact" disabled={sending !== undefined} onClick={() => void answer({ kind: "approve" })}>
                {sending === "approve" ? "Approving…" : "Approve"}
              </button>
            </>
          )}
        </span>
      </div>
    </div>
  );
}
