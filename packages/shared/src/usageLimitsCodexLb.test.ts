import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUsageWindow,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { collectLimitAccounts, collectLimitPools, type LimitPresentations } from "./usageLimits.ts";

const now = Date.parse("2026-11-27T12:00:00.000Z");
const checkedAt = "2026-11-27T11:00:00.000Z";

const weeklyWindow = (id: string, usedPercent: number): ServerProviderUsageWindow => ({
  id,
  kind: "weekly",
  label: "Weekly",
  usedPercent,
  windowDurationMins: 7 * 24 * 60,
  resetsAt: "2026-12-02T12:00:00.000Z",
});

const codexProvider = (
  instanceId: string,
  windows: readonly ServerProviderUsageWindow[],
): ServerProvider => ({
  instanceId: ProviderInstanceId.make(instanceId),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt,
  models: [],
  slashCommands: [],
  skills: [],
  usageLimits: { checkedAt, windows },
});

function weeklyWindows(providers: readonly ServerProvider[]) {
  const presentations: LimitPresentations = new Map(
    providers.map((provider, index) => [
      EnvironmentId.make(`env-${index}`),
      {
        entry: { target: { label: `Machine ${index}` } },
        serverConfig: { providers: [provider] },
      },
    ]),
  );
  const [pool] = collectLimitPools(collectLimitAccounts(presentations), now);
  return (pool?.windows ?? []).filter((window) => window.kind === "weekly");
}

describe("Codex balancer usage pools", () => {
  it("keeps a balancer's week apart from another account's native week", () => {
    const windows = weeklyWindows([
      codexProvider("native", [weeklyWindow("secondary", 9)]),
      codexProvider("balancer", [weeklyWindow("clb.test:credits-7d", 48)]),
    ]);

    expect(windows.map((window) => [window.id, window.usedPercent, window.members.length])).toEqual(
      [
        ["weekly", 9, 1],
        ["weekly:clb.test:credits-7d", 48, 1],
      ],
    );
  });

  it("keeps two balancers' weeks apart", () => {
    const windows = weeklyWindows([
      codexProvider("one", [weeklyWindow("clb.one:credits-7d", 10)]),
      codexProvider("two", [weeklyWindow("clb.two:credits-7d", 20)]),
    ]);

    expect(windows.map((window) => [window.id, window.usedPercent, window.members.length])).toEqual(
      [
        ["weekly:clb.one:credits-7d", 10, 1],
        ["weekly:clb.two:credits-7d", 20, 1],
      ],
    );
  });

  it("still pools two accounts' native weeks into one window", () => {
    const windows = weeklyWindows([
      codexProvider("a", [weeklyWindow("secondary", 40)]),
      codexProvider("b", [weeklyWindow("secondary", 60)]),
    ]);

    expect(windows.map((window) => [window.id, window.usedPercent, window.members.length])).toEqual(
      [["weekly", 50, 2]],
    );
  });
});
