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

import * as ffi from 'bun:ffi';
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';

import { disableHandleInheritance } from '@/core/host/windows-handle-inheritance.ts';

const HANDLE_FLAG_INHERIT = 0x1;

describe('disableHandleInheritance', () => {
  let handleFlags: Map<bigint, number>;
  let setHandleInformation: ReturnType<typeof mock>;
  let close: ReturnType<typeof mock>;
  let dlopenSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    handleFlags = new Map();
    setHandleInformation = mock(() => true);
    close = mock(() => undefined);
    dlopenSpy = spyOn(ffi, 'dlopen').mockImplementation(
      () =>
        ({
          symbols: {
            GetHandleInformation: (handle: bigint, flags: Uint32Array) => {
              const value = handleFlags.get(handle);
              if (value === undefined) return false;
              flags[0] = value;
              return true;
            },
            SetHandleInformation: setHandleInformation,
          },
          close,
        }) as never,
    );
  });

  afterEach(() => {
    dlopenSpy.mockRestore();
  });

  it('clears the inherit flag only on inheritable handles', () => {
    handleFlags.set(8n, HANDLE_FLAG_INHERIT);
    handleFlags.set(12n, 0);
    handleFlags.set(16n, HANDLE_FLAG_INHERIT | 0x2);

    disableHandleInheritance();

    expect(setHandleInformation.mock.calls).toEqual([
      [8n, HANDLE_FLAG_INHERIT, 0],
      [16n, HANDLE_FLAG_INHERIT, 0],
    ]);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('closes kernel32 when clearing a handle fails', () => {
    handleFlags.set(8n, HANDLE_FLAG_INHERIT);
    setHandleInformation.mockImplementation(() => {
      throw new Error('access denied');
    });

    expect(() => disableHandleInheritance()).toThrow('access denied');
    expect(close).toHaveBeenCalledTimes(1);
  });
});
