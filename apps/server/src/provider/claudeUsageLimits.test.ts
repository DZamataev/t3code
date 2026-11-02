import { describe, expect, it } from "vite-plus/test";

import {
  claudeProxyOrigin,
  claudeQuotaEndpoint,
  claudeQuotaResponseToWindows,
  claudeRateLimitEventToUpdate,
  claudeUsageResponseToLimits,
} from "./claudeUsageLimits.ts";

const checkedAt = "2026-07-18T10:00:00.000Z";
const noNames = { overageIncluded: undefined } as const;

describe("claudeUsageResponseToLimits", () => {
  it("maps the session, weekly, and model-scoped weekly windows", () => {
    expect(
      claudeUsageResponseToLimits({
        checkedAt,
        response: {
          rate_limits_available: true,
          rate_limits: {
            five_hour: { utilization: 54, resets_at: "2026-07-18T14:39:00Z" },
            seven_day: { utilization: 18.4, resets_at: "2026-07-24T08:59:00+00:00" },
            seven_day_opus: { utilization: 3, resets_at: null },
            ...({
              model_scoped: [
                { display_name: "Fable", utilization: 73, resets_at: "2026-07-24T08:59:00Z" },
                { display_name: "Ghost", utilization: null, resets_at: null },
              ],
            } as object),
            extra_usage: {
              is_enabled: false,
              monthly_limit: null,
              used_credits: null,
              utilization: null,
            },
          },
        },
      }),
    ).toEqual({
      names: { overageIncluded: "Fable" },
      limits: {
        checkedAt,
        windows: [
          {
            id: "five_hour",
            kind: "session",
            label: "Session",
            usedPercent: 54,
            windowDurationMins: 300,
            resetsAt: "2026-07-18T14:39:00.000Z",
          },
          {
            id: "seven_day",
            kind: "weekly",
            label: "Weekly",
            usedPercent: 18.4,
            windowDurationMins: 10080,
            resetsAt: "2026-07-24T08:59:00.000Z",
          },
          {
            id: "seven_day_fable",
            kind: "weekly",
            label: "Weekly · Fable",
            usedPercent: 73,
            windowDurationMins: 10080,
            resetsAt: "2026-07-24T08:59:00.000Z",
          },
        ],
      },
    });
  });

  it("names the overage-included bucket only from a scoped entry that drew a row", () => {
    expect(
      claudeUsageResponseToLimits({
        checkedAt,
        response: {
          rate_limits_available: true,
          rate_limits: {
            ...({
              model_scoped: [
                { display_name: "Ghost", utilization: null, resets_at: null },
                { display_name: "Fable", utilization: 5, resets_at: null },
              ],
            } as object),
          },
        },
      }).names,
    ).toEqual({ overageIncluded: "Fable" });
  });

  it("skips a window the endpoint reports without a utilization", () => {
    expect(
      claudeUsageResponseToLimits({
        checkedAt,
        response: {
          rate_limits_available: true,
          rate_limits: {
            five_hour: { utilization: null, resets_at: null },
            seven_day: { utilization: 250, resets_at: null },
          },
        },
      }).limits.windows,
    ).toEqual([
      {
        id: "seven_day",
        kind: "weekly",
        label: "Weekly",
        usedPercent: 100,
        windowDurationMins: 10080,
      },
    ]);
  });

  const enterpriseResponse = {
    rate_limits_available: true,
    rate_limits: {
      five_hour: null,
      seven_day: null,
      spend: {
        enabled: true,
        used: { amount_minor: 4_631, currency: "USD", exponent: 2 },
        limit: { amount_minor: 50_000, currency: "USD", exponent: 2 },
        percent: 9,
      },
      extra_usage: {
        is_enabled: true,
        used_credits: 4_631,
        monthly_limit: 50_000,
        utilization: 9.261999999999999,
        currency: "USD",
        decimal_places: 2,
      },
    },
  };
  const monthlyWindow = {
    id: "monthly_spend",
    kind: "monthly",
    label: "Monthly spend",
    usedPercent: expect.closeTo(9.262, 10),
  };

  it("maps the captured Enterprise budget precisely, preferring spend beside rolling windows", () => {
    expect(claudeUsageResponseToLimits({ checkedAt, response: enterpriseResponse }).limits).toEqual(
      {
        checkedAt,
        windows: [monthlyWindow],
      },
    );
    const response = {
      ...enterpriseResponse,
      rate_limits: {
        ...enterpriseResponse.rate_limits,
        five_hour: { utilization: 12, resets_at: null },
        extra_usage: {
          ...enterpriseResponse.rate_limits.extra_usage,
          used_credits: 30_000,
          utilization: 60,
        },
      },
    };
    expect(claudeUsageResponseToLimits({ checkedAt, response }).limits.windows).toEqual([
      {
        id: "five_hour",
        kind: "session",
        label: "Session",
        usedPercent: 12,
        windowDurationMins: 300,
      },
      monthlyWindow,
    ]);
  });

  it("falls back to enabled extra usage amounts or utilization when spend is unusable", () => {
    const response = {
      ...enterpriseResponse,
      rate_limits: {
        ...enterpriseResponse.rate_limits,
        spend: {
          ...enterpriseResponse.rate_limits.spend,
          enabled: false,
          used: { amount_minor: 30_000, currency: "USD", exponent: 2 },
        },
        extra_usage: { ...enterpriseResponse.rate_limits.extra_usage, utilization: 9 },
      },
    };
    expect(claudeUsageResponseToLimits({ checkedAt, response }).limits.windows).toEqual([
      monthlyWindow,
    ]);
    const utilizationOnly = {
      ...response,
      rate_limits: {
        ...response.rate_limits,
        spend: { enabled: true, used: null, limit: null, percent: 9 },
        extra_usage: {
          ...enterpriseResponse.rate_limits.extra_usage,
          used_credits: null,
          monthly_limit: null,
        },
      },
    };
    expect(
      claudeUsageResponseToLimits({ checkedAt, response: utilizationOnly }).limits.windows,
    ).toEqual([monthlyWindow]);
  });

  it("omits disabled budgets and refuses invalid money without an enabled fallback", () => {
    const rateLimits = enterpriseResponse.rate_limits;
    const response = {
      ...enterpriseResponse,
      rate_limits: {
        ...rateLimits,
        spend: { ...rateLimits.spend, enabled: false },
        extra_usage: { ...rateLimits.extra_usage, is_enabled: false },
      },
    };
    expect(claudeUsageResponseToLimits({ checkedAt, response }).limits.windows).toEqual([]);
    response.rate_limits.spend = {
      ...rateLimits.spend,
      limit: { ...rateLimits.spend.limit, currency: "EUR" },
    };
    expect(claudeUsageResponseToLimits({ checkedAt, response }).limits.windows).toEqual([]);
    response.rate_limits.spend = {
      ...rateLimits.spend,
      limit: { ...rateLimits.spend.limit, amount_minor: 0 },
    };
    expect(claudeUsageResponseToLimits({ checkedAt, response }).limits.windows).toEqual([]);
  });
});

