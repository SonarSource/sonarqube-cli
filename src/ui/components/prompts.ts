// Interactive prompts — text input, confirmation, press-to-continue

import { TextPrompt, ConfirmPrompt, isCancel } from '@clack/core';
import { cyan, green, red, dim } from '../colors.js';
import { isMockActive, recordCall, dequeueMockResponse } from '../mock.js';

/**
 * Text input prompt. Returns null if cancelled (Ctrl+C).
 */
export async function textPrompt(message: string): Promise<string | null> {
  if (isMockActive()) {
    const value = dequeueMockResponse<string>('');
    recordCall('textPrompt', message, value);
    return value;
  }

  const prompt = new TextPrompt({
    render() {
      if (this.state === 'submit') return `  ${green('✓')}  ${message} ${dim(this.value ?? '')}`;
      if (this.state === 'cancel') return `  ${red('✗')}  ${message}`;
      return [`  ${cyan('?')}  ${message}`, `  ${dim('›')} ${this.userInputWithCursor}`].join('\n');
    },
  });

  const result = await prompt.prompt();
  if (isCancel(result)) return null;
  return result as string;
}

/**
 * Yes/No confirmation prompt. Returns null if cancelled (Ctrl+C).
 */
export async function confirmPrompt(message: string): Promise<boolean | null> {
  if (isMockActive()) {
    const value = dequeueMockResponse<boolean>(false);
    recordCall('confirmPrompt', message, value);
    return value;
  }

  const prompt = new ConfirmPrompt({
    active: 'Yes',
    inactive: 'No',
    render() {
      if (this.state === 'submit') return `  ${green('✓')}  ${message} ${dim(this.value ? 'Yes' : 'No')}`;
      if (this.state === 'cancel') return `  ${red('✗')}  ${message}`;
      const yes = this.cursor === 0 ? cyan('[Yes]') : ' Yes ';
      const no  = this.cursor === 1 ? cyan('[No] ') : ' No  ';
      return `  ${cyan('?')}  ${message}  ${yes} / ${no}`;
    },
  });

  const result = await prompt.prompt();
  if (isCancel(result)) return null;
  return result as boolean;
}

/**
 * Press-Enter-to-continue prompt.
 */
export async function pressEnterPrompt(message: string): Promise<void> {
  if (isMockActive()) {
    recordCall('pressEnterPrompt', message);
    return;
  }

  const prompt = new TextPrompt({
    render() {
      if (this.state === 'submit' || this.state === 'cancel') return undefined;
      return `  ${dim('›')}  ${message}`;
    },
  });

  await prompt.prompt();
}
