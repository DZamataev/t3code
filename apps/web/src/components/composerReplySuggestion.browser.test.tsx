import type { ServerProviderSkill } from "@t3tools/contracts";
import type { Editor } from "@tiptap/core";
import { createRef, useState } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { act, render } from "../../test/render";

import {
  ComposerPromptEditorTiptap as ComposerPromptEditor,
  type ComposerPromptEditorHandle,
} from "./ComposerPromptEditorTiptap";

const SUGGESTION = "Run the tests";
const NO_SKILLS: ReadonlyArray<ServerProviderSkill> = [];

function Harness({
  onAccept,
  onDismiss,
  suggestion = SUGGESTION,
}: {
  onAccept: () => void;
  onDismiss: () => void;
  suggestion?: string | undefined;
}) {
  const [draft, setDraft] = useState({ cursor: 0, value: "" });
  return (
    <ComposerPromptEditor
      editorRef={createRef<ComposerPromptEditorHandle>()}
      value={draft.value}
      cursor={draft.cursor}
      richTextEnabled={false}
      contextRecords={new Map()}
      skills={NO_SKILLS}
      disabled={false}
      placeholder="Ask anything"
      replySuggestion={suggestion === "" ? undefined : { text: suggestion, onAccept }}
      onDismissReplySuggestion={onDismiss}
      onChange={(...args) => setDraft({ cursor: args[1], value: args[0] })}
      onPaste={() => {}}
    />
  );
}

async function mount(props: Parameters<typeof Harness>[0]) {
  const stack = new AsyncDisposableStack();
  const screen = stack.use(await render(<Harness {...props} />));
  const element = screen.container.querySelector<HTMLElement & { editor: Editor }>(".tiptap");
  if (!element) throw new Error("Composer did not mount");
  const environment = stack.move();
  return Object.assign(screen, {
    [Symbol.asyncDispose]: () => environment.disposeAsync(),
    editor: element.editor,
    /** Presses a key inside the editor, the way the user would with a focused draft. */
    press: async (key: string) => {
      await act(async () => {
        element.editor.view.focus();
      });
      await userEvent.keyboard(key);
    },
  });
}

describe("reply suggestion", () => {
  it("shows the predicted text instead of the placeholder", async () => {
    await using screen = await mount({ onAccept: () => {}, onDismiss: () => {} });

    await expect.element(screen.getByText(SUGGESTION)).toBeInTheDocument();
    await expect.element(screen.getByText("Ask anything")).not.toBeInTheDocument();
  });

  it("accepts with Tab while the draft is empty", async () => {
    const onAccept = vi.fn();
    await using screen = await mount({ onAccept, onDismiss: () => {} });

    await screen.press("{Tab}");

    expect(onAccept).toHaveBeenCalledTimes(1);
  });

  it("dismisses with Escape", async () => {
    const onDismiss = vi.fn();
    await using screen = await mount({ onAccept: () => {}, onDismiss });

    await screen.press("{Escape}");

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("leaves Shift+Tab to the editor", async () => {
    const onAccept = vi.fn();
    await using screen = await mount({ onAccept, onDismiss: () => {} });

    await screen.press("{Shift>}{Tab}{/Shift}");

    expect(onAccept).not.toHaveBeenCalled();
  });

  it("shows the placeholder when there is no suggestion", async () => {
    await using screen = await mount({ onAccept: () => {}, onDismiss: () => {}, suggestion: "" });

    await expect.element(screen.getByText("Ask anything")).toBeInTheDocument();
    await expect.element(screen.getByText(SUGGESTION)).not.toBeInTheDocument();
  });
});
