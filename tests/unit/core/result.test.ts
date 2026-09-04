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

import { Err, Ok, unwrap } from '@/core/result.ts';

describe('Result', () => {
  it('Ok wraps a value as an ok result', () => {
    const result = Ok(42);
    expect(result).toEqual({ ok: true, value: 42 });
  });

  it('Err wraps an error as a non-ok result', () => {
    const error = new Error('boom');
    const result = Err(error);
    expect(result).toEqual({ ok: false, error });
  });

  describe('unwrap', () => {
    it('returns the value of an ok result', () => {
      expect(unwrap(Ok('value'))).toBe('value');
    });

    it('throws the exact error instance of a non-ok result', () => {
      const error = new Error('boom');
      expect(() => unwrap(Err(error))).toThrow(error);
      try {
        unwrap(Err(error));
        throw new Error('unwrap should have thrown');
      } catch (thrown) {
        expect(thrown).toBe(error);
      }
    });
  });
});
