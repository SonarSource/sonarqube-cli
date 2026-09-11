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

// Bun test preload asserting on an already-resolved `Result` without unwrapping it first:
// `.orThrow()` inside a test throws, so a failure surfaces as an uncaught exception instead
// of an expected/received diff.

import { expect } from 'bun:test';

import { isResult, type Result } from '@/core/result.ts';

/* eslint-disable @typescript-eslint/no-unused-vars -- merging into bun:test's own
   `Matchers<T = unknown>` requires its exact type parameter, unreferenced here or not;
   renaming it to `_T` fails as TS2428. */
declare module 'bun:test' {
  interface Matchers<T = unknown> {
    /** Asserts the received value is an `Ok` whose value deep-equals `expected`. */
    toBeOkWith(expected: unknown): void;
    /**
     * Asserts the received value is an `Err`. With no argument, only the failure branch is
     * checked. A string checks `error.message` for equality; a function receives the
     * unwrapped error and must return whether it matches.
     */
    toBeErrWith(expected?: string | ((error: Error) => boolean)): void;
  }
}
/* eslint-enable @typescript-eslint/no-unused-vars */

/** Rejects a non-`Result` as a mistake in the test itself, not as a failed assertion. */
function assertResult(value: unknown, matcher: string): asserts value is Result<unknown, Error> {
  if (!isResult(value)) {
    throw new Error(
      `${matcher}() expects a Result value (e.g. the resolved value of a ResultAsync)`,
    );
  }
}

expect.extend({
  toBeOkWith(actual: unknown, expected: unknown) {
    assertResult(actual, 'toBeOkWith');
    if (actual.isErr()) {
      return {
        pass: false,
        message: () =>
          `expected an Ok result but got Err(${this.utils.printReceived(actual._unsafeUnwrapErr())})`,
      };
    }
    const value = actual._unsafeUnwrap();
    const pass = this.equals(value, expected);
    return {
      pass,
      message: () =>
        this.isNot
          ? `expected the result not to be Ok(${this.utils.printExpected(expected)})`
          : `expected Ok(${this.utils.printExpected(expected)}) but got Ok(${this.utils.printReceived(value)})`,
    };
  },
  toBeErrWith(actual: unknown, expected?: string | ((error: Error) => boolean)) {
    assertResult(actual, 'toBeErrWith');
    if (actual.isOk()) {
      return {
        pass: false,
        message: () =>
          `expected an Err result but got Ok(${this.utils.printReceived(actual._unsafeUnwrap())})`,
      };
    }
    if (expected === undefined) {
      return {
        pass: true,
        message: () =>
          this.isNot ? 'expected the result not to be Err' : 'expected an Err result',
      };
    }
    const error = actual._unsafeUnwrapErr();
    const pass = typeof expected === 'string' ? error.message === expected : expected(error);
    return {
      pass,
      message: () => {
        if (typeof expected === 'string') {
          return this.isNot
            ? `expected the Err message not to be ${this.utils.printExpected(expected)}`
            : `expected Err message ${this.utils.printExpected(expected)} but got ${this.utils.printReceived(error.message)}`;
        }
        return this.isNot
          ? `expected Err(${this.utils.printReceived(error)}) not to satisfy the given predicate`
          : `expected Err(${this.utils.printReceived(error)}) to satisfy the given predicate`;
      },
    };
  },
});
