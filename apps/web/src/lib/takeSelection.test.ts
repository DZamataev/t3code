import { describe, expect, it } from "vite-plus/test";

import { takeSelectionInsertion } from "./takeSelection";

function take(prompt: string, cursor: number, selection: string) {
  const insertion = takeSelectionInsertion(prompt, cursor, selection);
  if (!insertion) return null;
  const value = prompt.slice(0, cursor) + insertion.text + prompt.slice(cursor);
  return { value, cursor: insertion.cursorAfter };
}

describe("takeSelectionInsertion", () => {
  it("inserts bare text into an empty draft", () => {
    expect(take("", 0, "Q1")).toEqual({ value: "Q1", cursor: 2 });
  });

  it("adds one space after the end of a word", () => {
    expect(take("Q1", 2, "O1")).toEqual({ value: "Q1 O1", cursor: 5 });
  });

  it("adds no space after existing whitespace", () => {
    expect(take("Q1 ", 3, "O1")).toEqual({ value: "Q1 O1", cursor: 5 });
  });

  it("adds one space before a following word", () => {
    expect(take("O1", 0, "Q1")).toEqual({ value: "Q1 O1", cursor: 2 });
  });

  it("separates both halves when taken inside a word", () => {
    expect(take("abcdef", 3, "X")).toEqual({ value: "abc X def", cursor: 5 });
  });

  it("treats line breaks as separators", () => {
    expect(take("Q1\n", 3, "O1")).toEqual({ value: "Q1\nO1", cursor: 5 });
    expect(take("Q1\nO2", 2, "O1")).toEqual({ value: "Q1 O1\nO2", cursor: 5 });
  });

  it("keeps the line breaks inside a multiline selection", () => {
    expect(take("See", 3, "first line\nsecond line")).toEqual({
      value: "See first line\nsecond line",
      cursor: 26,
    });
  });

  it("trims spaces and line breaks around the selection", () => {
    expect(take("Q1", 2, " \n  O1 \n")).toEqual({ value: "Q1 O1", cursor: 5 });
  });

  it("builds an answer from consecutive takes", () => {
    let state = { value: "", cursor: 0 };
    for (const selection of ["Q1", " O1", "Q2\n", "O3"]) {
      state = take(state.value, state.cursor, selection) ?? state;
    }
    expect(state).toEqual({ value: "Q1 O1 Q2 O3", cursor: 11 });
  });

  it("ignores a whitespace-only selection", () => {
    expect(takeSelectionInsertion("Q1", 2, " \n\t")).toBeNull();
  });
});
