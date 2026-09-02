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

import type { Command } from 'commander';

function commandPath(command: Command): string {
  const names = [command.name()];

  for (let parent = command.parent; parent?.parent; parent = parent.parent) {
    names.unshift(parent.name());
  }

  return names.join(' ');
}

/** Full invocation path including the program name, e.g. `sonar mcp start`. */
export function qualifiedCommandPath(command: Command): string {
  if (!command.parent) {
    return command.name();
  }

  let root = command.parent;
  while (root.parent) {
    root = root.parent;
  }
  return `${root.name()} ${commandPath(command)}`;
}
