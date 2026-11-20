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

import { beforeEach, describe, expect, it } from 'bun:test';

import { resetUserWaitForTests, userWaitMs } from '@/core/telemetry/user-wait.ts';
import { waitInBrowser } from '@/core/ui/browser-step.ts';

import { FakeConsole } from '../../../_common/fake-console.ts';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

beforeEach(() => {
  resetUserWaitForTests();
});

describe('waitInBrowser()', () => {
  it('opens the URL, then waits, and returns what the wait resolves to', async () => {
    const events: string[] = [];

    const result = await waitInBrowser(
      'https://example.test/authorize',
      new FakeConsole(),
      () => {
        events.push('wait');
        return Promise.resolve('authorized');
      },
      (url) => {
        events.push(`open ${url}`);
        return Promise.resolve();
      },
    );

    expect(result).toBe('authorized');
    expect(events).toEqual(['open https://example.test/authorize', 'wait']);
  });

  it('counts the whole step as time spent waiting on the user', async () => {
    await waitInBrowser(
      'https://example.test/authorize',
      new FakeConsole(),
      () => sleep(20),
      () => sleep(10),
    );

    expect(userWaitMs()).toBeGreaterThanOrEqual(25);
  });
});
