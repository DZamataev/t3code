import type { ServerProviderUsageLimits, ServerProviderUsageWindow } from "@t3tools/contracts";
import { DEFAULT_TIMEOUT_MS } from "@t3tools/provider-core/server/snapshotProbe";
import {
  clampPercent,
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "@t3tools/provider-core/server/usageLimits";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/http";

// Entries are read one by one: a limit type or window this reader does not know must not hide
// the rest of the payload.
const CodexLbLimit = Schema.Struct({
  limit_type: Schema.String,
  limit_window: Schema.String,
  max_value: Schema.Number,
  current_value: Schema.Number,
  model_filter: Schema.optional(Schema.NullOr(Schema.String)),
  reset_at: Schema.optional(Schema.NullOr(Schema.String)),
  source: Schema.optional(Schema.NullOr(Schema.String)),
});
type CodexLbLimit = typeof CodexLbLimit.Type;
const decodeCodexLbLimit = Schema.decodeUnknownOption(CodexLbLimit);
const CodexLbUsage = Schema.Struct({
  limits: Schema.optional(Schema.NullOr(Schema.Array(Schema.Unknown))),
  upstream_limits: Schema.optional(Schema.NullOr(Schema.Array(Schema.Unknown))),
  account_pool_usage: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        primary: Schema.optional(Schema.NullOr(Schema.Number)),
        secondary: Schema.optional(Schema.NullOr(Schema.Number)),
      }),
    ),
  ),
});
const decodeCodexLbUsage = Schema.decodeUnknownOption(CodexLbUsage);

const WINDOW_SHAPES: Readonly<
  Record<string, Pick<ServerProviderUsageWindow, "kind" | "label" | "windowDurationMins">>
> = {
  "5h": { kind: "session", label: "Session", windowDurationMins: 5 * 60 },
  daily: { kind: "other", label: "Daily", windowDurationMins: 24 * 60 },
  "7d": { kind: "weekly", label: "Weekly", windowDurationMins: 7 * 24 * 60 },
  weekly: { kind: "weekly", label: "Weekly", windowDurationMins: 7 * 24 * 60 },
  monthly: { kind: "monthly", label: "Monthly", windowDurationMins: 30 * 24 * 60 },
};

const LIMIT_TYPE_LABELS: Readonly<Record<string, string>> = {
  credits: "credits",
  total_tokens: "tokens",
  input_tokens: "input tokens",
  output_tokens: "output tokens",
  cost_usd: "spend",
};

function limitWindow(limit: CodexLbLimit, balancer: string): ServerProviderUsageWindow | undefined {
  if (!Number.isFinite(limit.max_value) || limit.max_value <= 0) return undefined;
  // The pool's own windows are what every key spends; a key's limits apply on top of them.
  const scope = limit.source === "aggregate" ? "credits" : `key-${limit.limit_type}`;
  const model = limit.model_filter?.trim();
  const shape = WINDOW_SHAPES[limit.limit_window] ?? {
    kind: "other" as const,
    label: limit.limit_window,
  };
  const typeLabel = LIMIT_TYPE_LABELS[limit.limit_type] ?? limit.limit_type;
  const label =
    limit.source === "aggregate"
      ? `${shape.label.charAt(0).toUpperCase()}${shape.label.slice(1)} ${typeLabel}`
      : `Key ${shape.label.toLowerCase()} ${typeLabel}`;
  const resetsAt = DateTime.make(limit.reset_at ?? "");
  return {
    id: `${balancer}:${scope}-${limit.limit_window}${model ? `-${model}` : ""}`,
    ...shape,
    label: model ? `${label} · ${model}` : label,
    ...(model ? { modelIds: [model] } : {}),
    usedPercent: clampPercent((limit.current_value / limit.max_value) * 100),
    ...(Option.isSome(resetsAt) ? { resetsAt: DateTime.formatIso(resetsAt.value) } : {}),
  };
}

/**
 * Windows of a codex-lb `/v1/usage` answer; undefined when the body is not one. `limits` repeats
 * the pool's windows when the key has none of its own, so equal entries are read once. `balancer`
 * scopes the ids so two balancers never pool their windows together.
 */
