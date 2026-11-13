import { useMemo, useRef } from "react";
import type { SessionEvent } from "@kumiko/shared";

/**
 * Folds a session's events into a state incrementally: only the events new since the last render are applied, so what
 * they don't change keeps its identity. The events only grow; if the last one applied isn't where it was, they were
 * replaced (a rewind), and the fold starts over from `init`.
 */
export function useFold<S>(events: readonly SessionEvent[], init: () => S, apply: (state: S, added: readonly SessionEvent[]) => S): S {
  const ref = useRef<{ state?: S; count: number; last?: SessionEvent }>({ count: 0 });
  return useMemo(() => {
    const same = ref.current.count > 0 && events[ref.current.count - 1] === ref.current.last;
    const state = same ? (ref.current.state as S) : init();
    const count = same ? ref.current.count : 0;
    const next = count < events.length ? apply(state, events.slice(count)) : state;
    ref.current = { state: next, count: events.length, last: events.at(-1) };
    return next;
    // `init` and `apply` are fixed for each use.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events]);
}
