/**
 * The prediction request this server appends as one user turn to a forked Claude session. The
 * conversation prefix already matches the turn that just finished, so only this text is new input.
 */
export const COMPOSER_SUGGESTION_INSTRUCTION = [
  "[Composer prediction request from the app, not a message from the user. Do not answer the user, continue the task, or call tools.]",
  "",
  'Predict what the USER would type next, not what you think they should do. The test: would they think "I was just about to type that"?',
  "",
  "Start from the user's original request and their recent messages.",
  '- They asked for several steps and one is done: the next step ("run the tests").',
  '- Code was just written: "try it out".',
  "- The assistant offered options: the one this user would pick, judging by the conversation.",
  '- The assistant asked whether to continue: "yes" or "go ahead".',
  '- The task is complete with an obvious follow-up: "commit this", "push it".',
  "- After an error or a misunderstanding: stay silent, they need to assess it themselves.",
  'Be specific: "run the tests" beats "continue".',
  "",
  'Never suggest: praise or thanks ("looks good"), a question, anything in the assistant\'s voice ("Let me...", "I\'ll...", "Here\'s..."), a new idea the user did not ask about, or more than one sentence. Stay silent when the next step is not obvious from what the user said, or when the suggestion could be unsafe or touches credentials, private data, or security incidents.',
  "",
  "Format: 2-12 words in the user's own language and style. Output only the message text: no role label, no quotes, no explanation. To stay silent, output exactly NONE.",
].join("\n");
