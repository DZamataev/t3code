import { describe, expect, it } from "vite-plus/test";

import {
  isReplySuggestionAcceptKey,
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
