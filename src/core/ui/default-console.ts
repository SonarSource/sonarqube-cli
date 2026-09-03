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

import type { Console } from './console.ts';
import { TerminalConsole } from './terminal-console.ts';

let defaultConsole: Console | undefined;

/** Process-wide production console. Command contexts share this instance unless overridden. */
export function getDefaultConsole(): Console {
  defaultConsole ??= new TerminalConsole();
  return defaultConsole;
}

/** @internal Unit tests only — replaces or clears the process default console. */
export function setDefaultConsoleForTests(console?: Console): void {
  defaultConsole = console;
}
