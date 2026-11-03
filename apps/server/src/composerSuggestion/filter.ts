/**
 * Acceptance rules for a predicted next user message, ported from the Hermes implementation: rule
 * order is verdict order, and Python's Unicode-aware `\w` is spelled out because JavaScript's is
 * ASCII-only.
 */

/** Longest accepted suggestion in words. */
const MAX_SUGGESTION_WORDS = 12;

/** Longest accepted suggestion in characters; the ceiling is exclusive. */
const MAX_SUGGESTION_CHARS = 100;

/** Which acceptance rule refused a reply, in {@link rejectReason} order. */
export type SuggestionRejectReason =
  | "meta_text"
  | "meta_wrapped"
  | "error_message"
  | "placeholder"
  | "prefixed_label"
  | "too_few_words"
  | "too_many_words"
  | "too_long"
  | "multiple_sentences"
  | "has_formatting"
  | "evaluative"
  | "assistant_voice";

/** Verdict for one assembled reply: accepted ghost text, silence, or the first failed rule. */
export type SuggestionVerdict =
  | { readonly kind: "accepted"; readonly text: string }
  | { readonly kind: "abstained" }
  | { readonly kind: "rejected"; readonly reason: SuggestionRejectReason };

/** Sentinel reply that asks for no suggestion instead of a message. */
const NONE = "NONE";

/** One-word replies that are complete messages on their own. */
const SHORT_OK: ReadonlySet<string> = new Set([
  "yes",
  "yeah",
  "yep",
  "yup",
  "sure",
  "ok",
  "okay",
  "no",
  "push",
  "commit",
  "deploy",
  "stop",
  "continue",
  "check",
  "exit",
  "quit",
  "да",
  "нет",
  "ок",
  "окей",
  "ага",
  "давай",
  "делай",
  "сделай",
  "продолжай",
  "продолжи",
  "дальше",
  "стоп",
  "отмена",
  "коммить",
  "закоммить",
  "пуш",
  "запушь",
  "деплой",
  "проверь",
  "покажи",
  "запусти",
  "исправь",
  "好",
  "是",
  "对",
  "不",
  "停",
  "走",
  "可",
  "否",
  "네",
  "예",
  "はい",
]);

/** Scripts written without spaces between words (kana, CJK ideographs, hangul). */
const UNSPACED_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]/gu;

/** A reply wrapped in one of the tags the model was told not to use. */
const WRAPPER_TAG_RE = /^<(suggestion|response|output|answer|result)>(.*)<\/\1>$/isu;

/** A role or suggestion label the model put in front of the message. */
const LABEL_RE = new RegExp(
  String.raw`^\s*(?:suggested\s+(?:response|reply|input|prompt)|suggestion|response|reply|answer|output|result` +
    String.raw`|предложение|подсказка|ответ)\s*[:：]\s*`,
  "iu",
);

/** A reply about the prediction itself ("nothing to suggest") or one that announces silence. */
const META_RE = new RegExp(
  String.raw`^nothing (?:found|to suggest)|^no suggestion|\bsilence is\b|\bstay(?:s|ing)? silent\b` +
    String.raw`|^[^\p{L}\p{N}_]*silence[^\p{L}\p{N}_]*$` +
    String.raw`|^[^\p{L}\p{N}_]*(?:done|готово|молчу|молчание|нет предложени[йя]|нечего предложить)[^\p{L}\p{N}_]*$`,
  "iu",
);

/** A whole reply in parentheses or brackets: a stage direction, not a message. */
const BRACKETED_RE = /^(?:\(.*\)|\[.*\]|（.*）|【.*】)$/su;

/** A fill-in-the-blank template is not a message anyone types. */
const PLACEHOLDER_RE =
  /(?<![\p{L}\p{N}_$)])(?<!\])(?:\[(?<a>[^[\]\n]+)\](?!\()|<(?<b>[^<>\n]+)>|\{(?<c>[^{}\n]+)\})|…{2,}|_{3,}/gu;

/** A placeholder body that is a phrase rather than a single word or model. */
const PLACEHOLDER_PHRASE_RE = /^[\p{L}\p{Nl}\p{No}][\p{L}\p{N}_'’-]*(?: [\p{L}\p{N}_'’-]+)+$/u;

/** Transport or provider failures the model echoed back instead of a suggestion. */
const ERROR_PREFIXES: readonly string[] = [
  "api error:",
  "prompt is too long",
  "request timed out",
  "invalid api key",
  "image was too large",
];

/** Two sentences: the reply continues past one message. */
const SENTENCE_BREAK_RE = /[.!?]\s+[A-ZА-ЯЁ]|[。！？]\s*[\p{L}\p{N}_]/u;

