// @effect-diagnostics nodeBuiltinImport:off - cleanup uses Node's retrying rm, which the FileSystem service does not expose.
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ClaudeSdk from "@anthropic-ai/claude-agent-sdk";
import { ClaudeSettings, type ServerProvider } from "@t3tools/contracts";
import { vi } from "vite-plus/test";
import { assert, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/http";

import {
  buildClaudeCapabilitiesProbeQueryOptions,
  probeClaudeCapabilities,
  probeClaudeWorkspaceSnapshot,
} from "./ClaudeProvider.ts";

vi.mock("@anthropic-ai/claude-agent-sdk", { spy: true });

const decodeClaudeSettings = Schema.decodeEffect(ClaudeSettings);

it("drops strict MCP mode, and only that, next to an administrator's managed-mcp.json", () => {
  const options = buildClaudeCapabilitiesProbeQueryOptions({
    executablePath: "/usr/bin/claude",
    abortController: new AbortController(),
    environment: { HOME: "/home/user" },
    cwd: undefined,
    managedMcpConfig: true,
  });

  // Claude exits before initializing when handed --strict-mcp-config here.
  assert.equal(options.strictMcpConfig, undefined);
  assert.deepEqual(options.mcpServers, {});
  assert.equal(options.env?.ENABLE_CLAUDEAI_MCP_SERVERS, "false");
});

it.effect("reports a deleted worktree's scan as finished, not pending", () =>
  Effect.gen(function* () {
    const snapshot = yield* probeClaudeWorkspaceSnapshot(
      yield* decodeClaudeSettings({}),
      { skills: [], slashCommands: [] } as unknown as ServerProvider,
      "/nonexistent/t3-deleted-worktree",
      { HOME: "/nonexistent/t3-home" },
    );
    assert.strictEqual(snapshot.slashCommandsPending, false);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make(() => Effect.die("a workspace scan must not read usage limits")),
        ),
      ),
    ),
  ),
);

const QUOTA_PAYLOAD = {
  aggregate: {
    fiveHour: { utilization: 0.5, nextResetAt: 1_793_667_600_493 },
    weeklyShared: { utilization: 1, nextResetAt: 1_793_667_600_493 },
    weeklySonnet: null,
    weeklyFable: { utilization: 0.02, nextResetAt: 1_793_667_600_493 },
  },
  accounts: [],
  unknownTiers: [],
  warmup: {},
};

/** A CLI that initializes, and a usage endpoint the test answers. */
const stubClaudeProbe = Effect.fn("ClaudeCapabilitiesProbeTest.stubClaudeProbe")(function* (input: {
  readonly usage?: () => Promise<unknown>;
  readonly respond?: (url: string) => Response;
}) {
  const requests: Array<{ url: string; headers: Record<string, string> }> = [];
  const usageCalls: Array<string> = [];
  const query = vi.spyOn(ClaudeSdk, "query").mockImplementation(
    () =>
      ({
        initializationResult: () =>
          Promise.resolve({
            commands: [],
            account: { email: "someone@example.com", tokenSource: "ANTHROPIC_API_KEY" },
          }),
        usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: () => {
          usageCalls.push("usage");
          return input.usage
            ? input.usage()
            : Promise.resolve({ rate_limits_available: false, rate_limits: null });
        },
      }) as unknown as ReturnType<typeof ClaudeSdk.query>,
  );
  yield* Effect.addFinalizer(() => Effect.sync(() => query.mockRestore()));
  const layer = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() => {
        requests.push({ url: request.url, headers: request.headers });
        return HttpClientResponse.fromWeb(
          request,
          input.respond?.(request.url) ?? new Response("not found", { status: 404 }),
        );
      }),
    ),
  );
  return { requests, usageCalls, layer: Layer.mergeAll(layer, NodeServices.layer) };
});

