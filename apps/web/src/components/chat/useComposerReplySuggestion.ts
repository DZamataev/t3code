import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useEffect, useEffectEvent, useState } from "react";

import { replySuggestionShouldRead, replySuggestionVisible } from "../../composerReplySuggestion";
import { orchestrationEnvironment } from "~/state/orchestration";
import { useAtomCommand } from "~/state/use-atom-command";

/**
 * Reads the suggestion the server computed for this thread's latest completed turn. The read is
 * free — the prediction happened when the turn committed — so a composer that mounts, switches
 * threads, or clears its draft asks again and gets the same text back.
 */
export function useComposerReplySuggestion(input: {
  readonly busy: boolean;
  readonly empty: boolean;
  readonly enabled: boolean;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId | null;
  readonly writeDraft: (text: string) => void;
}): {
  readonly onAccept: () => void;
  readonly onDismiss: () => void;
  /** Sending clears the turn's suggestion at once instead of waiting for the turn to start. */
  readonly onSent: () => void;
  readonly text: string;
} {
  const { busy, empty, enabled, environmentId, threadId, writeDraft } = input;
  const suggest = useAtomCommand(orchestrationEnvironment.v2.suggestComposerReply, {
    reportFailure: false,
  });
  const [text, setText] = useState("");
  const [dismissedText, setDismissedText] = useState<string | null>(null);
  // A suggestion belongs to one turn and one thread: both replace everything known about it.
  const [knownThread, setKnownThread] = useState(threadId);
  const [wasBusy, setWasBusy] = useState(busy);
  // A sent message ends the turn the shown suggestion belonged to, and the next turn has not
  // produced one yet: reading now would resurrect the previous turn's text for a moment.
  const [awaitingTurn, setAwaitingTurn] = useState(false);
  if (knownThread !== threadId) {
    setKnownThread(threadId);
    setAwaitingTurn(false);
    setText("");
    setDismissedText(null);
  }
  if (wasBusy !== busy) {
    setWasBusy(busy);
    setAwaitingTurn(false);
    if (busy) {
      setText("");
      setDismissedText(null);
    }
  }

  const requestSuggestion = useEffectEvent((thread: ThreadId) =>
    suggest({ environmentId, input: { threadId: thread } }),
  );

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the read answers after the composer may have gained text or changed threads; the cleanup drops it instead of syncing state
  useEffect(() => {
    if (threadId === null) return;
    if (
      !replySuggestionShouldRead({
        awaitingTurn,
        busy,
        empty,
        enabled,
        text,
        threadId,
      })
    ) {
      return;
    }
    let cancelled = false;
    void requestSuggestion(threadId).then((result) => {
      if (cancelled || result._tag !== "Success") return;
      setText(result.value.text);
    });
    return () => {
      cancelled = true;
    };
  }, [awaitingTurn, busy, empty, enabled, text, threadId]);

  const visible = replySuggestionVisible({ busy, dismissedText, empty, text });

  const onAccept = () => {
    if (!visible) return;
    writeDraft(text);
  };

  const onDismiss = () => {
    if (!visible) return;
    setDismissedText(text);
  };

  const onSent = () => {
    setAwaitingTurn(true);
    setText("");
    setDismissedText(null);
  };

  return { onAccept, onDismiss, onSent, text: visible ? text : "" };
}
