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

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';

import { RequestScheduler } from '@/core/devops/request-scheduler.ts';

describe('RequestScheduler', () => {
  let now: number;
  let timers: { at: number; run: () => void }[];
  let nowSpy: ReturnType<typeof spyOn>;
  let timeoutSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    now = 0;
    timers = [];
    nowSpy = spyOn(Date, 'now').mockImplementation(() => now);
    timeoutSpy = spyOn(globalThis, 'setTimeout').mockImplementation(((
      run: () => void,
      delay = 0,
    ) => {
      timers.push({ at: now + delay, run });
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout);
  });

  afterEach(() => {
    nowSpy.mockRestore();
    timeoutSpy.mockRestore();
  });

  async function advance(ms = 0): Promise<void> {
    now += ms;
    const due = timers.filter((timer) => timer.at <= now);
    timers = timers.filter((timer) => timer.at > now);
    due.forEach((timer) => timer.run());
    await Bun.sleep(0);
  }

  it('serializes writes with a gap after completion while allowing reads', async () => {
    const scheduler = new RequestScheduler();
    const starts: number[] = [];
    let finish: () => void = () => undefined;
    const first = scheduler.run(
      true,
      () =>
        new Promise<void>((resolve) => {
          starts.push(now);
          finish = resolve;
        }),
    );
    const second = scheduler.run(true, () => Promise.resolve(starts.push(now)));
    await advance();
    expect(starts).toEqual([0]);
    expect(await scheduler.run(false, () => Promise.resolve('read'))).toBe('read');
    finish();
    await advance();
    await advance(999);
    expect(starts).toEqual([0]);
    await advance(1);
    await Promise.all([first, second]);
    expect(starts).toEqual([0, 1000]);
  });

  it('extends the cooldown for waiting reads and writes without shortening it', async () => {
    const scheduler = new RequestScheduler();
    const starts: number[] = [];
    scheduler.coolDown(1000);
    const read = scheduler.run(false, () => Promise.resolve(starts.push(now)));
    const write = scheduler.run(true, () => Promise.resolve(starts.push(now)));
    await advance();
    scheduler.coolDown(2000);
    scheduler.coolDown(500);
    await advance(1000);
    expect(starts).toEqual([]);
    await advance(1000);
    await Promise.all([read, write]);
    expect(starts).toEqual([2000, 2000]);
  });

  it('honors a failed write cooldown before continuing the queue', async () => {
    const scheduler = new RequestScheduler();
    const starts: number[] = [];
    const first = scheduler
      .run(true, () => {
        scheduler.coolDown(3000);
        return Promise.reject(new Error('write rejected'));
      })
      .catch((error: unknown) => error);
    const second = scheduler.run(true, () => Promise.resolve(starts.push(now)));
    await advance();
    expect(await first).toBeInstanceOf(Error);
    await advance(1000);
    expect(starts).toEqual([]);
    await advance(2000);
    await second;
    expect(starts).toEqual([3000]);
  });
});
