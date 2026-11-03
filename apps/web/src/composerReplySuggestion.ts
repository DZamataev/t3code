/**
 * Ghost-text reply suggestion for the empty composer: the server predicts the user's next message
 * when a run completes and the client only reads it back. A suggestion belongs to one completed run
 * of one thread, so a newer run, a send, or Escape retires it without any timing heuristics.
 */

export interface ReplySuggestionEntry {
  readonly runId: string;
  readonly text: string;
  /** Escape or a send retired it; the run's next suggestion is a different run's. */
  readonly dismissed: boolean;
}

/** The run a suggestion would follow: the thread's latest run, once it completed. */
export const replySuggestionRunId = <Id extends string>(
  latestRun: { readonly runId: Id; readonly status: string } | null | undefined,
): Id | null => (latestRun?.status === "completed" ? latestRun.runId : null);

export function replySuggestionVisible(state: {
  /** A turn is running: the previous suggestion no longer describes what comes next. */
  readonly busy: boolean;
  /** The composer holds no text, attachment, or context chip. */
  readonly empty: boolean;
  readonly entry: ReplySuggestionEntry | undefined;
  readonly runId: string | null;
}): boolean {
  const { entry } = state;
  return (
    !state.busy &&
    state.empty &&
    state.runId !== null &&
    entry?.runId === state.runId &&
    entry.text !== "" &&
    !entry.dismissed
  );
}

/** Plain Tab or Right arrow only: a modified key keeps its native meaning, and an empty draft has no caret to move. */
export const isReplySuggestionAcceptKey = (event: {
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly key: string;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
}): boolean =>
  (event.key === "Tab" || event.key === "ArrowRight") &&
  !event.shiftKey &&
  !event.metaKey &&
  !event.ctrlKey &&
  !event.altKey;

/** Threads remembered in memory; older entries fall out first. */
const MAX_REMEMBERED_THREADS = 200;

/**
 * Suggestions per thread, outliving the composer so switching threads keeps them. Every write names
 * its run: an answer for a run that is no longer the one being asked about is dropped, and an answer
 * never overrides what the user already did to that run's suggestion.
 */
export function createReplySuggestionStore() {
  const entries = new Map<string, ReplySuggestionEntry>();
  /** The run each thread's outstanding read asks about; only that run's answer is kept. */
  const reading = new Map<string, string>();
  const listeners = new Set<() => void>();

  const write = (key: string, entry: ReplySuggestionEntry) => {
    entries.delete(key);
    entries.set(key, entry);
    while (entries.size > MAX_REMEMBERED_THREADS) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      entries.delete(oldest);
    }
    for (const listener of listeners) listener();
  };

  return {
    get: (key: string): ReplySuggestionEntry | undefined => entries.get(key),
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    /** Whether to ask the server about this run: nothing known about it and no read already out. */
    shouldRead: (key: string, runId: string): boolean =>
      entries.get(key)?.runId !== runId && reading.get(key) !== runId,
    beginRead: (key: string, runId: string) => {
      reading.set(key, runId);
    },
    /** `text` is undefined when the read failed: the run stays unknown, so a later read retries. */
    endRead: (key: string, runId: string, text: string | undefined) => {
      if (reading.get(key) !== runId) return;
      reading.delete(key);
      if (text === undefined || entries.get(key)?.runId === runId) return;
      write(key, { runId, text, dismissed: false });
    },
    dismiss: (key: string, runId: string) => {
      const current = entries.get(key);
      if (current?.runId === runId && current.dismissed) return;
      write(key, {
        runId,
        text: current?.runId === runId ? current.text : "",
        dismissed: true,
      });
    },
  };
}
