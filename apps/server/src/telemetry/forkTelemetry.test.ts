// Fork-only: this build sends no analytics or relay traces unless the environment opts in.
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it, vi } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as RelayTracing from "@t3tools/shared/relayTracing";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { FetchHttpClient } from "effect/http";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import { resolveRelayClientTracingConfig } from "../cloud/publicConfig.ts";
import { allowedFor, relayLayer } from "../cloud/relayTracing.ts";
import * as ServerConfig from "../config.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as AnalyticsService from "./AnalyticsService.ts";

const OPTED_IN = { T3CODE_TELEMETRY_ENABLED: "true" };
const BUILT_IN_TRACING = {
  tracesUrl: "https://api.axiom.co/v1/traces",
  tracesDataset: "relay",
  tracesToken: "token",
};

/** The analytics requests a server makes for a few events and a minute of background flushes. */
const analyticsRequests = (env: Readonly<Record<string, string>>) =>
  Effect.gen(function* () {
    const requests: Array<HttpClientRequest.HttpClientRequest> = [];
    const client = HttpClient.make((request) => {
      requests.push(request);
      return Effect.succeed(
        HttpClientResponse.fromWeb(request, new Response(null, { status: 204 })),
      );
    });
    yield* Effect.gen(function* () {
      const analytics = yield* AnalyticsService.AnalyticsService;
      yield* analytics.record("server.boot.heartbeat");
      yield* analytics.recordOwners([{ source: "device", ownerId: "owner" }], "client");
      yield* TestClock.adjust("1 minute");
      yield* analytics.flush;
    }).pipe(
      Effect.provide(
        AnalyticsService.layer.pipe(
          Layer.provideMerge(
            ServerConfig.ServerConfig.layerTest(process.cwd(), { prefix: "t3-fork-telemetry-" }),
          ),
          Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))),
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(HostProcess.Environment, { ...env }),
              Layer.succeed(HttpClient.HttpClient, client),
              ManagedPolicy.layerTest(),
            ),
          ),
        ),
      ),
    );
    return requests;
  });

/** The relay trace exports a server makes for one T3 Connect span. */
const relayTraceExports = (env: NodeJS.ProcessEnv) => {
  const fetchFn = vi.fn<typeof fetch>(async () => new Response(null, { status: 202 }));
  return Effect.void.pipe(
    Effect.withSpan("relay.request"),
    RelayTracing.withRelayClientTracing,
    Layer.effectDiscard,
    Layer.provide(
      relayLayer(
        { serviceName: "t3code-server", runtime: "node", client: "environment-server" },
        BUILT_IN_TRACING,
      ),
    ),
    Layer.provide(ManagedPolicy.layerTest()),
    Layer.provide(Layer.succeed(HostProcess.Environment, env)),
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetchFn)),
    Layer.build,
    Effect.scoped,
    Effect.map(() => fetchFn.mock.calls.length),
  );
};

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))("fork telemetry", (it) => {
  it.effect("sends no product analytics unless T3CODE_TELEMETRY_ENABLED opts in", () =>
    Effect.gen(function* () {
      assert.deepEqual(yield* analyticsRequests({}), []);
      // The same server sends once opted in, so an empty list above means nothing was sent.
      assert.isNotEmpty(yield* analyticsRequests(OPTED_IN));
    }),
  );

  it.effect("exports no relay traces unless T3CODE_TELEMETRY_ENABLED opts in", () =>
    Effect.gen(function* () {
      assert.isNull(resolveRelayClientTracingConfig({}, BUILT_IN_TRACING));
      assert.isFalse(allowedFor({}, undefined));
      assert.strictEqual(yield* relayTraceExports({}), 0);

      assert.isNotNull(resolveRelayClientTracingConfig(OPTED_IN, BUILT_IN_TRACING));
      assert.isTrue(allowedFor(OPTED_IN, undefined));
      assert.isAbove(yield* relayTraceExports({ ...OPTED_IN }), 0);
    }),
  );
});