const LIVE_QUOTA = {
  aggregate: {
    fiveHour: null,
    weeklyShared: {
      capacityWeight: 20,
      usedWeight: 20,
      remainingWeight: 0,
      utilization: 1,
      remaining: 0,
      knownAccounts: 1,
      nextResetAt: 1_793_667_600_493,
    },
    weeklySonnet: {
      capacityWeight: 20,
      usedWeight: 20,
      remainingWeight: 0,
      utilization: 1,
      remaining: 0,
      knownAccounts: 1,
      nextResetAt: 1_793_667_600_493,
    },
    weeklyFable: {
      capacityWeight: 20,
      usedWeight: 0.4,
      remainingWeight: 19.6,
      utilization: 0.02,
      remaining: 0.98,
      knownAccounts: 1,
      nextResetAt: 1_793_667_600_493,
    },
  },
  accounts: [],
  unknownTiers: [],
  warmup: {},
};

describe("claudeQuotaResponseToWindows", () => {
  it("maps the live teamclaude payload onto the session and weekly windows it reports", () => {
    expect(claudeQuotaResponseToWindows(LIVE_QUOTA)).toEqual([
      {
        id: "seven_day",
        kind: "weekly",
        label: "Weekly",
        windowDurationMins: 10080,
        usedPercent: 100,
        resetsAt: "2026-11-03T01:00:00.493Z",
      },
      {
        id: "seven_day_fable",
        kind: "weekly",
        label: "Weekly · Fable",
        windowDurationMins: 10080,
        usedPercent: 2,
        resetsAt: "2026-11-03T01:00:00.493Z",
      },
    ]);
  });

  it.each([
    {
      name: "scales the 0-1 fraction and the epoch-millisecond reset",
      aggregate: { fiveHour: { utilization: 0.523, nextResetAt: 1_793_667_600_493 } },
      expected: [
        {
          id: "five_hour",
          kind: "session",
          label: "Session",
          windowDurationMins: 300,
          usedPercent: 52.3,
          resetsAt: "2026-11-03T01:00:00.493Z",
        },
      ],
    },
    {
      name: "keeps a just-short-of-full window below the exhaustion threshold",
      // Exhaustion is exact (>=100) downstream, and a rounded 100 would make agents wait a week.
      aggregate: { fiveHour: { utilization: 0.9995 }, weeklyShared: { utilization: 1 } },
      expected: [
        {
          id: "five_hour",
          kind: "session",
          label: "Session",
          windowDurationMins: 300,
          usedPercent: 99.9,
        },
        {
          id: "seven_day",
          kind: "weekly",
          label: "Weekly",
          windowDurationMins: 10080,
          usedPercent: 100,
        },
      ],
    },
    {
      name: "keeps a window whose bucket reports no reset time",
      aggregate: { weeklyShared: { utilization: 0.4, nextResetAt: null } },
      expected: [
        {
          id: "seven_day",
          kind: "weekly",
          label: "Weekly",
          windowDurationMins: 10080,
          usedPercent: 40,
        },
      ],
    },
    {
      name: "omits a null bucket instead of reporting it as unused",
      aggregate: { fiveHour: null, weeklySonnet: { utilization: 0.25 } },
      expected: [
        {
          id: "seven_day_sonnet",
          kind: "weekly",
          label: "Weekly · Sonnet",
          windowDurationMins: 10080,
          usedPercent: 25,
        },
      ],
    },
    {
      // teamclaude repeats the shared weekly for a bucket the plan does not have.
      name: "hides a scoped window that only repeats the shared weekly",
      aggregate: {
        weeklyShared: { utilization: 0.6 },
        weeklySonnet: { utilization: 0.6 },
        weeklyFable: { utilization: 0.6 },
      },
      expected: [
        {
          id: "seven_day",
          kind: "weekly",
          label: "Weekly",
          windowDurationMins: 10080,
          usedPercent: 60,
        },
      ],
    },
    {
      name: "keeps a scoped window that has a limit of its own",
      aggregate: {
        weeklyShared: { utilization: 0.6 },
        weeklySonnet: { utilization: 0.6 },
        weeklyFable: { utilization: 0.1 },
      },
      expected: [
        {
          id: "seven_day",
          kind: "weekly",
          label: "Weekly",
          windowDurationMins: 10080,
          usedPercent: 60,
        },
        {
          id: "seven_day_fable",
          kind: "weekly",
          label: "Weekly · Fable",
          windowDurationMins: 10080,
          usedPercent: 10,
        },
      ],
    },
    {
      name: "clamps utilization to 0-100 and drops a non-finite one",
      aggregate: {
        fiveHour: { utilization: 1.5 },
        weeklyShared: { utilization: -0.5 },
        weeklySonnet: { utilization: null },
      },
      expected: [
        {
          id: "five_hour",
          kind: "session",
          label: "Session",
          windowDurationMins: 300,
          usedPercent: 100,
        },
        {
          id: "seven_day",
          kind: "weekly",
          label: "Weekly",
          windowDurationMins: 10080,
          usedPercent: 0,
        },
      ],
    },
    {
      name: "ignores a field of the wrong type instead of rejecting the payload",
      aggregate: {
        fiveHour: { utilization: "half" },
        weeklyShared: { utilization: 0.4, nextResetAt: "soon" },
        weeklySonnet: { utilization: Number.NaN, nextResetAt: -1 },
      },
      expected: [
        {
          id: "seven_day",
          kind: "weekly",
          label: "Weekly",
          windowDurationMins: 10080,
          usedPercent: 40,
        },
      ],
    },
  ])("$name", ({ aggregate, expected }) => {
    expect(
      claudeQuotaResponseToWindows({
        aggregate: {
          fiveHour: null,
          weeklyShared: null,
          weeklySonnet: null,
          weeklyFable: null,
          ...aggregate,
        },
        accounts: [],
      }),
    ).toEqual(expected);
  });

  it.each([
    { name: "an empty body", body: {} },
    { name: "a list", body: [] },
    { name: "an HTML page", body: "<html>not found</html>" },
    { name: "a null aggregate", body: { aggregate: null } },
    { name: "another endpoint's JSON", body: { data: [] } },
    // Without a known bucket the body is not identifiable as teamclaude's quota answer.
    { name: "an aggregate without known buckets", body: { aggregate: {} } },
    { name: "an aggregate of unrelated keys", body: { aggregate: { unrelated: 1 } } },
  ])("reports $name as no quota payload", ({ body }) => {
    expect(claudeQuotaResponseToWindows(body)).toBeUndefined();
  });

  it("reports a known bucket with no readable values as no windows", () => {
    expect(claudeQuotaResponseToWindows({ aggregate: { weeklyShared: {} } })).toEqual([]);
  });
});

