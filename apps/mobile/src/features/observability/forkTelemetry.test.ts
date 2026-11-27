// Fork-only: the phone sends no connection traces or crash reports, even when a build configures them.
import { expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";

const configure = vi.hoisted(() => vi.fn());

vi.mock("expo-constants", () => ({
  default: {
    expoConfig: {
      extra: {
        appVariant: "production",
        relay: { url: "https://relay.example.test" },
        observability: {
          tracesUrl: "https://api.axiom.co/v1/traces",
          tracesDataset: "mobile-traces",
          tracesToken: "public-ingest-token",
        },
      },
    },
  },
}));

vi.mock("expo-observe", () => ({
  Observe: { configure, dispatchEvents: vi.fn(async () => {}), reportError: vi.fn() },
}));

it("turns off connection traces and crash reports a build configures", async () => {
  vi.stubGlobal("__DEV__", true);
  const Tracing = await import("./tracing");
  const Observe = await import("./observe");

  expect(Tracing.resolveTracingConfig()).toBeNull();
  expect(Observe.crashReportingAvailable).toBe(false);
  expect(configure).toHaveBeenCalledWith(expect.objectContaining({ dispatchingEnabled: false }));
  expect(configure).not.toHaveBeenCalledWith(expect.objectContaining({ dispatchingEnabled: true }));
});
