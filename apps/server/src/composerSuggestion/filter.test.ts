import { describe, expect, it } from "@effect/vitest";

import { cleanComposerSuggestion } from "./filter.ts";

const accepted = (raw: string) => {
  const verdict = cleanComposerSuggestion(raw);
  return verdict.kind === "accepted" ? verdict.text : `<<${verdict.kind}>>`;
};

const rejectedWith = (raw: string) => {
  const verdict = cleanComposerSuggestion(raw);
  return verdict.kind === "rejected" ? verdict.reason : `<<${verdict.kind}>>`;
};

describe("cleanComposerSuggestion", () => {
  it("keeps a short, specific message", () => {
    expect(accepted("Run the tests")).toBe("Run the tests");
    expect(accepted("запусти тесты")).toBe("запусти тесты");
    expect(accepted("继续")).toBe("继续");
    expect(accepted("Commit this and push")).toBe("Commit this and push");
    expect(accepted("Yes")).toBe("Yes");
    expect(accepted("/compact")).toBe("/compact");
  });

  it("treats the silence sentinel as no suggestion", () => {
    expect(accepted("NONE")).toBe("<<abstained>>");
    expect(accepted("  none.  ")).toBe("<<abstained>>");
    expect(accepted("")).toBe("<<abstained>>");
  });

  it("unwraps tags, quotes, and labels the model added", () => {
    expect(accepted("<suggestion>Run the tests</suggestion>")).toBe("Run the tests");
    expect(accepted('"Run the tests"')).toBe("Run the tests");
    expect(accepted("Suggestion: run the tests")).toBe("run the tests");
    expect(accepted("USER: run the tests")).toBe("run the tests");
    expect(accepted("Подсказка: запусти тесты")).toBe("запусти тесты");
  });

  it("refuses praise, assistant voice, and meta text", () => {
    expect(rejectedWith("Looks good, thanks")).toBe("evaluative");
    expect(rejectedWith("Let me check that")).toBe("assistant_voice");
    expect(rejectedWith("Nothing to suggest here")).toBe("meta_text");
    expect(rejectedWith("stay silent")).toBe("meta_text");
  });

  it("refuses templates and transcript noise", () => {
    expect(rejectedWith("Open [path to the file] and fix it")).toBe("placeholder");
    expect(rejectedWith("(a stage direction)")).toBe("meta_wrapped");
    expect(rejectedWith("api error: overloaded")).toBe("error_message");
    expect(rejectedWith("Next: run the tests")).toBe("prefixed_label");
  });

  it("refuses anything longer than one short line", () => {
    expect(
      rejectedWith("one two three four five six seven eight nine ten eleven twelve thirteen"),
    ).toBe("too_many_words");
    expect(rejectedWith(`${"a".repeat(50)} ${"b".repeat(50)}`)).toBe("too_long");
    expect(rejectedWith("Run the tests. Then commit.")).toBe("multiple_sentences");
    expect(rejectedWith("Run the tests\nand commit")).toBe("has_formatting");
    expect(rejectedWith("**Run the tests**")).toBe("has_formatting");
  });
});
