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

// Single import surface for `neverthrow` across the codebase. Everything that needs
// `Result` / `ResultAsync` imports it from here rather than from `neverthrow` directly,
// so the vocabulary (naming, the `orThrow()` extension below) stays centralized.

import { Err, Ok, ResultAsync } from 'neverthrow';

export { errAsync, okAsync, Result, ResultAsync } from 'neverthrow';

/* eslint-disable @typescript-eslint/no-unused-vars -- interface merging with neverthrow's
   classes requires matching their exact type parameter names and arity, even where this
   file's own additions don't reference one of them. */
declare module 'neverthrow' {
  interface ResultAsync<T, E> {
    /**
     * The one legitimate place a chain leaves the rail: the command boundary. Resolves
     * to the success value, or re-throws the error exactly as it would have been thrown
     * before this codebase used `Result`. Callers one frame up (ultimately
     * `SonarCommand.runCommand()`) are unchanged.
     *
     * Calling this immediately after a `Result`-returning call is almost always a smell:
     * it means the chain never got a chance to run past that call. Prefer `.andThen()` /
     * `.map()` to keep composing, and reserve `orThrow()` for the end of a pipeline.
     */
    orThrow(): Promise<T>;
  }

  interface Ok<T, E> {
    /** Sync counterpart of `ResultAsync.orThrow()`, for a `Result` already resolved. */
    orThrow(): T;
  }

  interface Err<T, E> {
    /** Sync counterpart of `ResultAsync.orThrow()`, for a `Result` already resolved. */
    orThrow(): never;
  }
}
/* eslint-enable @typescript-eslint/no-unused-vars */

// neverthrow doesn't ship `orThrow()` itself, so this attaches it once, here, to the
// three classes' prototypes. Every `.map()`/`.andThen()`/etc. call returns a `new
// ResultAsync(...)`/`Ok(...)`/`Err(...)` sharing this same prototype, so the method
// reaches the end of any chain built anywhere in the codebase. If a future neverthrow
// version ships its own `orThrow` with an incompatible signature, the `declare module`
// interface merge above will fail to compile rather than silently disagreeing with it.
//
// A prototype method can't itself be generic over the instance's T/E (those are erased
// at runtime, and TypeScript has no way to attach a per-call type parameter to an
// existing property slot). The `any`s below are that, not a shortcut; the typed surface
// callers actually see is the `declare module` block above.
/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-return */
ResultAsync.prototype.orThrow = function (this: ResultAsync<any, any>): Promise<any> {
  return this.match(
    (value: any) => value,
    (error: any) => {
      throw error;
    },
  );
};

Ok.prototype.orThrow = function (this: Ok<any, any>): any {
  return this.value;
};

Err.prototype.orThrow = function (this: Err<any, any>): never {
  throw this.error;
};
/* eslint-enable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-return */
