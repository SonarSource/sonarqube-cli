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

// Bun test preload: `toBeOkWith()` / `toBeErrWith()` (CLI-1086) assert directly on an
// already-resolved `Result<T, Error>` (the value of an awaited `ResultAsync`, or a plain
// `Ok`/`Err`) instead of unwrapping it by hand first. Unwrapping with `.orThrow()` inside
// a test throws, so a failure reports as an uncaught exception rather than a clear
// expected/received diff; these read the Ok value or Err error off the Result themselves.

import { expect } from 'bun:test';

import { isResult } from '@/core/result.ts';

/* eslint-disable @typescript-eslint/no-unused-vars -- interface merging with bun:test's own
   Matchers<T = unknown> requires matching its type parameter exactly, even though neither
   custom matcher below references it. */
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

expect.extend({
  toBeOkWith(actual: unknown, expected: unknown) {
    if (!isResult(actual)) {
      throw new Error(
        'toBeOkWith() expects a Result value (e.g. the resolved value of a ResultAsync)',
      );
    }
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
    if (!isResult(actual)) {
      throw new Error(
        'toBeErrWith() expects a Result value (e.g. the resolved value of a ResultAsync)',
      );
    }
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
