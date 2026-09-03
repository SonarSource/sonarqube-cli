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

import { setDefaultConsoleForTests } from '@/core/ui/default-console.ts';

import { FakeConsole } from './fake-console.ts';

/** Install a {@link FakeConsole} as the process default for free-function UI calls. */
export function installFakeConsole(): FakeConsole {
  const fake = new FakeConsole();
  setDefaultConsoleForTests(fake);
  return fake;
}

/** Restore the production default console after a test. */
export function restoreDefaultConsole(): void {
  setDefaultConsoleForTests(undefined);
}

export type { UiCall } from './fake-console.ts';
