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

import { describe, expect, it } from 'bun:test';

import type { PatStatus } from '@/commands/import/server/pat-status.ts';
import {
  DEFAULT_PAT_POLL_INTERVAL_MS,
  DEFAULT_PAT_WAIT_TIMEOUT_MS,
  waitForPat,
} from '@/commands/import/server/wait-for-pat.ts';
import { ServerError } from '@/core/server/errors.ts';

function harness(statuses: PatStatus[]) {
  let clock = 0;
  const sleeps: number[] = [];
  let polls = 0;
  return {
    sleeps,
    polls: () => polls,
    options: {
      check: () => {
        polls++;
        return Promise.resolve(statuses[Math.min(polls, statuses.length) - 1]);
      },
      sleep: (ms: number) => {
        sleeps.push(ms);
        clock += ms;
        return Promise.resolve();
      },
      now: () => clock,
    },
  };
}

describe('waitForPat', () => {
  it('uses a 3 second poll interval and a 5 minute timeout by default', () => {
    expect(DEFAULT_PAT_POLL_INTERVAL_MS).toBe(3000);
    expect(DEFAULT_PAT_WAIT_TIMEOUT_MS).toBe(300_000);
  });

  it('applies the defaults when no interval or timeout is given', async () => {
    const h = harness(['missing']);

    expect(await waitForPat({ ...h.options, initial: 'missing' })).toBe('timeout');
    expect(h.sleeps.every((ms) => ms === 3000)).toBe(true);
    expect(h.sleeps).toHaveLength(100);
  });

  it('resolves valid on the first poll, after one interval', async () => {
    const h = harness(['valid']);

    expect(await waitForPat({ ...h.options, initial: 'missing' })).toBe('valid');
    expect(h.sleeps).toEqual([3000]);
    expect(h.polls()).toBe(1);
  });

  it('keeps waiting while the token is missing, then resolves valid', async () => {
    const h = harness(['missing', 'missing', 'valid']);

    expect(await waitForPat({ ...h.options, initial: 'missing' })).toBe('valid');
    expect(h.polls()).toBe(3);
  });

  it('stops with invalid when a missing token turns out to be a bad one', async () => {
    const h = harness(['missing', 'invalid', 'valid']);

    expect(await waitForPat({ ...h.options, initial: 'missing' })).toBe('invalid');
    expect(h.polls()).toBe(2);
  });

  it('keeps waiting while an already-invalid token stays invalid, then resolves valid', async () => {
    const h = harness(['invalid', 'missing', 'invalid', 'valid']);

    expect(await waitForPat({ ...h.options, initial: 'invalid' })).toBe('valid');
    expect(h.polls()).toBe(4);
  });

  it('times out once the deadline passes', async () => {
    const h = harness(['missing']);

    const result = await waitForPat({
      ...h.options,
      initial: 'invalid',
      intervalMs: 1000,
      timeoutMs: 2500,
    });

    expect(result).toBe('timeout');
    expect(h.sleeps).toEqual([1000, 1000, 500]);
    expect(h.polls()).toBe(3);
  });

  it('resolves aborted without polling when already aborted', async () => {
    const h = harness(['valid']);

    const result = await waitForPat({
      ...h.options,
      initial: 'missing',
      signal: AbortSignal.abort(),
    });

    expect(result).toBe('aborted');
    expect(h.sleeps).toEqual([]);
    expect(h.polls()).toBe(0);
  });

  it('resolves aborted without a further poll when aborted during a sleep', async () => {
    const h = harness(['valid']);
    const controller = new AbortController();

    const result = await waitForPat({
      ...h.options,
      initial: 'missing',
      signal: controller.signal,
      sleep: (ms) => {
        controller.abort();
        return h.options.sleep(ms);
      },
    });

    expect(result).toBe('aborted');
    expect(h.polls()).toBe(0);
  });

  it('interrupts the default sleep as soon as the signal aborts', async () => {
    const controller = new AbortController();
    let polls = 0;

    const pending = waitForPat({
      check: () => {
        polls++;
        return Promise.resolve('missing');
      },
      initial: 'missing',
      intervalMs: 60_000,
      timeoutMs: 600_000,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 10);

    expect(await pending).toBe('aborted');
    expect(polls).toBe(0);
  });

  it('propagates an error thrown by check unchanged', async () => {
    const h = harness(['missing']);
    const failure = new ServerError(500, 'boom');
    let polls = 0;

    const pending = waitForPat({
      ...h.options,
      initial: 'missing',
      check: () => {
        polls++;
        return polls === 1 ? Promise.resolve<PatStatus>('missing') : Promise.reject(failure);
      },
    });

    expect(await pending.catch((error: unknown) => error)).toBe(failure);
    expect(polls).toBe(2);
  });
});
