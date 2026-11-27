// Fork-only: the hosted web app sends no relay traces until a server it connects to allows them.
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { managedTelemetryOffMessage } from "../state/managedPolicy.ts";
import {
  relayTelemetryEnabled,
  resolveRelayTracingConfig,
  setServerRelayTelemetry,
} from "./publicConfig.ts";

afterEach(() => {
  setServerRelayTelemetry(null);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("fork telemetry", () => {
  it("does not trace from the hosted app before a server allows it", () => {
    vi.stubEnv("VITE_HOSTED_APP_CHANNEL", "latest");
    vi.stubEnv("VITE_RELAY_OTLP_TRACES_URL", "https://api.axiom.co/v1/traces");
    vi.stubEnv("VITE_RELAY_OTLP_TRACES_DATASET", "relay");
    vi.stubEnv("VITE_RELAY_OTLP_TRACES_TOKEN", "token");
    vi.stubGlobal("window", { location: new URL("https://app.t3.codes/") });

    expect(relayTelemetryEnabled()).toBeNull();
    setServerRelayTelemetry(false);
    expect(relayTelemetryEnabled()).toBe(false);
    expect(resolveRelayTracingConfig()).toBeNull();
  });

  it("says the build sends no product usage data by default", () => {
    expect(managedTelemetryOffMessage(undefined)).toBe(
      "This build of T3 Code doesn't send product usage data by default.",
    );
    expect(
      managedTelemetryOffMessage({
        organization: "Example Corp",
        lockedSettings: [],
        limits: { telemetry: false },
      }),
    ).toBe("Example Corp turned off product usage data.");
  });
});
