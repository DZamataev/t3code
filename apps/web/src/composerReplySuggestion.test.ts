import { describe, expect, it } from "vite-plus/test";

import {
  createReplySuggestionStore,
  isReplySuggestionAcceptKey,
  replySuggestionRunId,
  replySuggestionVisible,
  type ReplySuggestionEntry,
} from "./composerReplySuggestion";

const entry = (over: Partial<ReplySuggestionEntry> = {}): ReplySuggestionEntry => ({
  runId: "run-1",
  text: "Run the tests",
  dismissed: false,
  ...over,
});

const visible = (over: Partial<Parameters<typeof replySuggestionVisible>[0]> = {}): boolean =>
  replySuggestionVisible({ busy: false, empty: true, entry: entry(), runId: "run-1", ...over });

const key = (
  over: Partial<{
    altKey: boolean;
    ctrlKey: boolean;
    key: string;
    metaKey: boolean;
    shiftKey: boolean;
  }>,
) => ({
  altKey: false,
  ctrlKey: false,
  key: "Tab",
  metaKey: false,
  shiftKey: false,
  ...over,
});

describe("replySuggestionVisible", () => {
  it("shows the current run's undismissed suggestion in an idle, empty composer", () => {
    expect(visible()).toBe(true);
  });

  it("hides while a turn runs or once the composer holds anything", () => {
    expect(visible({ busy: true })).toBe(false);
    expect(visible({ empty: false })).toBe(false);
  });

  it("hides another run's suggestion, an empty one, and a dismissed one", () => {
    expect(visible({ runId: "run-2" })).toBe(false);
    expect(visible({ runId: null })).toBe(false);
    expect(visible({ entry: entry({ text: "" }) })).toBe(false);
    expect(visible({ entry: entry({ dismissed: true }) })).toBe(false);
    expect(visible({ entry: undefined })).toBe(false);
  });
});

describe("replySuggestionRunId", () => {
  it("follows only a completed latest run", () => {
    expect(replySuggestionRunId({ runId: "run-1", status: "completed" })).toBe("run-1");
    expect(replySuggestionRunId({ runId: "run-1", status: "running" })).toBeNull();
    expect(replySuggestionRunId({ runId: "run-1", status: "failed" })).toBeNull();
    expect(replySuggestionRunId(null)).toBeNull();
  });
});

describe("isReplySuggestionAcceptKey", () => {
  it("accepts with plain Tab or Right arrow", () => {
    expect(isReplySuggestionAcceptKey(key({ key: "Tab" }))).toBe(true);
    expect(isReplySuggestionAcceptKey(key({ key: "ArrowRight" }))).toBe(true);
  });

  it("leaves every modified key native", () => {
    expect(isReplySuggestionAcceptKey(key({ key: "Tab", shiftKey: true }))).toBe(false);
    expect(isReplySuggestionAcceptKey(key({ key: "ArrowRight", metaKey: true }))).toBe(false);
    expect(isReplySuggestionAcceptKey(key({ key: "ArrowRight", ctrlKey: true }))).toBe(false);
    expect(isReplySuggestionAcceptKey(key({ key: "ArrowRight", altKey: true }))).toBe(false);
    expect(isReplySuggestionAcceptKey(key({ key: "ArrowLeft" }))).toBe(false);
    expect(isReplySuggestionAcceptKey(key({ key: "Enter" }))).toBe(false);
  });
});

describe("reply suggestion store", () => {
  it("asks about each run once, even across thread switches mid-read", () => {
    const store = createReplySuggestionStore();
    expect(store.shouldRead("thread-1", "run-1")).toBe(true);
    store.beginRead("thread-1", "run-1");
    // The composer left and came back while the read was out.
    expect(store.shouldRead("thread-1", "run-1")).toBe(false);
    expect(store.shouldRead("thread-2", "run-9")).toBe(true);

    store.endRead("thread-1", "run-1", "Run the tests");
    expect(store.get("thread-1")).toEqual(entry());
    expect(store.shouldRead("thread-1", "run-1")).toBe(false);
    expect(store.shouldRead("thread-1", "run-2")).toBe(true);
  });

  it("keeps a failed read's run unknown so the next look retries", () => {
    const store = createReplySuggestionStore();
    store.beginRead("thread-1", "run-1");
    store.endRead("thread-1", "run-1", undefined);
    expect(store.get("thread-1")).toBeUndefined();
    expect(store.shouldRead("thread-1", "run-1")).toBe(true);
  });

  it("drops an answer for a run that is no longer the one asked about", () => {
    const store = createReplySuggestionStore();
    store.beginRead("thread-1", "run-1");
    store.beginRead("thread-1", "run-2");
    store.endRead("thread-1", "run-1", "Old suggestion");
    expect(store.get("thread-1")).toBeUndefined();
    store.endRead("thread-1", "run-2", "New suggestion");
    expect(store.get("thread-1")?.text).toBe("New suggestion");
  });

  it("never lets a late answer bring back a suggestion retired by a send", () => {
    const store = createReplySuggestionStore();
    store.beginRead("thread-1", "run-1");
    store.dismiss("thread-1", "run-1");
    store.endRead("thread-1", "run-1", "Run the tests");
    expect(store.get("thread-1")).toEqual(entry({ text: "", dismissed: true }));
  });

  it("keeps a dismissed suggestion dismissed until the next run", () => {
    const store = createReplySuggestionStore();
    store.beginRead("thread-1", "run-1");
    store.endRead("thread-1", "run-1", "Run the tests");
    store.dismiss("thread-1", "run-1");
    expect(store.get("thread-1")).toEqual(entry({ dismissed: true }));
    expect(store.shouldRead("thread-1", "run-1")).toBe(false);
    expect(store.shouldRead("thread-1", "run-2")).toBe(true);
  });
});
