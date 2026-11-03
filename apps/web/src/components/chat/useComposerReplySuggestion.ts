import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import { replySuggestionVisible } from "../../composerReplySuggestion";
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
  if (knownThread !== threadId) {
    setKnownThread(threadId);
    setText("");
    setDismissedText(null);
  }
  if (wasBusy !== busy) {
    setWasBusy(busy);
    if (busy) {
      setText("");
      setDismissedText(null);
    }
  }

  const inFlightRef = useRef(false);
  const requestSuggestion = useEffectEvent((thread: ThreadId) =>
    suggest({ environmentId, input: { threadId: thread } }),
  );

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the read answers after the composer may have gained text or changed threads; the cleanup drops it instead of syncing state
  useEffect(() => {
    if (!enabled || threadId === null || busy || !empty || text !== "" || inFlightRef.current) {
      return;
    }
    let cancelled = false;
    inFlightRef.current = true;
    void requestSuggestion(threadId).then((result) => {
      inFlightRef.current = false;
      if (cancelled || result._tag !== "Success") return;
      setText(result.value.text);
    });
    return () => {
      cancelled = true;
    };
  }, [busy, empty, enabled, text, threadId]);

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
    setText("");
    setDismissedText(null);
  };

  return { onAccept, onDismiss, onSent, text: visible ? text : "" };
}
