import { describe, expect, it } from "@effect/vitest";
import { MessageId, ProviderThreadId, RunId } from "@t3tools/contracts";

import {
  composerSuggestionCacheIsWarm,
  composerSuggestionTarget,
  lastAssistantReply,
  type ComposerSuggestionMessage,
  type ComposerSuggestionRecords,
  type ComposerSuggestionTurn,
} from "./decide.ts";

const NOW_MS = Date.parse("2026-11-03T12:00:00.000Z");

const runId = RunId.make("run-1");
const otherRunId = RunId.make("run-2");
const providerThreadId = ProviderThreadId.make("provider-thread");

const userMessage: ComposerSuggestionMessage = {
  id: MessageId.make("message-user"),
  role: "user",
  runId,
  streaming: false,
  text: "Fix the parser and run the tests.",
};

const reply = (over: Partial<ComposerSuggestionMessage> = {}): ComposerSuggestionMessage => ({
  id: MessageId.make("message-reply"),
  role: "assistant",
  runId,
  streaming: false,
  text: "Fixed the parser. Want me to run the tests?",
  ...over,
});

const turn = (over: Partial<ComposerSuggestionTurn> = {}): ComposerSuggestionTurn => ({
  providerThreadId,
  status: "completed",
  ordinal: 1,
  tokenUsage: {
    inputTokens: 400,
    cachedInputTokens: 30_000,
    promptCacheExpiresAt: "2026-11-03T12:02:00.000Z",
    updatedAt: "2026-11-03T12:00:00.000Z",
  },
  ...over,
});

const records = (
  over: Partial<Omit<ComposerSuggestionRecords, "thread">> & {
    readonly thread?: Partial<ComposerSuggestionRecords["thread"]>;
  } = {},
): ComposerSuggestionRecords => ({
  thread: {
    archivedAt: null,
    activeProviderThreadId: providerThreadId,
    lineage: { relationshipToParent: null },
    ...over.thread,
  },
  messages: over.messages ?? [userMessage, reply()],
  providerTurns: over.providerTurns ?? [turn()],
  providerThreads: over.providerThreads ?? [
    { id: providerThreadId, nativeThreadRef: { nativeId: "session-1" } },
  ],
});

const target = (over?: Parameters<typeof records>[0], currentRunId = runId, nowMs = NOW_MS) =>
  composerSuggestionTarget(records(over), currentRunId, nowMs);

describe("composerSuggestionTarget", () => {
  it("follows the reply that closed the run", () => {
    expect(target()?.reply.id).toBe("message-reply");
  });

  it("ignores a thread with nothing to follow", () => {
    expect(target({ messages: [userMessage] })).toBeNull();
    expect(target({ messages: [userMessage, reply({ streaming: true })] })).toBeNull();
    expect(target({ messages: [userMessage, reply({ text: "   " })] })).toBeNull();
    expect(target({ messages: [userMessage, reply({ role: "user" })] })).toBeNull();
  });

  it("only follows the run that just finished", () => {
    expect(target(undefined, otherRunId)).toBeNull();
  });

  it("skips archived threads and subagent threads", () => {
    expect(target({ thread: { archivedAt: "2026-11-03T12:00:00.000Z" } })).toBeNull();
    expect(target({ thread: { lineage: { relationshipToParent: "subagent" } } })).toBeNull();
  });

  it("needs the thread's live native session", () => {
    expect(target({ providerThreads: [] })).toBeNull();
    expect(
      target({ providerThreads: [{ id: providerThreadId, nativeThreadRef: null }] }),
    ).toBeNull();
    expect(
      target({ thread: { activeProviderThreadId: ProviderThreadId.make("other-thread") } }),
    ).toBeNull();
  });

  it("needs a completed turn with reported usage", () => {
    expect(target({ providerTurns: [] })).toBeNull();
    expect(target({ providerTurns: [turn({ status: "failed" })] })).toBeNull();
    expect(target({ providerTurns: [turn({ tokenUsage: undefined })] })).toBeNull();
  });

  it("reads the latest completed turn, not the first", () => {
    const earlier = turn({
      ordinal: 1,
      tokenUsage: {
        inputTokens: 1,
        cachedInputTokens: 1,
        updatedAt: "2026-11-03T12:00:00.000Z",
      },
    });
    const latest = turn({
      ordinal: 2,
      tokenUsage: {
        inputTokens: 400,
        cachedInputTokens: 30_000,
        promptCacheExpiresAt: "2026-11-03T12:02:00.000Z",
        updatedAt: "2026-11-03T12:00:00.000Z",
      },
    });
    expect(target({ providerTurns: [latest, earlier] })?.reply.id).toBe("message-reply");
    expect(composerSuggestionCacheIsWarm(turn({ ordinal: 2 }), NOW_MS + 10 * 60_000)).toBe(false);
  });
});

describe("composerSuggestionCacheIsWarm", () => {
  it("needs a reported cache hit", () => {
    expect(
      composerSuggestionCacheIsWarm(
        turn({
          tokenUsage: {
            inputTokens: 30_000,
            cachedInputTokens: 0,
            updatedAt: "2026-11-03T12:00:00.000Z",
          },
        }),
        NOW_MS,
      ),
    ).toBe(false);
  });

  it("stops at the prefix ceiling", () => {
    expect(
      composerSuggestionCacheIsWarm(
        turn({
          tokenUsage: {
            inputTokens: 10_000,
            cachedInputTokens: 150_001,
            promptCacheExpiresAt: "2026-11-03T12:02:00.000Z",
            updatedAt: "2026-11-03T12:00:00.000Z",
          },
        }),
        NOW_MS,
      ),
    ).toBe(false);
  });

  it("stops once the reported cache expires", () => {
    expect(composerSuggestionCacheIsWarm(turn(), NOW_MS + 180_000)).toBe(false);
  });

  it("falls back to the five-minute default when no expiry is reported", () => {
    const usage = {
      inputTokens: 400,
      cachedInputTokens: 30_000,
      updatedAt: "2026-11-03T12:00:00.000Z",
    };
    expect(composerSuggestionCacheIsWarm(turn({ tokenUsage: usage }), NOW_MS + 60_000)).toBe(true);
    expect(composerSuggestionCacheIsWarm(turn({ tokenUsage: usage }), NOW_MS + 6 * 60_000)).toBe(
      false,
    );
  });

  it("treats an unparseable expiry as cold", () => {
    expect(
      composerSuggestionCacheIsWarm(
        turn({
          tokenUsage: {
            inputTokens: 1,
            cachedInputTokens: 1,
            promptCacheExpiresAt: "not a date",
            updatedAt: "also not a date",
          },
        }),
        NOW_MS,
      ),
    ).toBe(false);
  });
});

describe("lastAssistantReply", () => {
  it("returns the final assistant reply with text", () => {
    expect(
      lastAssistantReply([userMessage, reply(), reply({ id: MessageId.make("later") })])?.id,
    ).toBe("later");
    expect(lastAssistantReply([reply({ streaming: true })])).toBeUndefined();
  });
});
