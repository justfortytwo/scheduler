// Output-channel note for scheduled Claude runs whose replies are pushed to Telegram.
// Same wording as the telegram bridge uses for chat sessions.

export const TELEGRAM_OUTPUT_PROMPT =
  'Output channel: Telegram. Do not use Markdown tables in chat replies. Use compact, readable lists instead. This does not apply to files.';

/**
 * Adds `text` to the system prompt through `--append-system-prompt`. Claude keeps
 * only the last occurrence of that flag, so an operator value is extended, not replaced.
 * Returns a new array; `args` is not modified.
 */
export function withAppendedSystemPrompt(args: readonly string[], text: string): string[] {
  const out = [...args];
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i] === '--append-system-prompt' && i + 1 < out.length) {
      out[i + 1] = `${out[i + 1]}\n\n${text}`;
      return out;
    }
    if (out[i]!.startsWith('--append-system-prompt=')) {
      out[i] = `${out[i]}\n\n${text}`;
      return out;
    }
  }
  return [...out, '--append-system-prompt', text];
}
