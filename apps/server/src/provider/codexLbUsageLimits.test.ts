import * as NodeServices from "@effect/platform-node/NodeServices";
import { CodexSettings } from "@t3tools/contracts";
import { DEFAULT_TIMEOUT_MS } from "@t3tools/provider-core/server/snapshotProbe";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/http";

import { checkCodexProviderStatus, type CodexAppServerProviderSnapshot } from "./CodexProvider.ts";
import { codexLbUsageToWindows, readCodexLbUsageLimits } from "./codexLbUsageLimits.ts";

const URL_V1_USAGE = "https://clb.test/v1/usage";
const API_KEY = "sk-clb-secret";
const checkedAt = "2026-11-26T12:00:00.000Z";

// The answer the oneclick balancer gave on 2026-11-26: the key has no limits of its own.
const POOL_ONLY = {
  request_count: 29709,
  total_tokens: 3130504262,
  limits: [
    {
      limit_type: "credits",
      limit_window: "7d",
      max_value: 88200,
      current_value: 76608,
      remaining_value: 11592,
      model_filter: null,
      reset_at: "2026-11-27T23:22:45Z",
      source: "aggregate",
    },
  ],
  upstream_limits: [
    {
      limit_type: "credits",
      limit_window: "7d",
      max_value: 88200,
      current_value: 76608,
      remaining_value: 11592,
      model_filter: null,
      reset_at: "2026-11-27T23:22:45Z",
      source: "aggregate",
    },
  ],
  account_pool_usage: { primary: null, secondary: 23.0 },
};

const stubHttp = (respond: () => Response | undefined) => {
  const requests: Array<{ url: string; headers: Record<string, string> }> = [];
  const layer = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.suspend(() => {
        requests.push({ url: request.url, headers: request.headers });
        const response = respond();
        return response === undefined
          ? Effect.never
          : Effect.succeed(HttpClientResponse.fromWeb(request, response));
      }),
    ),
  );
  return { requests, layer };
};

const read = (environment: NodeJS.ProcessEnv, apiKeyEnv: string | undefined) =>
  readCodexLbUsageLimits({ url: URL_V1_USAGE, apiKeyEnv, environment, checkedAt });

describe("codexLbUsageToWindows", () => {
  it("reads the pool's credit window once and the accounts' remaining share as used", () => {
    expect(codexLbUsageToWindows(POOL_ONLY)).toEqual([
      {
        id: "credits-7d",
        kind: "weekly",
        label: "Weekly credits",
        windowDurationMins: 10080,
        usedPercent: (76608 / 88200) * 100,
        resetsAt: "2026-11-27T23:22:45.000Z",
      },
      {
        id: "pool-accounts-weekly",
        kind: "weekly",
        label: "Weekly · pool accounts",
        windowDurationMins: 10080,
        usedPercent: 77,
      },
    ]);
  });

  it("keeps a key's own limits apart from the pool's and scopes a model filter", () => {
    const windows = codexLbUsageToWindows({
      limits: [
        {
          limit_type: "total_tokens",
          limit_window: "daily",
          max_value: 1000,
          current_value: 1000,
          model_filter: "gpt-5.5",
          reset_at: "2026-11-27T00:00:00Z",
          source: "api_key_limit",
        },
        { limit_type: "credits", limit_window: "7d", max_value: 0, current_value: 0 },
        { limit_type: "credits", limit_window: "5h" },
      ],
      upstream_limits: [
        {
          limit_type: "credits",
          limit_window: "5h",
          max_value: 200,
          current_value: 50,
          reset_at: "2026-11-26T15:00:00Z",
          source: "aggregate",
        },
      ],
      account_pool_usage: { primary: 0, secondary: null },
    });
    expect(windows).toEqual([
      {
        id: "credits-5h",
        kind: "session",
        label: "Session credits",
        windowDurationMins: 300,
        usedPercent: 25,
        resetsAt: "2026-11-26T15:00:00.000Z",
      },
      {
        id: "key-total_tokens-daily-gpt-5.5",
        kind: "other",
        label: "Key daily tokens · gpt-5.5",
        windowDurationMins: 1440,
        modelIds: ["gpt-5.5"],
        usedPercent: 100,
        resetsAt: "2026-11-27T00:00:00.000Z",
      },
      {
        id: "pool-accounts-session",
        kind: "session",
        label: "Session · pool accounts",
        windowDurationMins: 300,
        usedPercent: 100,
      },
    ]);
  });

  it("tells an empty codex-lb answer from a body that is not one", () => {
    expect(
      codexLbUsageToWindows({ limits: [], upstream_limits: [], account_pool_usage: null }),
    ).toEqual([]);
    expect(codexLbUsageToWindows({ error: "nope" })).toBeUndefined();
    expect(codexLbUsageToWindows("<html>")).toBeUndefined();
  });
});

