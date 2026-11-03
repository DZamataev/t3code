import type { MessageId, ProviderThreadId, RunId } from "@t3tools/contracts";

/**
 * A forked turn reads the whole thread prefix at the cache-read rate, so a long thread costs real
 * money per suggestion. Past this prefix a turn predicts nothing.
 */
const MAX_SUGGESTION_PREFIX_TOKENS = 60_000;

/** Anthropic's default prompt-cache lifetime, used when the turn reports no cache expiry. */
const FALLBACK_CACHE_TTL_MS = 5 * 60_000;

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
        readonly updatedAt: string;
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

/** The reply that closed the thread's latest run, which is the text a suggestion follows. */
export function lastAssistantReply(
  messages: ReadonlyArray<ComposerSuggestionMessage>,
): ComposerSuggestionMessage | undefined {
  return messages.filter((message) => isAssistantReply(message)).at(-1);
}

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

/**
 * Whether the finished turn left a cache a forked request can still read: the provider reported
 * cache hits, the prefix stays under the cost ceiling, and the cache has not expired.
 */
export function composerSuggestionCacheIsWarm(
  turn: ComposerSuggestionTurn,
  nowMs: number,
): boolean {
  const usage = turn.tokenUsage;
  if (usage === undefined) return false;
  const cachedInputTokens = usage.cachedInputTokens ?? 0;
  if (cachedInputTokens <= 0) return false;
  if ((usage.inputTokens ?? 0) + cachedInputTokens > MAX_SUGGESTION_PREFIX_TOKENS) return false;
  const expiresAt =
    usage.promptCacheExpiresAt === undefined
      ? Date.parse(usage.updatedAt) + FALLBACK_CACHE_TTL_MS
      : Date.parse(usage.promptCacheExpiresAt);
  return Number.isFinite(expiresAt) && expiresAt > nowMs;
}

/**
 * The turn a suggestion would follow, or null when predicting it is pointless or unsafe: no
 * assistant reply, no live native session, or a cache that is cold, unreported, or too large.
 */
export function composerSuggestionTarget(
  records: ComposerSuggestionRecords,
  runId: RunId,
  nowMs: number,
): {
  readonly reply: ComposerSuggestionMessage;
  readonly providerThreadId: ProviderThreadId;
} | null {
  const thread = records.thread;
  if (thread.archivedAt !== null || thread.lineage.relationshipToParent === "subagent") return null;
  const reply = lastAssistantReplyOfRun(records.messages, runId);
  if (reply === undefined) return null;
  const providerThread = records.providerThreads.find(
    (candidate) => candidate.id === thread.activeProviderThreadId && isNativeSession(candidate),
  );
  if (providerThread === undefined) return null;
  const turn = latestCompletedTurn(records.providerTurns, providerThread.id);
  if (turn === undefined || !composerSuggestionCacheIsWarm(turn, nowMs)) return null;
  return { providerThreadId: providerThread.id, reply };
}
