import type {
  MessageId,
  OrchestrationV2PendingBackgroundTask,
  ProviderThreadId,
  RunId,
} from "@t3tools/contracts";
import { backgroundWorkHoldsCompletion } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";

/** Only the fields a suggestion decision reads; the projections carry more. */
export interface ComposerSuggestionMessage {
  readonly id: MessageId;
  readonly role: string;
  readonly runId: RunId | null;
  readonly streaming: boolean;
  readonly text: string;
}

export interface ComposerSuggestionTurn {
  readonly providerThreadId: ProviderThreadId;
  readonly status: string;
  readonly ordinal: number;
  readonly tokenUsage?:
    | {
        readonly cachedInputTokens?: number | undefined;
        readonly inputTokens?: number | undefined;
        readonly promptCacheExpiresAt?: string | undefined;
      }
    | undefined;
}

export interface ComposerSuggestionProviderThread {
  readonly id: ProviderThreadId;
  readonly nativeThreadRef: object | null;
}

export interface ComposerSuggestionRecords {
  readonly thread: {
    readonly archivedAt: unknown;
    readonly activeProviderThreadId: ProviderThreadId | null;
    readonly lineage: { readonly relationshipToParent: string | null };
    /** Work the agent started and will be woken by, from the thread shell. */
    readonly pendingBackgroundTasks: ReadonlyArray<
      Pick<OrchestrationV2PendingBackgroundTask, "kind" | "awaited">
    >;
  };
  readonly messages: ReadonlyArray<ComposerSuggestionMessage>;
  readonly providerTurns: ReadonlyArray<ComposerSuggestionTurn>;
  readonly providerThreads: ReadonlyArray<ComposerSuggestionProviderThread>;
}

const isAssistantReply = (
  message: ComposerSuggestionMessage,
): message is ComposerSuggestionMessage & { readonly runId: RunId } =>
  message.role === "assistant" &&
  !message.streaming &&
  message.runId !== null &&
  message.text.trim().length > 0;

const lastAssistantReplyOfRun = (
  messages: ReadonlyArray<ComposerSuggestionMessage>,
  runId: RunId,
): ComposerSuggestionMessage | undefined =>
  messages.filter((message) => isAssistantReply(message) && message.runId === runId).at(-1);

const isNativeSession = (thread: ComposerSuggestionProviderThread): boolean =>
  thread.nativeThreadRef !== null;

const latestCompletedTurn = (
  turns: ReadonlyArray<ComposerSuggestionTurn>,
  providerThreadId: ProviderThreadId,
): ComposerSuggestionTurn | undefined =>
  turns.reduce<ComposerSuggestionTurn | undefined>(
    (latest, turn) =>
      turn.providerThreadId !== providerThreadId || turn.status !== "completed"
        ? latest
        : latest === undefined || turn.ordinal > latest.ordinal
          ? turn
          : latest,
    undefined,
  );

/** A fork takes seconds to reach the provider; a cache about to expire would be gone by then. */
const CACHE_EXPIRY_MARGIN_MS = 30_000;

/**
 * Whether the finished turn left a cache a forked request can still read. A turn that only wrote
 * its prefix (the first one after a pause) leaves a warm cache too, so what matters is the lifetime
 * the provider reported, not whether that turn itself read anything.
 */
export function composerSuggestionCacheIsWarm(
  turn: ComposerSuggestionTurn,
  nowMs: number,
): boolean {
  const usage = turn.tokenUsage;
  if (usage === undefined || usage.promptCacheExpiresAt === undefined) return false;
  const expiresAt = Date.parse(usage.promptCacheExpiresAt);
  return Number.isFinite(expiresAt) && expiresAt - nowMs > CACHE_EXPIRY_MARGIN_MS;
}

/**
 * Whether a fork paid for most of its thread in full: it should read about the whole prompt of the
 * turn it follows (`inputTokens` counts the cached part too) from cache. A thread has no size limit,
 * so a miss on a long one is the expensive case. Unreported usage is unknown, not a miss.
 */
export const composerSuggestionForkMissedCache = (
  cachedInputTokens: number | undefined,
  turnPromptTokens: number,
): boolean => cachedInputTokens !== undefined && cachedInputTokens < turnPromptTokens / 2;

/**
 * The turn a suggestion would follow, or null when predicting it is pointless or unsafe: no
 * assistant reply, an agent that will carry on by itself once its own background work reports,
 * no live native session, or a cache that is cold or unreported.
 */
export function composerSuggestionTarget(
  records: ComposerSuggestionRecords,
  runId: RunId,
  nowMs: number,
): {
  readonly reply: ComposerSuggestionMessage;
  readonly providerThreadId: ProviderThreadId;
  /** The whole prompt of the turn's last request, which a fork should read back from cache. */
  readonly promptTokens: number;
} | null {
  const thread = records.thread;
  if (thread.archivedAt !== null || thread.lineage.relationshipToParent === "subagent") return null;
  if (backgroundWorkHoldsCompletion(thread.pendingBackgroundTasks)) return null;
  const reply = lastAssistantReplyOfRun(records.messages, runId);
  if (reply === undefined) return null;
  const providerThread = records.providerThreads.find(
    (candidate) => candidate.id === thread.activeProviderThreadId && isNativeSession(candidate),
  );
  if (providerThread === undefined) return null;
  const turn = latestCompletedTurn(records.providerTurns, providerThread.id);
  if (turn === undefined || !composerSuggestionCacheIsWarm(turn, nowMs)) return null;
  return {
    providerThreadId: providerThread.id,
    reply,
    promptTokens: turn.tokenUsage?.inputTokens ?? 0,
  };
}
