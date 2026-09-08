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

import { errAsync, okAsync, unwrapOrThrow } from '@/core/result.ts';

describe('unwrapOrThrow', () => {
  it('resolves to the value of an ok result', async () => {
    expect(await unwrapOrThrow(okAsync('value'))).toBe('value');
  });

  it('throws the exact error instance of an err result', async () => {
    const error = new Error('boom');
    // eslint-disable-next-line @typescript-eslint/await-thenable
    await expect(unwrapOrThrow(errAsync(error))).rejects.toThrow(error);
    try {
      await unwrapOrThrow(errAsync(error));
      throw new Error('unwrapOrThrow should have thrown');
    } catch (thrown) {
      expect(thrown).toBe(error);
    }
  });
});
