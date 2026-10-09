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

// Cross-platform browser opening utility

import { ChildProcess, type spawn } from 'node:child_process';

import { describe, expect, it } from 'bun:test';

import { openBrowser } from '@/core/host/browser.ts';

describe('browser opener exit handling', () => {
  function fakeProcess() {
    const child = new ChildProcess();
    const spawnProcess = (() => child) as typeof spawn;
    return { child, spawnProcess };
  }

  it('confirms success only when the native opener succeeds', async () => {
    const { child, spawnProcess } = fakeProcess();
    const opening = openBrowser('https://example.test', spawnProcess);
    child.emit('exit', 0, null);
    await opening;
  });

  it.each([
    [2, null],
    [null, 'SIGTERM'],
  ] as const)('rejects an unsuccessful native opener: %s %s', async (code, signal) => {
    const { child, spawnProcess } = fakeProcess();
    const result = openBrowser('https://example.test', spawnProcess).catch(
      (error: unknown) => error,
    );
    child.emit('exit', code, signal);
    expect(await result).toBeInstanceOf(Error);
  });

  it('rejects a missing opener instead of claiming the browser opened', async () => {
    const { child, spawnProcess } = fakeProcess();
    const result = openBrowser('https://example.test', spawnProcess).catch(
      (error: unknown) => error,
    );
    child.emit('error', Object.assign(new Error('missing opener'), { code: 'ENOENT' }));
    expect(await result).toBeInstanceOf(Error);
  });
});