/** Praise or agreement: the user's next message is not a review of the assistant's work. */
const EVALUATIVE_RE = new RegExp(
  String.raw`(?<![\p{L}\p{N}_])(?:thanks|thank you|looks good|sounds good|that works|that worked|that's all` +
    String.raw`|nice|great|perfect|makes sense|awesome|excellent|спасибо|благодарю|отлично|супер|круто` +
    String.raw`|выглядит хорошо|звучит хорошо|всё работает|все работает)(?![\p{L}\p{N}_])`,
  "iu",
);

/** The reply answers as the assistant instead of speaking as the user. */
const ASSISTANT_VOICE_RE = new RegExp(
  String.raw`^(?:let me|i'll|i've|i'm|i can|i would|i think|i notice|here's|here is|here are|that's|this is|this will` +
    String.raw`|you can|you should|you could|sure,|of course|certainly|давайте я|сейчас я|я сейчас|я могу|я сделаю` +
    String.raw`|я думаю|вот |вы можете|ты можешь|конечно,)`,
  "iu",
);

/** A word followed by a colon; the message is behind a label the model invented. */
const PREFIXED_LABEL_RE = /^[\p{L}\p{N}_]+:\s/u;

/** A transcript role label the model echoed back ("USER: ..."). */
const ROLE_PREFIX_RE = /^(?:user|assistant)\s*:\s*/iu;

/** Count words with unspaced scripts folded in: about two characters of kana, CJK, or hangul count as one. */
function wordCount(text: string): number {
  const unspaced = text.match(UNSPACED_RE)?.length ?? 0;
  const spaced = text.replace(UNSPACED_RE, " ").match(/\S+/gu)?.length ?? 0;
  return spaced + Math.ceil(unspaced / 2);
}

/** One word is rarely a message, except a slash command, a stock one-word reply, or two unspaced characters. */
function tooShort(text: string, lower: string, words: number): boolean {
  if (
    words >= 2 ||
    text.startsWith("/") ||
    SHORT_OK.has(lower.replace(/^[.!。！]+|[.!。！]+$/gu, ""))
  ) {
    return false;
  }
  return (text.match(UNSPACED_RE)?.length ?? 0) < 2;
}

/** Whether a reply contains a fill-in-the-blank placeholder rather than a message. */
function hasPlaceholder(text: string): boolean {
  for (const match of text.matchAll(PLACEHOLDER_RE)) {
    const inner = match.groups?.a ?? match.groups?.b ?? match.groups?.c;
    if (inner === undefined || PLACEHOLDER_PHRASE_RE.test(inner)) return true;
  }
  return false;
}

const stripQuotes = (text: string): string => text.replace(/^["']+|["']+$/gu, "");

/** Code points the way Python's `len()` counts them: an astral character is one, not two. */
const codePointLength = (text: string): number => Array.from(text).length;

/** Report the first acceptance rule an unwrapped reply fails. */
function rejectReason(text: string): SuggestionRejectReason | undefined {
  const lower = text.toLowerCase();
  const words = wordCount(text);
  if (META_RE.test(lower)) return "meta_text";
  if (BRACKETED_RE.test(text)) return "meta_wrapped";
  if (ERROR_PREFIXES.some((prefix) => lower.startsWith(prefix))) return "error_message";
  if (hasPlaceholder(text)) return "placeholder";
  if (PREFIXED_LABEL_RE.test(text)) return "prefixed_label";
  if (tooShort(text, lower, words)) return "too_few_words";
  if (words > MAX_SUGGESTION_WORDS) return "too_many_words";
  if (codePointLength(text) >= MAX_SUGGESTION_CHARS) return "too_long";
  if (SENTENCE_BREAK_RE.test(text)) return "multiple_sentences";
  if (text.includes("\n") || text.includes("*")) return "has_formatting";
  if (EVALUATIVE_RE.test(lower)) return "evaluative";
  if (ASSISTANT_VOICE_RE.test(text)) return "assistant_voice";
  return undefined;
}

/** Unwrap a model reply and apply every acceptance rule. */
export function cleanComposerSuggestion(raw: string): SuggestionVerdict {
  const unwrapped = raw.trim().replace(WRAPPER_TAG_RE, "$2").trim();
  const unlabeled = stripQuotes(unwrapped).replace(LABEL_RE, "").replace(ROLE_PREFIX_RE, "");
  const text = stripQuotes(unlabeled.trim());
  if (codePointLength(text) === 0 || text.toUpperCase().replace(/\.+$/u, "") === NONE) {
    return { kind: "abstained" };
  }
  const reason = rejectReason(text);
  return reason === undefined ? { kind: "accepted", text } : { kind: "rejected", reason };
}
