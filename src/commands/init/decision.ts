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

import { InvalidOptionError } from '@/core/commands/command-error.ts';

/**
 * A consent `init` needs but cannot ask for: the caller has to give it as an option. `options` are only
 * those that resolve this decision, so the hint never offers a path the situation rules out.
 */
export function missingDecision(situation: string, options: readonly string[]): InvalidOptionError {
  const choice = options.length === 1 ? options[0] : `one of ${options.join(', ')}`;
  return new InvalidOptionError(
    `${situation} Continuing needs an answer, and none can be asked.`,
    `Run 'sonar init' again with ${choice}.`,
  );
}
