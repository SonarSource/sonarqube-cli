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

import { CancelledByUserError } from '@/core/commands/command-error.ts';
import { err, ok, type Result, ResultAsync } from '@/core/result.ts';

/** The user left a prompt with Ctrl+C, EOF or Esc. */
export class PromptCancelledError extends CancelledByUserError {
  constructor() {
    super('Prompt cancelled');
    this.name = 'PromptCancelledError';
  }
}

/** A prompt's answer, or its cancellation as an error. */
export class PromptResult<T> extends ResultAsync<T, PromptCancelledError> {
  /** `null` is how the plain prompts report a cancellation. */
  static fromAnswer<T>(answer: Promise<T | null>): PromptResult<T> {
    return new PromptResult(
      answer.then((value): Result<T, PromptCancelledError> =>
        value === null ? err(new PromptCancelledError()) : ok(value),
      ),
    );
  }

  /** Names what the cancellation aborts: it then fails the command with `message`. */
  onCancellation(message: string): ResultAsync<T, CancelledByUserError> {
    return this.mapErr(() => new CancelledByUserError(message));
  }
}
