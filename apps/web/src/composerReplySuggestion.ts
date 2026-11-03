/**
 * Ghost-text reply suggestion for the empty composer: the server predicts the user's next message
 * when a turn completes and the client only reads it back. It is visible in an idle thread while
 * the composer is empty and nothing is attached, until the user dismisses it.
 */

export interface ReplySuggestionVisibility {
  /** A turn is running: the previous suggestion no longer describes what comes next. */
  readonly busy: boolean;
  /** The composer holds no text, attachment, or context chip. */
  readonly empty: boolean;
  readonly text: string;
  /** The text the user dismissed, or null after the next turn replaced it. */
  readonly dismissedText: string | null;
}

export function replySuggestionVisible(state: ReplySuggestionVisibility): boolean {
  return !state.busy && state.empty && state.text !== "" && state.text !== state.dismissedText;
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
