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

import { measureUserWait, resetUserWaitForTests, userWaitMs } from '@/core/telemetry/user-wait.ts';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

beforeEach(() => {
  resetUserWaitForTests();
});

describe('measureUserWait()', () => {
  it('starts at zero', () => {
    expect(userWaitMs()).toBe(0);
  });

  it('returns the wait result and accumulates its duration', async () => {
    const result = await measureUserWait(async () => {
      await sleep(20);
      return 'answer';
    });
    await measureUserWait(() => sleep(20));

    expect(result).toBe('answer');
    expect(userWaitMs()).toBeGreaterThanOrEqual(35);
  });

  it('counts every wait it is given, a nested one included', async () => {
    await measureUserWait(async () => {
      await measureUserWait(() => sleep(20));
    });

    expect(userWaitMs()).toBeGreaterThanOrEqual(35);
  });

  it('still counts a wait that fails', async () => {
    const failing = measureUserWait(async () => {
      await sleep(20);
      throw new Error('cancelled');
    });

    const error = await failing.catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(Error);
    expect(userWaitMs()).toBeGreaterThanOrEqual(15);
  });
});
