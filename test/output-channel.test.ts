import { describe, it, expect } from 'vitest';
import { TELEGRAM_OUTPUT_PROMPT, withAppendedSystemPrompt } from '../src/output-channel.js';

describe('withAppendedSystemPrompt', () => {
  it('adds the flag when the operator set none', () => {
    expect(withAppendedSystemPrompt([], TELEGRAM_OUTPUT_PROMPT)).toEqual(['--append-system-prompt', TELEGRAM_OUTPUT_PROMPT]);
    expect(withAppendedSystemPrompt(['--chrome'], 'x')).toEqual(['--chrome', '--append-system-prompt', 'x']);
  });
  it('extends an operator --append-system-prompt instead of replacing it', () => {
    expect(withAppendedSystemPrompt(['--append-system-prompt', 'be brief', '--chrome'], 'x'))
      .toEqual(['--append-system-prompt', 'be brief\n\nx', '--chrome']);
    expect(withAppendedSystemPrompt(['--append-system-prompt=be brief'], 'x')).toEqual(['--append-system-prompt=be brief\n\nx']);
  });
  it('does not modify its input', () => {
    const input = ['--append-system-prompt', 'be brief'];
    withAppendedSystemPrompt(input, 'x');
    expect(input).toEqual(['--append-system-prompt', 'be brief']);
  });
});
