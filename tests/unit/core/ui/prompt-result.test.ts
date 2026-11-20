/*
 * SonarQube CLI
 * Copyright (C) SonarSource Sàrl
 * mailto:info AT sonarsource DOT com
 *
 * This program is free software; you can redistribute it and/or
 * modify it under the terms of the GNU Lesser General Public
 * License as published by the Free Software Foundation; either
 * version 3 of the License, or (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
 * Lesser General Public License for more details.
 *
 * You should have received a copy of the GNU Lesser General Public License
 * along with this program; if not, write to the Free Software Foundation,
 * Inc., 51 Franklin Street, Fifth Floor, Boston, MA  02110-1301, USA.
 */

import { describe, expect, it } from 'bun:test';

import { classifyInitFailure } from '@/commands/init/telemetry/failure-reason.ts';
import { CancelledByUserError } from '@/core/commands/command-error.ts';
import { PromptCancelledError, PromptResult } from '@/core/ui/prompt-result.ts';

import { FakeConsole } from '../../../_common/fake-console.ts';

async function thrownBy(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}

describe('PromptResult', () => {
  it('resolves to the answer', async () => {
    expect(await PromptResult.fromAnswer(Promise.resolve('yes')).orThrow()).toBe('yes');
  });

  it('keeps a falsy answer, which is not a cancellation', async () => {
    expect(await PromptResult.fromAnswer(Promise.resolve(false)).orThrow()).toBe(false);
  });

  it('turns a cancelled prompt into an error that telemetry reports as cancelled', async () => {
    const error = await thrownBy(PromptResult.fromAnswer(Promise.resolve(null)).orThrow());

    expect(error).toBeInstanceOf(PromptCancelledError);
    expect(classifyInitFailure(error)).toBe('cancelled');
  });

  it('names the cancellation with onCancellation', async () => {
    const error = await thrownBy(
      PromptResult.fromAnswer(Promise.resolve(null)).onCancellation('Login cancelled').orThrow(),
    );

    expect(error).toBeInstanceOf(CancelledByUserError);
    expect((error as Error).message).toBe('Login cancelled');
  });

  it('leaves an answer untouched by onCancellation', async () => {
    const answer = await PromptResult.fromAnswer(Promise.resolve('my-org'))
      .onCancellation('Organization selection cancelled')
      .orThrow();

    expect(answer).toBe('my-org');
  });
});

describe('Console …Result prompts', () => {
  it('report a cancelled prompt as an error and an answer as the value', async () => {
    const console = new FakeConsole();
    console.queueResponse(null);
    console.queueResponse('cloud');

    const cancelled = await console.selectPromptResult('Where?', []);
    const answered = await console.selectPromptResult('Where?', []);

    expect(cancelled.isErr()).toBe(true);
    expect(answered.isOk() && answered.value).toBe('cloud');
  });
});
