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

import { describe, expect, it, spyOn } from 'bun:test';

import { authStatus } from '@/commands/auth/status.ts';
import { AuthResolver } from '@/core/auth/auth-resolver.ts';
import { createCliRuntime } from '@/core/commands/cli-runtime.ts';
import { CommandFailedError } from '@/core/commands/command-error.ts';
import { CommandInvocationContext } from '@/core/commands/invocation-context.ts';
import { okAsync } from '@/core/result.ts';

import { FakeConsole } from '../../../_common/fake-console.ts';

describe('authStatus with FakeConsole', () => {
  it('prints "No saved connection" through ctx.console when nothing is stored', async () => {
    const authResolver = new AuthResolver();
    spyOn(authResolver, 'resolveAuth').mockReturnValue(okAsync(null));

    const fake = new FakeConsole();
    const ctx = new CommandInvocationContext(fake, undefined, createCliRuntime({ authResolver }));

    try {
      await authStatus(ctx);
      expect.unreachable('authStatus should reject when nothing is stored');
    } catch (err) {
      expect(err).toBeInstanceOf(CommandFailedError);
    }
    expect(fake.findCall('print', 'No saved connection')).toBeDefined();
  });
});