describe("claudeProxyOrigin", () => {
  it.each([
    { baseUrl: "https://teamclaude.example/api", origin: "https://teamclaude.example" },
    { baseUrl: "http://localhost:8080/v1", origin: "http://localhost:8080" },
    { baseUrl: "https://api.anthropic.com", origin: undefined },
    { baseUrl: "https://api.anthropic.com:443/v1", origin: undefined },
    { baseUrl: "ftp://proxy.example", origin: undefined },
    { baseUrl: "localhost:8080", origin: undefined },
    { baseUrl: "", origin: undefined },
    { baseUrl: undefined, origin: undefined },
  ])("reads the proxy origin of $baseUrl", ({ baseUrl, origin }) => {
    expect(claudeProxyOrigin(baseUrl)).toBe(origin);
  });

  it("puts the quota path on the proxy origin, not on the configured base path", () => {
    expect(claudeQuotaEndpoint("https://teamclaude.example/anthropic/v1")).toBe(
      "https://teamclaude.example/teamclaude/quota",
    );
    expect(claudeQuotaEndpoint("https://api.anthropic.com")).toBeUndefined();
  });
});

describe("claudeRateLimitEventToUpdate", () => {
  it("scales the 0–1 utilization and epoch-second reset onto the probe's window id", () => {
    expect(
      claudeRateLimitEventToUpdate(
        {
          status: "allowed_warning",
          rateLimitType: "seven_day",
          utilization: 0.85,
          resetsAt: 1_784_000_000,
        },
        noNames,
      ),
    ).toEqual({
      windows: [
        {
          id: "seven_day",
          kind: "weekly",
          label: "Weekly",
          usedPercent: 85,
          windowDurationMins: 10080,
          resetsAt: "2026-07-14T03:33:20.000Z",
        },
      ],
    });
  });

  it("lands the streamed overage-included bucket on the row the probe named", () => {
    const event = {
      status: "allowed",
      rateLimitType: "seven_day_overage_included" as never,
      utilization: 0.4,
    } as const;
    expect(claudeRateLimitEventToUpdate(event, noNames)).toBeUndefined();
    expect(claudeRateLimitEventToUpdate(event, { overageIncluded: "Fable" })).toEqual({
      windows: [
        {
          id: "seven_day_fable",
          kind: "weekly",
          label: "Weekly · Fable",
          usedPercent: 40,
          windowDurationMins: 10080,
        },
      ],
    });
  });
});
