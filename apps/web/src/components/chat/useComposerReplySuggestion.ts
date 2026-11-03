import type { EnvironmentId, RunId, ThreadId } from "@t3tools/contracts";
import { useEffect, useEffectEvent, useSyncExternalStore } from "react";

import { createReplySuggestionStore, replySuggestionVisible } from "../../composerReplySuggestion";
import { orchestrationEnvironment } from "~/state/orchestration";
import { useAtomCommand } from "~/state/use-atom-command";

const replySuggestions = createReplySuggestionStore();

/**
 * Reads the suggestion the server computed after this thread's latest completed run. The store
 * outlives the composer, so switching threads shows a known suggestion at once and asks about each
 * run once; a send or Escape retires that run's suggestion for good.
 */
export function useComposerReplySuggestion(input: {
  readonly busy: boolean;
  readonly empty: boolean;
  readonly enabled: boolean;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId | null;
  /** The thread's latest run once it completed, or null while one runs or none has. */
  readonly runId: RunId | null;
  readonly writeDraft: (text: string) => void;
}): {
  readonly onAccept: () => void;
  readonly onDismiss: () => void;
  /** Sending retires the shown suggestion before the next run is visible to the client. */
  readonly onSent: () => void;
  readonly text: string;
} {
  const { busy, empty, enabled, environmentId, runId, threadId, writeDraft } = input;
  const suggest = useAtomCommand(orchestrationEnvironment.v2.suggestComposerReply, {
    reportFailure: false,
  });
  const key = threadId === null ? null : `${environmentId}\u0000${threadId}`;
  const entry = useSyncExternalStore(replySuggestions.subscribe, () =>
    key === null ? undefined : replySuggestions.get(key),
  );

  const requestSuggestion = useEffectEvent((thread: ThreadId, run: RunId) =>
    suggest({ environmentId, input: { threadId: thread, runId: run } }),
  );

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- asks the server about a newly completed run; the answer lands in the module store, keyed by that run
  useEffect(() => {
    if (!enabled || busy || key === null || threadId === null || runId === null) return;
    if (!replySuggestions.shouldRead(key, runId)) return;
    replySuggestions.beginRead(key, runId);
    void requestSuggestion(threadId, runId).then((result) =>
      replySuggestions.endRead(
        key,
        runId,
        result._tag === "Success" ? result.value.text : undefined,
      ),
    );
  }, [busy, enabled, key, runId, threadId]);

  const visible = enabled && replySuggestionVisible({ busy, empty, entry, runId });
  const text = visible && entry !== undefined ? entry.text : "";

  const retire = () => {
    if (key !== null && runId !== null) replySuggestions.dismiss(key, runId);
  };

  return {
    onAccept: () => {
      if (text !== "") writeDraft(text);
    },
    onDismiss: () => {
      if (text !== "") retire();
    },
    onSent: retire,
    text,
  };
}
