import type { RunId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

/** A suggestion older than this describes a conversation the user has since walked away from. */
const SUGGESTION_TTL_MS = 15 * 60_000;

/** Threads kept in memory; older entries fall out first. */
const MAX_CACHED_THREADS = 200;

/** The longest a prediction may run; a cold CLI start alone has taken over 20 s. */
export const PREDICTION_CEILING_MS = 90_000;

/**
 * Outlasts the prediction it waits for: a read that gave up early would answer "nothing", and the
 * client asks about each run only once.
 */
const SUGGESTION_WAIT_MS = PREDICTION_CEILING_MS + 5_000;

/** The client can see a finished run before the server's own subscriber starts predicting it. */
const SUGGESTION_START_GRACE_MS = 2_000;

interface Settled {
  readonly runId: RunId;
  /** Empty when the run was skipped or the model declined: still an answer, so reads stop waiting. */
  readonly text: string;
  readonly storedAt: number;
}

interface Pending {
  readonly runId: RunId;
  readonly done: Deferred.Deferred<void>;
}

/**
 * One suggestion per thread, for the run it follows. Reads name the run they are about, so an answer
 * for an older or newer run is never shown, and a read that outraces its prediction waits for it.
 */
export const makeSuggestionCache = Effect.gen(function* () {
  const settled = yield* Ref.make(new Map<ThreadId, Settled>());
  const pending = yield* Ref.make(new Map<ThreadId, Pending>());
  const nowMs = Effect.map(DateTime.now, DateTime.toEpochMillis);

  const store = Effect.fnUntraced(function* (threadId: ThreadId, runId: RunId, text: string) {
    const storedAt = yield* nowMs;
    yield* Ref.update(settled, (current) => {
      const next = new Map(current);
      next.delete(threadId);
      next.set(threadId, { runId, text, storedAt });
      while (next.size > MAX_CACHED_THREADS) {
        const oldest = next.keys().next().value;
        if (oldest === undefined) break;
        next.delete(oldest);
      }
      return next;
    });
  });

  const lookup = Effect.fnUntraced(function* (threadId: ThreadId, runId: RunId) {
    const entry = (yield* Ref.get(settled)).get(threadId);
    if (entry === undefined || entry.runId !== runId) return undefined;
    return (yield* nowMs) - entry.storedAt <= SUGGESTION_TTL_MS ? entry.text : "";
  });

  const pendingFor = (threadId: ThreadId, runId: RunId) =>
    Ref.get(pending).pipe(
      Effect.map((current) => {
        const entry = current.get(threadId);
        return entry?.runId === runId ? entry : undefined;
      }),
    );

  /**
   * Runs one run's prediction and records its outcome. A newer run's prediction replaces the
   * pending entry; the caller interrupts the older one, and its readers then answer "nothing".
   */
  const track = Effect.fnUntraced(function* <E, R>(
    threadId: ThreadId,
    runId: RunId,
    predict: Effect.Effect<string, E, R>,
  ) {
    const done = yield* Deferred.make<void>();
    const replaced = yield* Ref.modify(pending, (current) => {
      const next = new Map(current);
      const previous = next.get(threadId);
      next.set(threadId, { runId, done });
      return [previous, next] as const;
    });
    if (replaced !== undefined) yield* Deferred.succeed(replaced.done, undefined);
    const release = Ref.update(pending, (current) => {
      if (current.get(threadId)?.done !== done) return current;
      const next = new Map(current);
      next.delete(threadId);
      return next;
    }).pipe(Effect.andThen(Deferred.succeed(done, undefined)));
    return yield* predict.pipe(
      Effect.flatMap((text) => store(threadId, runId, text)),
      Effect.ensuring(release),
    );
  });

  const read = Effect.fnUntraced(function* (threadId: ThreadId, runId: RunId) {
    const known = yield* lookup(threadId, runId);
    if (known !== undefined) return known;
    let running = yield* pendingFor(threadId, runId);
    const deadline = (yield* nowMs) + SUGGESTION_START_GRACE_MS;
    while (running === undefined && (yield* nowMs) < deadline) {
      yield* Effect.sleep("100 millis");
      const late = yield* lookup(threadId, runId);
      if (late !== undefined) return late;
      running = yield* pendingFor(threadId, runId);
    }
    if (running === undefined) return "";
    yield* Deferred.await(running.done).pipe(Effect.timeoutOption(SUGGESTION_WAIT_MS));
    return (yield* lookup(threadId, runId)) ?? "";
  });

  return { read, track };
});