export function codexLbUsageToWindows(
  body: unknown,
  balancer: string,
): ReadonlyArray<ServerProviderUsageWindow> | undefined {
  const usage = Option.getOrUndefined(decodeCodexLbUsage(body));
  if (
    usage === undefined ||
    (usage.limits == null && usage.upstream_limits == null && usage.account_pool_usage == null)
  ) {
    return undefined;
  }
  const windows = new Map<string, ServerProviderUsageWindow>();
  for (const entry of [...(usage.upstream_limits ?? []), ...(usage.limits ?? [])]) {
    const limit = Option.getOrUndefined(decodeCodexLbLimit(entry));
    const window = limit && limitWindow(limit, balancer);
    if (window && !windows.has(window.id)) windows.set(window.id, window);
  }
  // codex-lb reports how much the pool's accounts have left; null means it has no reading.
  const pool = usage.account_pool_usage;
  for (const [slot, remaining, shape] of [
    ["session", pool?.primary, WINDOW_SHAPES["5h"]!],
    ["weekly", pool?.secondary, WINDOW_SHAPES["7d"]!],
  ] as const) {
    if (typeof remaining !== "number" || !Number.isFinite(remaining)) continue;
    windows.set(`${balancer}:pool-accounts-${slot}`, {
      id: `${balancer}:pool-accounts-${slot}`,
      ...shape,
      label: `${shape.label} · pool accounts`,
      usedPercent: clampPercent(100 - remaining),
    });
  }
  return [...windows.values()];
}

const MANUAL_REDIRECT: RequestInit = { redirect: "manual" };

// The answer and the key never reach the message; only the failure kind or HTTP status does.
function describeFailure(error: unknown): string {
  if (Cause.isTimeoutError(error)) return "The usage limits URL did not answer in time.";
  if (HttpClientError.isHttpClientError(error) && error.reason._tag === "StatusCodeError") {
    return `The usage limits URL answered with HTTP ${error.reason.response.status}.`;
  }
  return "The usage limits URL could not be read.";
}

/** Limits of a Codex instance whose model provider is a codex-lb balancer. */
export const readCodexLbUsageLimits = Effect.fn("readCodexLbUsageLimits")(function* (input: {
  readonly url: string;
  /** The env var the model provider reads its API key from, named by its `env_key`. */
  readonly apiKeyEnv: string | undefined;
  readonly environment: NodeJS.ProcessEnv;
  readonly checkedAt: string;
}): Effect.fn.Return<ServerProviderUsageLimits, never, HttpClient.HttpClient> {
  const unavailable = (message: string) =>
    makeUnavailableUsageLimits({ checkedAt: input.checkedAt, reason: "probeFailed", message });
  if (input.apiKeyEnv === undefined) {
    return unavailable("Codex usage limits need a model provider with an env_key API key.");
  }
  const apiKey = input.environment[input.apiKeyEnv]?.trim();
  if (!apiKey) {
    return unavailable(`Codex usage limits need ${input.apiKeyEnv} on this instance.`);
  }
  const url = URL.canParse(input.url) ? new URL(input.url) : null;
  if (!url || !/^https?:$/.test(url.protocol)) {
    return unavailable("The usage limits URL is not valid.");
  }
  // Protocol is not part of it, so http and https on one host name the same balancer.
  const path = url.pathname.replace(/\/v1\/usage\/?$/, "").replace(/\/$/, "");
  const balancer = `${url.host}${path}`;
  const client = yield* HttpClient.HttpClient;
  const body = yield* client
    .execute(
      HttpClientRequest.get(input.url).pipe(
        HttpClientRequest.setHeaders({
          accept: "application/json",
          authorization: `Bearer ${apiKey}`,
        }),
      ),
    )
    .pipe(
      // A redirect would carry the key to whatever host the Location names.
      Effect.provideService(FetchHttpClient.RequestInit, MANUAL_REDIRECT),
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap((response) => response.json),
      Effect.timeout(DEFAULT_TIMEOUT_MS),
      Effect.result,
    );
  if (Result.isFailure(body)) return unavailable(describeFailure(body.failure));
  const windows = codexLbUsageToWindows(body.success, balancer);
  if (windows === undefined) {
    return unavailable("The usage limits URL did not answer with codex-lb usage JSON.");
  }
  if (windows.length === 0) return unavailable("The usage limits URL reported no limits.");
  return makeUsageLimits({ checkedAt: input.checkedAt, windows });
});
