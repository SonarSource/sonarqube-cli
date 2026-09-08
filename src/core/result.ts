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
// so the vocabulary (naming, the one collapse helper below) stays centralized.

export { errAsync, okAsync, Result, ResultAsync } from 'neverthrow';

import type { ResultAsync } from 'neverthrow';

/**
 * The one legitimate place a chain leaves the rail: the command boundary. Resolves to
 * the success value, or re-throws the error exactly as it would have been thrown before
 * this codebase used `Result` — callers one frame up (ultimately
 * `SonarCommand.runCommand()`) are unchanged.
 *
 * A `Result`-returning method that immediately does this is almost always a smell: it
 * means the chain never got a chance to run past this call. Prefer `.andThen()` /
 * `.map()` to keep composing, and reserve `unwrapOrThrow` for the end of a command's
 * pipeline.
 */
export function unwrapOrThrow<T, E extends Error>(result: ResultAsync<T, E>): Promise<T> {
  return result.match(
    (value) => value,
    (error) => {
      throw error;
    },
  );
}
