import {
  OrchestrationV2SuggestComposerReplyError,
  type OrchestrationV2SuggestComposerReplyResult,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
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
import { composerSuggestionForkMissedCache, composerSuggestionTarget } from "./decide.ts";
import { cleanComposerSuggestion } from "./filter.ts";
import { COMPOSER_SUGGESTION_INSTRUCTION } from "./instruction.ts";
import { makeSuggestionCache, PREDICTION_CEILING_MS } from "./suggestionCache.ts";

/**
 * Predicts the user's next message after each completed run by forking the finished session, so
 * the provider's prompt cache covers the conversation and only the instruction is new input. It
 * lives in memory, never in the event log: chrome around the next turn, not conversation.
 */
export class ComposerSuggestionService extends Context.Service<
  ComposerSuggestionService,
  {
    readonly read: (input: {
      readonly threadId: ThreadId;
      readonly runId: RunId;
    }) => Effect.Effect<
      OrchestrationV2SuggestComposerReplyResult,
      OrchestrationV2SuggestComposerReplyError
    >;
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/composerSuggestion/ComposerSuggestionService") {}

const skipUnlessInterrupted = (threadId: ThreadId) => (cause: Cause.Cause<unknown>) =>
  Cause.hasInterruptsOnly(cause)
    ? Effect.interrupt
    : Effect.logDebug("composer suggestion skipped", { threadId, cause });

const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const settings = yield* ServerSettings.ServerSettingsService;
  const instances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const cache = yield* makeSuggestionCache;
  // A fork that missed the cache paid for the whole thread and will keep missing: the request no
  // longer matches the session's. Those threads stop predicting until the server restarts.
  const uncacheable = yield* Ref.make(new Set<ThreadId>());

  const read: ComposerSuggestionService["Service"]["read"] = Effect.fn(
    "ComposerSuggestionService.read",
  )(
    function* (input) {
      const current = yield* settings.getSettings;
      if (!current.composerReplySuggestions) return { text: "" };
      return { text: yield* cache.read(input.threadId, input.runId) };
    },
    Effect.catchCause((cause) =>
      Effect.logDebug("composer suggestion read skipped", { cause }).pipe(Effect.as({ text: "" })),
    ),
  );

  const predict = Effect.fn("ComposerSuggestionService.predict")(function* (input: {
    readonly threadId: ThreadId;
    readonly runId: RunId;
  }) {
    if ((yield* Ref.get(uncacheable)).has(input.threadId)) return "";
    const records = yield* projections.getThreadRecords(
      input.threadId,
      ["messages", "providerTurns", "providerThreads"],
      { messageRoles: ["assistant"] },
    );
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    const target = composerSuggestionTarget(records, input.runId, nowMs);
    if (target === null) return "";
    const providerThread = records.providerThreads.find(
      (candidate) => candidate.id === target.providerThreadId,
    );
    if (providerThread === undefined) return "";
    const instance = yield* instances.getInstance(records.thread.providerInstanceId);
    const adapter = instance?.orchestrationAdapter;
    const suggestReply = adapter?.suggestComposerReply;
    if (adapter === undefined || suggestReply === undefined) return "";
    const result = yield* suggestReply.call(adapter, {
      threadId: input.threadId,
      providerThread,
      instruction: COMPOSER_SUGGESTION_INSTRUCTION,
    });
    if (composerSuggestionForkMissedCache(result.cachedInputTokens, target.promptTokens)) {
      yield* Ref.update(uncacheable, (current) => new Set(current).add(input.threadId));
      yield* Effect.logWarning("composer suggestion missed the prompt cache; thread paused", {
        threadId: input.threadId,
        cachedInputTokens: result.cachedInputTokens,
        promptTokens: target.promptTokens,
      });
    }
    const verdict = cleanComposerSuggestion(result.text);
    if (verdict.kind === "accepted") return verdict.text;
    yield* Effect.logDebug("composer suggestion declined", {
      threadId: input.threadId,
      verdict: verdict.kind,
      ...(verdict.kind === "rejected" ? { reason: verdict.reason } : {}),
    });
    return "";
  });

  const start: ComposerSuggestionService["Service"]["start"] = Effect.fn(
    "ComposerSuggestionService.start",
  )(function* () {
    // Keyed by thread: a newer completed run interrupts a prediction still in flight.
    const predictions = yield* FiberMap.make<ThreadId>();
    yield* forkParked(
      Stream.runForEach(orchestrator.streamDomainEvents, (event) =>
        event.type === "run.updated" && event.payload.status === "completed"
          ? FiberMap.run(
              predictions,
              event.threadId,
              Effect.gen(function* () {
                if (!(yield* settings.getSettings).composerReplySuggestions) return;
                // A failed prediction is still an answer: "nothing", so its readers stop waiting.
                yield* cache.track(
                  event.threadId,
                  event.payload.id,
                  predict({ threadId: event.threadId, runId: event.payload.id }).pipe(
                    Effect.timeout(PREDICTION_CEILING_MS),
                    Effect.catchCause((cause) =>
                      skipUnlessInterrupted(event.threadId)(cause).pipe(Effect.as("")),
                    ),
                  ),
                );
              }).pipe(Effect.catchCause(skipUnlessInterrupted(event.threadId))),
            )
          : Effect.void,
      ),
    );
  });

  return ComposerSuggestionService.of({ read, start });
});

export const layer = Layer.effect(ComposerSuggestionService, make);
