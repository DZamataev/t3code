/**
 * Places selected text at a draft caret so it never fuses with its neighbors: one space against
 * non-whitespace on either side, none where whitespace already separates them. The caret lands
 * after the taken text, before any added trailing space, so the next take spaces itself.
 */
export function takeSelectionInsertion(
  prompt: string,
  cursor: number,
  selection: string,
): { text: string; cursorAfter: number } | null {
  const taken = selection.trim();
  if (taken.length === 0) return null;
  const separates = (char: string | undefined) => char === undefined || /\s/.test(char);
  const lead = separates(prompt[cursor - 1]) ? "" : " ";
  const trail = separates(prompt[cursor]) ? "" : " ";
  return { text: `${lead}${taken}${trail}`, cursorAfter: cursor + lead.length + taken.length };
}
