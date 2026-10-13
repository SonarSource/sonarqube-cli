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

import { dlopen, FFIType } from 'bun:ffi';

const HANDLE_FLAG_INHERIT = 0x1;
const HANDLE_VALUE_STEP = 4n;
const MAX_SCANNED_HANDLE_VALUE = 0x10000n;

/**
 * Stop processes spawned from now on inheriting any of this process's handles. Bun.spawn on
 * Windows hands every inheritable handle to the child regardless of its `stdio` option, and the
 * process holds inheritable duplicates of the caller's stdio pipes, so a detached child would
 * otherwise keep those pipes open after we exit.
 *
 * Why: the telemetry flush worker spawned by `sonar hook` held the agent's stdout pipe open for
 * ~1 s after the hook exited. Claude Code waits only 500 ms for end-of-stream, then discards
 * the hook output as suspect, so e.g. the SubagentStart context never reached the subagent.
 */
export function disableHandleInheritance(): void {
  const kernel32 = dlopen('kernel32.dll', {
    GetHandleInformation: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.bool },
    SetHandleInformation: {
      args: [FFIType.u64, FFIType.u32, FFIType.u32],
      returns: FFIType.bool,
    },
  });
  try {
    const flags = new Uint32Array(1);
    for (
      let handle = HANDLE_VALUE_STEP;
      handle < MAX_SCANNED_HANDLE_VALUE;
      handle += HANDLE_VALUE_STEP
    ) {
      if (kernel32.symbols.GetHandleInformation(handle, flags) && flags[0] & HANDLE_FLAG_INHERIT) {
        kernel32.symbols.SetHandleInformation(handle, HANDLE_FLAG_INHERIT, 0);
      }
    }
  } finally {
    kernel32.close();
  }
}
