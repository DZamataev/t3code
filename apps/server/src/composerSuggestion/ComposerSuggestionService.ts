import {
  type MessageId,
  OrchestrationV2SuggestComposerReplyError,
  type OrchestrationV2SuggestComposerReplyResult,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import { composerSuggestionTarget, lastAssistantReply } from "./decide.ts";
import { cleanComposerSuggestion } from "./filter.ts";
import { COMPOSER_SUGGESTION_INSTRUCTION } from "./instruction.ts";

/**
 * Predicts the user's next message after each completed turn by forking the finished session, so
 * the provider's prompt cache covers the conversation and only the instruction is new input. It
 * lives in memory, never in the event log: chrome around the next turn, not conversation.
 */
const SUGGESTION_TTL_MS = 15 * 60_000;

/** Threads kept in memory; older entries fall out first. */
const MAX_CACHED_THREADS = 200;

/** A read that arrives while this thread's prediction is still running waits this long for it. */
const SUGGESTION_WAIT_MS = 20_000;

/** How long a read waits for the prediction of a turn it may have outraced. */
const SUGGESTION_GATE_GRACE_MS = 2_000;

interface CachedSuggestion {
  readonly messageId: MessageId;
  readonly text: string;
  readonly storedAt: number;
}

/**
 * Predicts the user's next message after each completed turn by forking the finished session, so
 * the provider's prompt cache covers the conversation and only the instruction is new input. It
 * lives in memory, never in the event log: chrome around the next turn, not conversation.
 */
export class ComposerSuggestionService extends Context.Service<
  ComposerSuggestionService,
  {
    readonly read: (input: {
      readonly threadId: ThreadId;
    }) => Effect.Effect<
      OrchestrationV2SuggestComposerReplyResult,
      OrchestrationV2SuggestComposerReplyError
    >;
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/composerSuggestion/ComposerSuggestionService") {}

const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const settings = yield* ServerSettings.ServerSettingsService;
  const instances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const cache = yield* Ref.make(new Map<ThreadId, CachedSuggestion>());

  const store = (threadId: ThreadId, messageId: MessageId, text: string, nowMs: number) =>
    Ref.update(cache, (current) => {
      const next = new Map(current);
      next.delete(threadId);
      next.set(threadId, { messageId, text, storedAt: nowMs });
      while (next.size > MAX_CACHED_THREADS) {
        const oldest = next.keys().next().value;
        if (oldest === undefined) break;
        next.delete(oldest);
      }
      return next;
    });

  // A prediction takes seconds; a read that arrives first waits for it instead of answering
  // "nothing" and leaving the composer empty until the next turn.
  const pending = yield* Ref.make(new Map<ThreadId, Deferred.Deferred<void>>());

  const beginPrediction = Effect.fn("ComposerSuggestionService.beginPrediction")(function* (
    threadId: ThreadId,
  ) {
    const gate = yield* Deferred.make<void>();
    const previous = yield* Ref.modify(pending, (current) => {
      const next = new Map(current);
      const replaced = next.get(threadId);
      next.set(threadId, gate);
      return [replaced, next] as const;
    });
    if (previous !== undefined) yield* Deferred.succeed(previous, undefined);
    return gate;
  });

  const endPrediction = (threadId: ThreadId, gate: Deferred.Deferred<void>) =>
    Ref.update(pending, (current) => {
      if (current.get(threadId) !== gate) return current;
      const next = new Map(current);
      next.delete(threadId);
      return next;
    }).pipe(Effect.andThen(Deferred.succeed(gate, undefined)), Effect.asVoid);

  const read: ComposerSuggestionService["Service"]["read"] = Effect.fn(
    "ComposerSuggestionService.read",
  )(
    function* (input) {
      const current = yield* settings.getSettings;
      if (!current.composerReplySuggestions) return { text: "" };
      const records = yield* projections.getThreadRecords(input.threadId, ["messages"], {
        messageRoles: ["assistant"],
      });
      const reply = lastAssistantReply(records.messages);
      if (reply === undefined) return { text: "" };
      const settled = (yield* Ref.get(cache)).get(input.threadId);
      if (
        settled !== undefined &&
        settled.messageId === reply.id &&
        DateTime.toEpochMillis(yield* DateTime.now) - settled.storedAt <= SUGGESTION_TTL_MS
      ) {
        return { text: settled.text };
      }
      // The client can see the finished turn before this server's stream subscriber starts the
      // prediction, so give the gate a moment to appear before answering "nothing".
      const deadline = DateTime.toEpochMillis(yield* DateTime.now) + SUGGESTION_GATE_GRACE_MS;
      let gate = (yield* Ref.get(pending)).get(input.threadId);
      while (gate === undefined && DateTime.toEpochMillis(yield* DateTime.now) < deadline) {
        yield* Effect.sleep("100 millis");
        gate = (yield* Ref.get(pending)).get(input.threadId);
      }
      if (gate === undefined) return { text: "" };
      // The prediction for this turn is still running: answer with its result, not with "none yet".
      yield* Deferred.await(gate).pipe(Effect.timeoutOption(SUGGESTION_WAIT_MS));
      const late = (yield* Ref.get(cache)).get(input.threadId);
      return late !== undefined &&
        late.messageId === reply.id &&
        DateTime.toEpochMillis(yield* DateTime.now) - late.storedAt <= SUGGESTION_TTL_MS
        ? { text: late.text }
        : { text: "" };
    },
    Effect.catchCause((cause) =>
      Effect.logDebug("composer suggestion read skipped", { cause }).pipe(Effect.as({ text: "" })),
    ),
  );

  const predict = Effect.fn("ComposerSuggestionService.predict")(function* (input: {
    readonly threadId: ThreadId;
    readonly runId: RunId;
  }) {
    const records = yield* projections.getThreadRecords(
      input.threadId,
      ["messages", "providerTurns", "providerThreads"],
      { messageRoles: ["assistant"] },
    );
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    const target = composerSuggestionTarget(records, input.runId, nowMs);
    if (target === null) return;
    const providerThread = records.providerThreads.find(
      (candidate) => candidate.id === target.providerThreadId,
    );
    if (providerThread === undefined) return;
    const instance = yield* instances.getInstance(records.thread.providerInstanceId);
    const adapter = instance?.orchestrationAdapter;
    const suggestReply = adapter?.suggestComposerReply;
    if (adapter === undefined || suggestReply === undefined) return;
    const result = yield* suggestReply.call(adapter, {
      threadId: input.threadId,
      providerThread,
      instruction: COMPOSER_SUGGESTION_INSTRUCTION,
    });
    const verdict = cleanComposerSuggestion(result.text);
    if (verdict.kind !== "accepted") {
      return yield* Effect.logDebug("composer suggestion declined", {
        threadId: input.threadId,
        verdict: verdict.kind,
        ...(verdict.kind === "rejected" ? { reason: verdict.reason } : {}),
      });
    }
    yield* store(input.threadId, target.reply.id, verdict.text, nowMs);
  });

  const suggest = Effect.fn("ComposerSuggestionService.suggest")(function* (input: {
    readonly threadId: ThreadId;
    readonly runId: RunId;
  }) {
    const current = yield* settings.getSettings;
    if (!current.composerReplySuggestions) return;
    const gate = yield* beginPrediction(input.threadId);
    yield* predict(input).pipe(Effect.ensuring(endPrediction(input.threadId, gate)));
  });

  const start: ComposerSuggestionService["Service"]["start"] = Effect.fn(
    "ComposerSuggestionService.start",
  )(function* () {
    // Keyed by thread: a newer completed run supersedes a prediction still in flight.
    const predictions = yield* FiberMap.make<ThreadId>();
    yield* forkParked(
      Stream.runForEach(orchestrator.streamDomainEvents, (event) =>
        event.type === "run.updated" && event.payload.status === "completed"
          ? FiberMap.run(
              predictions,
              event.threadId,
              suggest({ threadId: event.threadId, runId: event.payload.id }).pipe(
                Effect.catchCause((cause) =>
                  Cause.hasInterruptsOnly(cause)
                    ? Effect.interrupt
                    : Effect.logDebug("composer suggestion skipped", {
                        threadId: event.threadId,
                        cause,
                      }),
                ),
              ),
            )
          : Effect.void,
      ),
    );
  });

  return ComposerSuggestionService.of({ read, start });
});

export const layer = Layer.effect(ComposerSuggestionService, make);
