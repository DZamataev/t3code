import { describe, expect, it } from "vite-plus/test";

import {
  isReplySuggestionAcceptKey,
  replySuggestionShouldRead,
  replySuggestionVisible,
  type ReplySuggestionVisibility,
} from "./composerReplySuggestion";

const visible = (over: Partial<ReplySuggestionVisibility> = {}): boolean =>
  replySuggestionVisible({
    busy: false,
    dismissedText: null,
    empty: true,
    text: "Run the tests",
    ...over,
  });

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
  it("shows an undismissed suggestion in an idle, empty composer", () => {
    expect(visible()).toBe(true);
  });

  it("hides while a turn runs", () => {
    expect(visible({ busy: true })).toBe(false);
  });

  it("hides once the composer holds anything", () => {
    expect(visible({ empty: false })).toBe(false);
  });

  it("hides nothing and hides what the user dismissed", () => {
    expect(visible({ text: "" })).toBe(false);
    expect(visible({ dismissedText: "Run the tests" })).toBe(false);
    expect(visible({ dismissedText: "Commit this" })).toBe(true);
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

const readable = (over: Partial<Parameters<typeof replySuggestionShouldRead>[0]> = {}): boolean =>
  replySuggestionShouldRead({
    awaitingTurn: false,
    busy: false,
    empty: true,
    enabled: true,
    inFlight: false,
    text: "",
    threadId: "thread-1",
    ...over,
  });

describe("replySuggestionShouldRead", () => {
  it("reads an idle, empty composer with nothing to show", () => {
    expect(readable()).toBe(true);
  });

  it("does not read right after a send, before the turn starts", () => {
    expect(readable({ awaitingTurn: true })).toBe(false);
  });

  it("does not read while a turn runs, while a request is out, or with text to keep", () => {
    expect(readable({ busy: true })).toBe(false);
    expect(readable({ inFlight: true })).toBe(false);
    expect(readable({ text: "Run the tests" })).toBe(false);
    expect(readable({ empty: false })).toBe(false);
  });

  it("does not read without a thread or with the feature off", () => {
    expect(readable({ threadId: null })).toBe(false);
    expect(readable({ enabled: false })).toBe(false);
  });
});
