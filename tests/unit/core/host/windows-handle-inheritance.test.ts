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
const FILE_TYPE_DISK = 0x1;
const FILE_TYPE_PIPE = 0x3;
const FILE_TYPE_UNKNOWN = 0x0;

describe('disableHandleInheritance', () => {
  let handleFlags: Map<bigint, number>;
  let fileTypes: Map<bigint, number>;
  let setHandleInformation: ReturnType<typeof mock>;
  let close: ReturnType<typeof mock>;
  let dlopenSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    handleFlags = new Map();
    fileTypes = new Map();
    setHandleInformation = mock(() => true);
    close = mock(() => undefined);
    dlopenSpy = spyOn(ffi, 'dlopen').mockImplementation(
      () =>
        ({
          symbols: {
            GetFileType: (handle: bigint) => fileTypes.get(handle) ?? FILE_TYPE_UNKNOWN,
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

  it('clears the inherit flag only on inheritable pipe handles', () => {
    handleFlags.set(8n, HANDLE_FLAG_INHERIT);
    fileTypes.set(8n, FILE_TYPE_PIPE);
    handleFlags.set(12n, 0);
    fileTypes.set(12n, FILE_TYPE_PIPE);
    handleFlags.set(16n, HANDLE_FLAG_INHERIT | 0x2);
    fileTypes.set(16n, FILE_TYPE_PIPE);
    handleFlags.set(20n, HANDLE_FLAG_INHERIT);
    fileTypes.set(20n, FILE_TYPE_DISK);
    handleFlags.set(24n, HANDLE_FLAG_INHERIT);

    disableHandleInheritance();

    expect(setHandleInformation.mock.calls).toEqual([
      [8n, HANDLE_FLAG_INHERIT, 0],
      [16n, HANDLE_FLAG_INHERIT, 0],
    ]);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('closes kernel32 when clearing a handle fails', () => {
    handleFlags.set(8n, HANDLE_FLAG_INHERIT);
    fileTypes.set(8n, FILE_TYPE_PIPE);
    setHandleInformation.mockImplementation(() => {
      throw new Error('access denied');
    });

    expect(() => disableHandleInheritance()).toThrow('access denied');
    expect(close).toHaveBeenCalledTimes(1);
  });
});