describe("readCodexLbUsageLimits", () => {
  it.effect("reads /v1/usage with the key the model provider's env_key names", () =>
    Effect.gen(function* () {
      const http = stubHttp(() => Response.json(POOL_ONLY));
      const limits = yield* read({ CLB_KEY: API_KEY }, "CLB_KEY").pipe(Effect.provide(http.layer));

      expect(http.requests).toEqual([
        {
          url: URL_V1_USAGE,
          headers: expect.objectContaining({
            authorization: `Bearer ${API_KEY}`,
            accept: "application/json",
          }),
        },
      ]);
      expect(limits.unavailable).toBeUndefined();
      expect(limits.checkedAt).toBe(checkedAt);
      expect(limits.windows.map((window) => window.id)).toEqual([
        "credits-7d",
        "pool-accounts-weekly",
      ]);
    }),
  );

  it.effect.each([
    [{ status: 401 }, "The usage limits URL answered with HTTP 401."],
    [{ status: 404 }, "The usage limits URL answered with HTTP 404."],
    [{ status: 302, headers: { location: "https://elsewhere.test/" } }, "HTTP 302."],
  ] as const)("reports %o without the key or the body", ([init, message]) =>
    Effect.gen(function* () {
      const http = stubHttp(() => new Response(`{"detail":"bad ${API_KEY}"}`, init));
      const limits = yield* read({ CLB_KEY: API_KEY }, "CLB_KEY").pipe(Effect.provide(http.layer));

      expect(limits.unavailable?.reason).toBe("probeFailed");
      expect(limits.unavailable?.message).toContain(message);
      expect(JSON.stringify(limits)).not.toContain(API_KEY);
      expect(http.requests).toHaveLength(1);
    }),
  );

  it.effect("gives up on a balancer that does not answer", () =>
    Effect.gen(function* () {
      const http = stubHttp(() => undefined);
      const fiber = yield* read({ CLB_KEY: API_KEY }, "CLB_KEY").pipe(
        Effect.provide(http.layer),
        Effect.forkChild,
      );
      yield* TestClock.adjust(DEFAULT_TIMEOUT_MS);
      const limits = yield* Fiber.join(fiber);

      expect(limits.unavailable).toEqual({
        reason: "probeFailed",
        message: "The usage limits URL did not answer in time.",
      });
    }),
  );

  it.effect("reports an answer with no limits and a body that is not codex-lb's", () =>
    Effect.gen(function* () {
      const empty = yield* read({ CLB_KEY: API_KEY }, "CLB_KEY").pipe(
        Effect.provide(stubHttp(() => Response.json({ limits: [], upstream_limits: [] })).layer),
      );
      const foreign = yield* read({ CLB_KEY: API_KEY }, "CLB_KEY").pipe(
        Effect.provide(stubHttp(() => Response.json({ ok: true })).layer),
      );

      expect(empty.unavailable?.message).toBe("The usage limits URL reported no limits.");
      expect(foreign.unavailable?.message).toBe(
        "The usage limits URL did not answer with codex-lb usage JSON.",
      );
    }),
  );

  it.effect("sends nothing without a key", () =>
    Effect.gen(function* () {
      const http = stubHttp(() => Response.json(POOL_ONLY));
      const missingVariable = yield* read({}, "CLB_KEY").pipe(Effect.provide(http.layer));
      const noEnvKey = yield* read({ CLB_KEY: API_KEY }, undefined).pipe(
        Effect.provide(http.layer),
      );

      expect(http.requests).toEqual([]);
      expect(missingVariable.unavailable?.message).toBe(
        "Codex usage limits need CLB_KEY on this instance.",
      );
      expect(noEnvKey.unavailable?.message).toBe(
        "Codex usage limits need a model provider with an env_key API key.",
      );
    }),
  );
});

describe("checkCodexProviderStatus with a usage limits URL", () => {
  const decodeCodexSettings = Schema.decodeSync(CodexSettings);
  const snapshot: CodexAppServerProviderSnapshot = {
    version: "1.0.0",
    account: {
      account: { type: "chatgpt", email: "login@example.com", planType: "pro" },
      requiresOpenaiAuth: false,
    },
    endpoint: "https://clb.test",
    apiKeyEnv: "CLB_KEY",
    models: [],
    skills: [],
  };

  it.effect("shows the balancer's limits instead of the login's, without the login", () =>
    Effect.gen(function* () {
      const http = stubHttp(() => Response.json(POOL_ONLY));
      const probes: Array<{ readonly skipNativeUsage?: boolean }> = [];
      const status = yield* checkCodexProviderStatus(
        decodeCodexSettings({ usageLimitsUrl: URL_V1_USAGE }),
        (input) => {
          probes.push(input);
          return Effect.succeed(snapshot);
        },
        { CLB_KEY: API_KEY },
      ).pipe(Effect.provide(Layer.mergeAll(http.layer, NodeServices.layer)));

      expect(probes.map((probe) => probe.skipNativeUsage)).toEqual([true]);
      expect(status.usageLimits?.windows.map((window) => window.id)).toEqual([
        "credits-7d",
        "pool-accounts-weekly",
      ]);
      expect(status.auth).toEqual({
        status: "authenticated",
        type: "chatgpt",
        label: expect.any(String),
        endpoint: "https://clb.test",
      });
    }),
  );

  it.effect("leaves an instance without the setting as it was", () =>
    Effect.gen(function* () {
      const http = stubHttp(() => Response.json(POOL_ONLY));
      const status = yield* checkCodexProviderStatus(
        decodeCodexSettings({}),
        () => Effect.succeed(snapshot),
        { CLB_KEY: API_KEY },
      ).pipe(Effect.provide(Layer.mergeAll(http.layer, NodeServices.layer)));

      expect(http.requests).toEqual([]);
      expect(status.auth.email).toBe("login@example.com");
      expect(status.usageLimits?.unavailable?.reason).toBe("unsupported");
    }),
  );
});
