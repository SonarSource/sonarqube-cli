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

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { clearMockUiCalls, getMockUiCalls, setMockUi } from '@/core/ui';

import {
  assertSonarCloudOrganization,
  buildAgentIntegrateContext,
  warnMissingIntegrateProjectKey,
} from '../../../../../src/commands/integrate/_common/agent-integrate-prelude.ts';
import type { ResolvedAuth } from '../../../../../src/lib/auth-resolver.ts';
import type { DiscoveredProject } from '../../../../../src/lib/project-workspace';

const AUTH: ResolvedAuth = {
  token: 'token',
  serverUrl: 'https://sonarcloud.io',
  orgKey: 'my-org',
  connectionType: 'cloud',
};

const PROJECT: DiscoveredProject = {
  rootDir: '/workspace',
  isGitRepo: false,
  configSources: [],
  projectKey: 'discovered-key',
};

describe('assertSonarCloudOrganization', () => {
  it('throws when SonarQube Cloud has no organization', () => {
    expect(() => assertSonarCloudOrganization('https://sonarcloud.io', undefined)).toThrow(
      'SonarQube Cloud requires an organization.',
    );
  });
});

describe('buildAgentIntegrateContext', () => {
  it('prefers --project over discovered project key', () => {
    const ctx = buildAgentIntegrateContext({ project: 'cli-key' }, AUTH, PROJECT);

    expect(ctx.projectKey).toBe('cli-key');
    expect(ctx.isGlobal).toBe(false);
  });
});

describe('warnMissingIntegrateProjectKey', () => {
  beforeEach(() => setMockUi(true));
  afterEach(() => {
    clearMockUiCalls();
    setMockUi(false);
  });

  it('warns for project-scoped install without a project key', () => {
    warnMissingIntegrateProjectKey('codex', false, undefined);

    expect(
      getMockUiCalls().some(
        (c) => c.method === 'warn' && String(c.args[0]).includes('sonar integrate codex --help'),
      ),
    ).toBe(true);
  });

  it('stays silent for global install without a project key', () => {
    warnMissingIntegrateProjectKey('copilot', true, undefined);

    expect(getMockUiCalls().some((c) => c.method === 'warn')).toBe(false);
  });
});
