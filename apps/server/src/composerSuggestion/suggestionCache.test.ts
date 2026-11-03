import { assert, describe, it } from "@effect/vitest";
import { RunId, ThreadId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import { makeSuggestionCache } from "./suggestionCache.ts";

const threadId = ThreadId.make("thread-1");
const firstRun = RunId.make("run-1");
const secondRun = RunId.make("run-2");

/** A prediction the test finishes by hand, and a signal that it has started. */
const heldPrediction = Effect.gen(function* () {
  const started = yield* Deferred.make<void>();
  const answer = yield* Deferred.make<string>();
  const predict = Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(answer)));
  return { started, answer, predict };
});

describe("suggestion cache", () => {
  it.effect("answers a read that arrives mid-prediction with that prediction", () =>
    Effect.gen(function* () {
      const cache = yield* makeSuggestionCache;
      const held = yield* heldPrediction;
      yield* cache.track(threadId, firstRun, held.predict).pipe(Effect.forkChild);
      yield* Deferred.await(held.started);

      const reader = yield* cache.read(threadId, firstRun).pipe(Effect.forkChild);
      yield* Deferred.succeed(held.answer, "Run the tests");

      assert.equal(yield* Fiber.join(reader), "Run the tests");
    }),
  );

  it.effect("waits for a prediction that starts after the read", () =>
    Effect.gen(function* () {
      const cache = yield* makeSuggestionCache;
      const reader = yield* cache.read(threadId, firstRun).pipe(Effect.forkChild);
      const held = yield* heldPrediction;
      yield* cache.track(threadId, firstRun, held.predict).pipe(Effect.forkChild);
      yield* Deferred.await(held.started);
      yield* TestClock.adjust("100 millis");
      yield* Deferred.succeed(held.answer, "Commit this");

      assert.equal(yield* Fiber.join(reader), "Commit this");
    }),
  );

  it.effect("answers a skipped run at once instead of waiting", () =>
    Effect.gen(function* () {
      const cache = yield* makeSuggestionCache;
      yield* cache.track(threadId, firstRun, Effect.succeed(""));

      assert.equal(yield* cache.read(threadId, firstRun), "");
    }),
  );

  it.effect("never answers one run's read with another run's suggestion", () =>
    Effect.gen(function* () {
      const cache = yield* makeSuggestionCache;
      yield* cache.track(threadId, firstRun, Effect.succeed("Old suggestion"));
      yield* cache.track(threadId, secondRun, Effect.succeed("New suggestion"));

      assert.equal(yield* cache.read(threadId, secondRun), "New suggestion");
      const stale = yield* cache.read(threadId, firstRun).pipe(Effect.forkChild);
      yield* TestClock.adjust("2 seconds");
      assert.equal(yield* Fiber.join(stale), "");
    }),
  );

  it.effect("releases a waiting read when its prediction is interrupted", () =>
    Effect.gen(function* () {
      const cache = yield* makeSuggestionCache;
      const held = yield* heldPrediction;
      const prediction = yield* cache
        .track(threadId, firstRun, held.predict)
        .pipe(Effect.forkChild);
      yield* Deferred.await(held.started);
      const reader = yield* cache.read(threadId, firstRun).pipe(Effect.forkChild);

      yield* Fiber.interrupt(prediction);
      yield* TestClock.adjust("2 seconds");

      assert.equal(yield* Fiber.join(reader), "");
    }),
  );

  it.effect("forgets a suggestion the user walked away from", () =>
    Effect.gen(function* () {
      const cache = yield* makeSuggestionCache;
      yield* cache.track(threadId, firstRun, Effect.succeed("Run the tests"));
      yield* TestClock.adjust("16 minutes");

      assert.equal(yield* cache.read(threadId, firstRun), "");
    }),
  );
});
