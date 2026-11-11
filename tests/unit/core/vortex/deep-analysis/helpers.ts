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

import type { Database } from 'bun:sqlite';
import { mock } from 'bun:test';

export function createDatabaseStub() {
  const get = mock<(...bindings: unknown[]) => unknown>(() => null);
  const all = mock<(...bindings: unknown[]) => unknown[]>(() => []);
  const runStatement = mock((..._bindings: unknown[]) => undefined);
  const prepare = mock((_sql: string) => ({ get, all, run: runStatement }));
  const run = mock((_sql: string) => undefined);
  const close = mock(() => undefined);
  const immediate = mock<() => unknown>(() => undefined);
  const transaction = mock((callback: () => unknown) => {
    immediate.mockImplementation(callback);
    return { immediate };
  });
  const db = { prepare, run, close, transaction } as unknown as Database;
  return { db, prepare, get, all, runStatement, run, close, immediate, transaction };
}
