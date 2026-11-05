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

import { CommandFailedError } from '@/core/commands/command-error.ts';
import { pollUntil } from '@/core/commands/poll.ts';

describe('pollUntil', () => {
  it('returns the first value without waiting', async () => {
    let attempts = 0;

    const value = await pollUntil(
      () => {
        attempts += 1;
        return Promise.resolve('done');
      },
      Date.now() + 1000,
      'timed out',
    );

    expect(value).toBe('done');
    expect(attempts).toBe(1);
  });

  it('tries again after a pause when an attempt has no value yet', async () => {
    let attempts = 0;

    const value = await pollUntil(
      () => {
        attempts += 1;
        return Promise.resolve(attempts < 2 ? undefined : 'done');
      },
      Date.now() + 150,
      'timed out',
    );

    expect(value).toBe('done');
    expect(attempts).toBe(2);
  });

  it('fails with the given message once the deadline has passed', async () => {
    const error = await pollUntil(
      () => Promise.resolve(undefined),
      Date.now() + 50,
      'still running',
    ).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(CommandFailedError);
    expect((error as CommandFailedError).message).toBe('still running');
  });

  it('makes one attempt even when the deadline has already passed', async () => {
    let attempts = 0;

    const error = await pollUntil(
      () => {
        attempts += 1;
        return Promise.resolve(undefined);
      },
      Date.now() - 1,
      'expired',
    ).catch((cause: unknown) => cause);

    expect(attempts).toBe(1);
    expect((error as CommandFailedError).message).toBe('expired');
  });

  it('propagates an error thrown by an attempt', async () => {
    const attempt = () => Promise.reject(new Error('boom'));

    const error = await pollUntil(attempt, Date.now() + 1000, 'timed out').catch(
      (cause: unknown) => cause,
    );

    expect((error as Error).message).toBe('boom');
  });
});
