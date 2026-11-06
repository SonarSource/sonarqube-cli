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

import { beforeEach, describe, expect, it } from 'bun:test';

import { ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import { SonarCommand } from '@/core/commands/sonar-command.ts';
import { buildCommandFacts } from '@/core/telemetry/command-executed.ts';
import { noteProject, resetProjectUuidContextForTests } from '@/core/telemetry/project-uuid.ts';

import { FakeConsole } from '../../../_common/fake-console.ts';

const AUTH = new ResolvedAuth({
  token: 'token-a',
  serverUrl: 'https://sonarcloud.io',
  orgKey: 'org-a',
  connectionType: 'cloud',
  source: 'state' as const,
});

async function commandEventAuth(): Promise<ResolvedAuth | null | undefined> {
  const command = new SonarCommand('sonar', { console: new FakeConsole() }).command('analyze');
  const [executed] = await buildCommandFacts(command);
  return executed.auth;
}

beforeEach(() => {
  resetProjectUuidContextForTests();
});

describe('buildCommandFacts() command event auth', () => {
  it('falls back to the invocation auth when no target project was noted', async () => {
    expect(await commandEventAuth()).toBeUndefined();
  });

  it('falls back to the invocation auth for a single target project', async () => {
    noteProject(AUTH, 'proj-a');

    expect(await commandEventAuth()).toBeUndefined();
  });

  it('has no server identity for several target projects, even on one connection', async () => {
    noteProject(AUTH, 'proj-a');
    noteProject(AUTH, 'proj-b');

    expect(await commandEventAuth()).toBeNull();
  });
});