describe("Claude usage limits endpoint", () => {
  it.effect("reads an explicit usageLimitsUrl and leaves the CLI usage call alone", () =>
    Effect.gen(function* () {
      const stub = yield* stubClaudeProbe({ respond: () => Response.json(QUOTA_PAYLOAD) });
      const capabilities = yield* probeClaudeCapabilities(
        yield* decodeClaudeSettings({ usageLimitsUrl: "https://quota.example/teamclaude/quota" }),
        { ANTHROPIC_API_KEY: "client-key", ANTHROPIC_BASE_URL: "https://api.anthropic.com" },
      ).pipe(Effect.provide(stub.layer));

      expect(stub.usageCalls).toEqual([]);
      expect(capabilities.usage).toBeUndefined();
      expect(stub.requests).toHaveLength(1);
      expect(stub.requests[0]!.url).toBe("https://quota.example/teamclaude/quota");
      expect(stub.requests[0]!.headers["x-api-key"]).toBe("client-key");
      expect(stub.requests[0]!.headers.accept).toBe("application/json");
      expect(capabilities.usageLimits?.windows).toEqual([
        {
          id: "five_hour",
          kind: "session",
          label: "Session",
          windowDurationMins: 300,
          usedPercent: 50,
          resetsAt: "2026-11-03T01:00:00.493Z",
        },
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
    }),
  );

  it.effect("discovers a teamclaude quota endpoint from ANTHROPIC_BASE_URL", () =>
    Effect.gen(function* () {
      const stub = yield* stubClaudeProbe({ respond: () => Response.json(QUOTA_PAYLOAD) });
      const capabilities = yield* probeClaudeCapabilities(yield* decodeClaudeSettings({}), {
        ANTHROPIC_API_KEY: "client-key",
        ANTHROPIC_BASE_URL: "https://teamclaude.example/anthropic",
      }).pipe(Effect.provide(stub.layer));

      expect(stub.usageCalls).toHaveLength(1);
      expect(stub.requests.map((request) => request.url)).toEqual([
        "https://teamclaude.example/teamclaude/quota",
      ]);
      expect(capabilities.usage).toEqual({ rate_limits_available: false, rate_limits: null });
      expect(capabilities.usageLimits?.windows.map((window) => window.id)).toEqual([
        "five_hour",
        "seven_day",
        "seven_day_fable",
      ]);
    }),
  );

  it.effect.each([
    { name: "a 404", response: () => new Response("not found", { status: 404 }) },
    { name: "an HTML page", response: () => new Response("<html>hello</html>") },
    { name: "another endpoint's JSON", response: () => Response.json({ data: [] }) },
    {
      name: "an aggregate without known buckets",
      response: () => Response.json({ aggregate: {} }),
    },
  ])("ignores $name at the discovered endpoint", ({ response }) =>
    Effect.gen(function* () {
      const stub = yield* stubClaudeProbe({ respond: response });
      const capabilities = yield* probeClaudeCapabilities(yield* decodeClaudeSettings({}), {
        ANTHROPIC_API_KEY: "client-key",
        ANTHROPIC_BASE_URL: "https://proxy.example/api",
      }).pipe(Effect.provide(stub.layer));

      expect(stub.requests).toHaveLength(1);
      expect(capabilities.usageLimits).toBeUndefined();
      expect(capabilities.usage).toEqual({ rate_limits_available: false, rate_limits: null });
    }),
  );

  it.effect("does not discover on Anthropic's own endpoint", () =>
    Effect.gen(function* () {
      const stub = yield* stubClaudeProbe({ respond: () => Response.json(QUOTA_PAYLOAD) });
      const capabilities = yield* probeClaudeCapabilities(yield* decodeClaudeSettings({}), {
        ANTHROPIC_API_KEY: "client-key",
        ANTHROPIC_BASE_URL: "https://api.anthropic.com",
      }).pipe(Effect.provide(stub.layer));

      expect(stub.requests).toEqual([]);
      expect(capabilities.usageLimits).toBeUndefined();
    }),
  );

  it.effect("keeps the CLI's own limits when it reports them", () =>
    Effect.gen(function* () {
      const stub = yield* stubClaudeProbe({
        respond: () => Response.json(QUOTA_PAYLOAD),
        usage: () =>
          Promise.resolve({
            rate_limits_available: true,
            rate_limits: { five_hour: { utilization: 5, resets_at: null } },
          }),
      });
      const capabilities = yield* probeClaudeCapabilities(yield* decodeClaudeSettings({}), {
        ANTHROPIC_API_KEY: "client-key",
        ANTHROPIC_BASE_URL: "https://proxy.example/api",
      }).pipe(Effect.provide(stub.layer));

      expect(stub.requests).toEqual([]);
      expect(capabilities.usageLimits).toBeUndefined();
      expect(capabilities.usage?.rate_limits_available).toBe(true);
    }),
  );

  it.effect("degrades a failing explicit endpoint to probeFailed without failing the probe", () =>
    Effect.gen(function* () {
      const stub = yield* stubClaudeProbe({
        respond: () => new Response("boom", { status: 503 }),
      });
      const capabilities = yield* probeClaudeCapabilities(
        yield* decodeClaudeSettings({ usageLimitsUrl: "https://quota.example/teamclaude/quota" }),
        { ANTHROPIC_API_KEY: "client-key" },
      ).pipe(Effect.provide(stub.layer));

      expect(capabilities.email).toBe("someone@example.com");
      expect(capabilities.usageLimits).toEqual({
        checkedAt: expect.any(String),
        windows: [],
        unavailable: {
          reason: "probeFailed",
          message: "The usage limits URL did not answer with teamclaude quota JSON.",
        },
      });
    }),
  );

  it.effect("reports a missing API key on an explicit endpoint instead of requesting it", () =>
    Effect.gen(function* () {
      const stub = yield* stubClaudeProbe({ respond: () => Response.json(QUOTA_PAYLOAD) });
      const capabilities = yield* probeClaudeCapabilities(
        yield* decodeClaudeSettings({ usageLimitsUrl: "https://quota.example/teamclaude/quota" }),
        {},
      ).pipe(Effect.provide(stub.layer));

      expect(stub.requests).toEqual([]);
      expect(capabilities.usageLimits?.unavailable).toEqual({
        reason: "probeFailed",
        message: "Claude usage limits need ANTHROPIC_API_KEY on this instance.",
      });
    }),
  );
});
