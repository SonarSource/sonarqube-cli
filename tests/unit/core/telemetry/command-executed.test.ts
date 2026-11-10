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

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import { SonarCommand } from '@/core/commands/sonar-command.ts';
import { ENV_SONAR_USER_HOME } from '@/core/config-constants.ts';
import { buildCommandFacts } from '@/core/telemetry/command-executed.ts';
import { noteProject, resetProjectUuidContextForTests } from '@/core/telemetry/project-uuid.ts';

import { FakeConsole } from '../../../_common/fake-console.ts';
import { restoreEnv } from '../../../_common/isolated-cli-env.ts';
import { mockProjectUuidGetSafe } from './project-uuid-api-mock.ts';

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

describe('buildCommandFacts() target project events', () => {
  let testDir: string;
  let savedSonarUserHome: string | undefined;
  let savedDoNotTrack: string | undefined;

  beforeEach(() => {
    savedSonarUserHome = process.env[ENV_SONAR_USER_HOME];
    savedDoNotTrack = process.env.DO_NOT_TRACK;
    testDir = mkdtempSync(join(tmpdir(), 'command-executed-test-'));
    process.env[ENV_SONAR_USER_HOME] = testDir;
    delete process.env.DO_NOT_TRACK;
  });

  afterEach(() => {
    restoreEnv(ENV_SONAR_USER_HOME, savedSonarUserHome);
    restoreEnv('DO_NOT_TRACK', savedDoNotTrack);
    rmSync(testDir, { recursive: true, force: true });
  });

  it('emits events only for resolved projects but counts every target project', async () => {
    const getSafeSpy = mockProjectUuidGetSafe({ idByProjectKey: { 'proj-a': 'AV-a' } });
    noteProject(AUTH, 'proj-a');
    noteProject(AUTH, 'proj-unresolved');

    const command = new SonarCommand('sonar', { console: new FakeConsole() }).command('analyze');
    const [executed, ...targetProjects] = await buildCommandFacts(command);

    expect(executed.payload).toMatchObject({ target_project_count: 2, project_uuid: null });
    expect(targetProjects.map((fact) => fact.payload)).toEqual([
      expect.objectContaining({ project_uuid: 'AV-a' }),
    ]);
    getSafeSpy.mockRestore();
  });
});
