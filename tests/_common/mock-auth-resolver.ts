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

import { spyOn } from 'bun:test';

import { AuthResolver, type ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import { type CliRuntime, createCliRuntime } from '@/core/commands/cli-runtime.ts';
import { okAsync } from '@/core/result.ts';

export type MockAuthResolver = {
  runtime: CliRuntime;
  authResolver: AuthResolver;
  resolveAuthSpy: ReturnType<typeof spyOn>;
};

export function mockAuthResolver(auth: ResolvedAuth | null): MockAuthResolver {
  const authResolver = new AuthResolver();
  const resolveAuthSpy = spyOn(authResolver, 'resolveAuth').mockReturnValue(okAsync(auth));
  const runtime = createCliRuntime({ authResolver });
  return { runtime, authResolver, resolveAuthSpy };
}
