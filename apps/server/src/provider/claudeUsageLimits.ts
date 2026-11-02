import type { SDKControlGetUsageResponse, SDKRateLimitInfo } from "@anthropic-ai/claude-agent-sdk";
import type {
  ProviderUsageLimitsUpdate,
  ServerProviderUsageLimits,
  ServerProviderUsageWindow,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import {
  clampPercent,
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "@t3tools/provider-core/server/usageLimits";

const SESSION_MINS = 5 * 60;
const WEEK_MINS = 7 * 24 * 60;

const WINDOWS: Readonly<
  Record<string, Pick<ServerProviderUsageWindow, "kind" | "label" | "windowDurationMins">>
> = {
  five_hour: { kind: "session", label: "Session", windowDurationMins: SESSION_MINS },
  seven_day: { kind: "weekly", label: "Weekly", windowDurationMins: WEEK_MINS },
};

/** Reuse probed display names for streamed bucket types so mid-turn updates target the same row. */
const OVERAGE_INCLUDED_EVENT_TYPE = "seven_day_overage_included";

// The SDK does not yet type the spend budget returned by `get_usage`.
const SpendMoney = Schema.Struct({
  amount_minor: Schema.Natural,
  currency: Schema.NonEmptyString,
  exponent: Schema.Natural,
});
const decodeSpendBudget = Schema.decodeUnknownOption(
  Schema.Struct({ enabled: Schema.Boolean, used: SpendMoney, limit: SpendMoney }),
);

export interface ClaudeScopedLimitNames {
  readonly overageIncluded: string | undefined;
}

export const makeClaudeScopedLimitNames = Ref.make<ClaudeScopedLimitNames>({
  overageIncluded: undefined,
});

function scopedWindowId(displayName: string): string {
  return `seven_day_${displayName.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`;
}

function scopedWindow(
  displayName: string,
  usedPercent: number,
  resetsAt: string | undefined,
): ServerProviderUsageWindow {
  return {
    id: scopedWindowId(displayName),
    kind: "weekly",
    label: `Weekly · ${displayName}`,
    windowDurationMins: WEEK_MINS,
    usedPercent: clampPercent(usedPercent),
    ...(resetsAt ? { resetsAt } : {}),
  };
}

function percentFromAmounts(used: number | null | undefined, limit: number | null | undefined) {
  if (
    typeof used !== "number" ||
    typeof limit !== "number" ||
    !Number.isFinite(used) ||
    !Number.isFinite(limit) ||
    used < 0 ||
    limit <= 0
  ) {
    return undefined;
  }
  const percent = (used / limit) * 100;
  return Number.isFinite(percent) ? clampPercent(percent) : undefined;
}

function readSpendPercent(rateLimits: NonNullable<SDKControlGetUsageResponse["rate_limits"]>) {
  const spend = Option.getOrUndefined(
    decodeSpendBudget((rateLimits as { readonly spend?: unknown }).spend),
  );
  // Minor-unit ratios require matching currency and scale; spend.percent is rounded.
  if (
    spend?.enabled &&
    spend.used.currency.trim().length > 0 &&
    spend.used.currency.trim() === spend.limit.currency.trim() &&
    spend.used.exponent === spend.limit.exponent
  ) {
    const percent = percentFromAmounts(spend.used.amount_minor, spend.limit.amount_minor);
    if (percent !== undefined) return percent;
  }

  const extra = rateLimits.extra_usage;
  if (extra?.is_enabled !== true) return undefined;
  const percent = percentFromAmounts(extra.used_credits, extra.monthly_limit) ?? extra.utilization;
  return typeof percent === "number" && Number.isFinite(percent) && percent >= 0
    ? clampPercent(percent)
    : undefined;
}

/**
 * `model_scoped` shipped in the CLI after the SDK typings we pin, so it is
 * read structurally until the `.d.ts` catches up.
 */
interface ModelScopedWindow {
  readonly display_name: string;
  readonly utilization: number | null;
  readonly resets_at: string | null;
}

function readModelScoped(rateLimits: object): ReadonlyArray<ModelScopedWindow> {
  const raw = (rateLimits as { readonly model_scoped?: unknown }).model_scoped;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (entry): entry is ModelScopedWindow =>
      typeof entry === "object" &&
      entry !== null &&
      typeof (entry as ModelScopedWindow).display_name === "string",
  );
}

function isoFromEpochSeconds(value: number | undefined): string | undefined {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return undefined;
  const dt = DateTime.make(value * 1000);
  return Option.isSome(dt) ? DateTime.formatIso(dt.value) : undefined;
}

function isoFromString(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const dt = DateTime.make(value);
  return Option.isSome(dt) ? DateTime.formatIso(dt.value) : undefined;
}

function makeWindow(
  id: keyof typeof WINDOWS & string,
  usedPercent: number,
  resetsAt: string | undefined,
): ServerProviderUsageWindow {
  const window = WINDOWS[id]!;
  return {
    id,
    ...window,
    usedPercent: clampPercent(usedPercent),
    ...(resetsAt ? { resetsAt } : {}),
  };
}

/** Stream utilization is 0-1. Drop unnamed overage buckets until probed to avoid unreconcilable rows. */
export function claudeRateLimitEventToUpdate(
  info: SDKRateLimitInfo,
  names: ClaudeScopedLimitNames,
): ProviderUsageLimitsUpdate | undefined {
  const type: string | undefined = info.rateLimitType;
  if (!type || typeof info.utilization !== "number") {
    return undefined;
  }
  const usedPercent = info.utilization * 100;
  const resetsAt = isoFromEpochSeconds(info.resetsAt);
  if (type in WINDOWS) {
    return { windows: [makeWindow(type, usedPercent, resetsAt)] };
  }
  if (type === OVERAGE_INCLUDED_EVENT_TYPE && names.overageIncluded) {
    return { windows: [scopedWindow(names.overageIncluded, usedPercent, resetsAt)] };
  }
  return undefined;
}

/** get_usage percentages are already 0-100. */
export function claudeUsageResponseToLimits(input: {
  readonly response: Pick<SDKControlGetUsageResponse, "rate_limits_available" | "rate_limits">;
  readonly checkedAt: string;
}): { readonly limits: ServerProviderUsageLimits; readonly names: ClaudeScopedLimitNames } {
  const { response, checkedAt } = input;
  if (!response.rate_limits_available || !response.rate_limits) {
    return {
      limits: makeUnavailableUsageLimits({
        checkedAt,
        reason: response.rate_limits_available ? "probeFailed" : "unsupported",
      }),
      names: { overageIncluded: undefined },
    };
  }
  const windows: ServerProviderUsageWindow[] = [];
  for (const id of Object.keys(WINDOWS)) {
    const window = response.rate_limits[id as "five_hour" | "seven_day"];
    if (!window || typeof window.utilization !== "number") continue;
    windows.push(makeWindow(id, window.utilization, isoFromString(window.resets_at)));
  }
  // The CLI's overage allowlist currently has one model; events refer to its first entry.
  let overageIncluded: string | undefined;
  for (const entry of readModelScoped(response.rate_limits)) {
    if (typeof entry.utilization !== "number") continue;
    windows.push(
      scopedWindow(entry.display_name, entry.utilization, isoFromString(entry.resets_at)),
    );
    overageIncluded ??= entry.display_name;
  }
  const spendPercent = readSpendPercent(response.rate_limits);
  if (spendPercent !== undefined) {
    windows.push({
      id: "monthly_spend",
      kind: "monthly",
      label: "Monthly spend",
      usedPercent: spendPercent,
    });
  }
  return {
    limits: makeUsageLimits({ checkedAt, windows }),
    names: { overageIncluded },
  };
}

export const recordClaudeUsageResponse = (
  namesRef: Ref.Ref<ClaudeScopedLimitNames>,
  input: Parameters<typeof claudeUsageResponseToLimits>[0],
): Effect.Effect<ServerProviderUsageLimits> => {
  const { limits, names } = claudeUsageResponseToLimits(input);
  return Ref.set(namesRef, names).pipe(Effect.as(limits));
};

/** Origin of a non-Anthropic Claude endpoint; undefined for Anthropic's own API or an unusable URL. */
export function claudeProxyOrigin(baseUrl: string | undefined): string | undefined {
  const endpoint = URL.parse(baseUrl?.trim() ?? "");
  if (
    endpoint === null ||
    (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") ||
    endpoint.hostname === "" ||
    endpoint.hostname === "api.anthropic.com"
  ) {
    return undefined;
  }
  return endpoint.origin;
}

/**
 * A teamclaude proxy answers quotas under its origin whatever path ANTHROPIC_BASE_URL names.
 * The path is the only way to tell it apart from any other proxy.
 */
export function claudeQuotaEndpoint(baseUrl: string | undefined): string | undefined {
  const origin = claudeProxyOrigin(baseUrl);
  return origin === undefined ? undefined : `${origin}/teamclaude/quota`;
}

// Bucket fields are read structurally: one malformed field must not reject the whole payload.
const TeamclaudeBucket = Schema.Struct({
  utilization: Schema.optional(Schema.Unknown),
  nextResetAt: Schema.optional(Schema.Unknown),
});
const TeamclaudeQuota = Schema.Struct({
  aggregate: Schema.Struct({
    fiveHour: Schema.optional(Schema.NullOr(TeamclaudeBucket)),
    weeklyShared: Schema.optional(Schema.NullOr(TeamclaudeBucket)),
    weeklySonnet: Schema.optional(Schema.NullOr(TeamclaudeBucket)),
  }),
});
const decodeTeamclaudeQuota = Schema.decodeUnknownOption(TeamclaudeQuota);

const QUOTA_WINDOWS: ReadonlyArray<{
  readonly bucket: "fiveHour" | "weeklyShared" | "weeklySonnet";
  readonly window: Pick<ServerProviderUsageWindow, "id" | "kind" | "label" | "windowDurationMins">;
}> = [
  { bucket: "fiveHour", window: { id: "five_hour", ...WINDOWS.five_hour! } },
  { bucket: "weeklyShared", window: { id: "seven_day", ...WINDOWS.seven_day! } },
  {
    bucket: "weeklySonnet",
    window: {
      id: scopedWindowId("Sonnet"),
      kind: "weekly",
      label: "Weekly · Sonnet",
      windowDurationMins: WEEK_MINS,
    },
  },
];

function isoFromEpochMillis(value: unknown): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  const dt = DateTime.make(value);
  return Option.isSome(dt) ? DateTime.formatIso(dt.value) : undefined;
}

function quotaWindow(
  bucket: typeof TeamclaudeBucket.Type | null | undefined,
  window: (typeof QUOTA_WINDOWS)[number]["window"],
): ServerProviderUsageWindow | undefined {
  if (!bucket || typeof bucket.utilization !== "number" || !Number.isFinite(bucket.utilization)) {
    return undefined;
  }
  const resetsAt = isoFromEpochMillis(bucket.nextResetAt);
  // Exhaustion is exact (>=100) downstream, so a fraction just short of full must not round into
  // it: one decimal is display precision, and only a full window reports 100.
  const usedPercent =
    bucket.utilization >= 1 ? 100 : clampPercent(Math.floor(bucket.utilization * 1000) / 10);
  return {
    ...window,
    usedPercent,
    ...(resetsAt ? { resetsAt } : {}),
  };
}

/**
 * Teamclaude reports 0-1 fractions of quota used, in epoch milliseconds. Undefined means the
 * body is not a teamclaude quota payload, so discovery can tell a proxy from another endpoint.
 */
export function claudeQuotaResponseToWindows(
  body: unknown,
): ReadonlyArray<ServerProviderUsageWindow> | undefined {
  const quota = Option.getOrUndefined(decodeTeamclaudeQuota(body));
  if (quota === undefined) return undefined;
  // Every bucket is optional, so an unrelated `{"aggregate": …}` would otherwise decode as a
  // quota response with nothing in it. A known key must be there before this counts as teamclaude.
  const aggregate: Record<string, unknown> = quota.aggregate;
  if (!QUOTA_WINDOWS.some(({ bucket }) => bucket in aggregate)) return undefined;
  const windows: ServerProviderUsageWindow[] = [];
  for (const { bucket, window } of QUOTA_WINDOWS) {
    const mapped = quotaWindow(quota.aggregate[bucket], window);
    if (mapped) windows.push(mapped);
  }
  return windows;
}
