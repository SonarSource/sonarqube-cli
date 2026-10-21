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

import { join } from 'node:path';

import { describe, expect, it } from 'bun:test';

import { VORTEX_FEATURE_ID } from '@/commands/integrate/_common/vortex.ts';
import {
  openCodeIntegration,
  resolveOpenCodeAgentsMdPath,
  resolveOpenCodeCagSkillPath,
  resolveOpenCodeMcpConfigPath,
  resolveOpenCodeSecretsPluginPath,
  resolveOpenCodeSqaaPluginPath,
} from '@/commands/integrate/opencode/declaration.ts';
import type { IntegrationContext } from '@/core/framework/features';
import { isFeatureContainer } from '@/core/framework/features/types.ts';

import { FakeConsole } from '../../../../_common/fake-console.ts';

function fakeContext(scope: IntegrationContext['scope'], targetRoot: string): IntegrationContext {
  return {
    targetRoot,
    scope,
    attrs: {},
    state: {} as never,
    executionMode: 'install',
    console: new FakeConsole(),
    resolvedDependencies: new Map(),
  };
}

describe('resolveOpenCodeSecretsPluginPath', () => {
  it('writes to ~/.config/opencode/plugins for the global scope', () => {
    expect(resolveOpenCodeSecretsPluginPath(fakeContext('global', '/home/jonathan'))).toBe(
      join('/home/jonathan', '.config', 'opencode', 'plugins', 'sonar-secrets.ts'),
    );
  });

  it('writes to <project>/.opencode/plugins for the project scope', () => {
    expect(resolveOpenCodeSecretsPluginPath(fakeContext('project', '/project/root'))).toBe(
      join('/project/root', '.opencode', 'plugins', 'sonar-secrets.ts'),
    );
  });
});

describe('resolveOpenCodeSqaaPluginPath', () => {
  it('writes next to the secrets plugin for the global scope', () => {
    expect(resolveOpenCodeSqaaPluginPath(fakeContext('global', '/home/jonathan'))).toBe(
      join('/home/jonathan', '.config', 'opencode', 'plugins', 'sonar-sqaa.ts'),
    );
  });

  it('writes to <project>/.opencode/plugins for the project scope', () => {
    expect(resolveOpenCodeSqaaPluginPath(fakeContext('project', '/project/root'))).toBe(
      join('/project/root', '.opencode', 'plugins', 'sonar-sqaa.ts'),
    );
  });
});

describe('resolveOpenCodeCagSkillPath', () => {
  it('writes ~/.config/opencode/skills/<name>/SKILL.md for the global scope', () => {
    expect(resolveOpenCodeCagSkillPath(fakeContext('global', '/home/jonathan'))).toBe(
      join(
        '/home/jonathan',
        '.config',
        'opencode',
        'skills',
        'sonar-context-augmentation',
        'SKILL.md',
      ),
    );
  });

  it('writes <project>/.opencode/skills/<name>/SKILL.md for the project scope', () => {
    expect(resolveOpenCodeCagSkillPath(fakeContext('project', '/project/root'))).toBe(
      join('/project/root', '.opencode', 'skills', 'sonar-context-augmentation', 'SKILL.md'),
    );
  });
});

describe('resolveOpenCodeAgentsMdPath', () => {
  it('writes ~/.config/opencode/AGENTS.md for the global scope', () => {
    expect(resolveOpenCodeAgentsMdPath(fakeContext('global', '/home/jonathan'))).toBe(
      join('/home/jonathan', '.config', 'opencode', 'AGENTS.md'),
    );
  });

  it('writes <project>/AGENTS.md for the project scope', () => {
    expect(resolveOpenCodeAgentsMdPath(fakeContext('project', '/project/root'))).toBe(
      join('/project/root', 'AGENTS.md'),
    );
  });
});

describe('resolveOpenCodeMcpConfigPath', () => {
  it('writes to <project>/opencode.json for the project scope', () => {
    expect(resolveOpenCodeMcpConfigPath(fakeContext('project', '/project/root'))).toBe(
      join('/project/root', 'opencode.json'),
    );
  });
});

describe('openCodeIntegration', () => {
  it('declares the secret-scanning-hooks feature backed by the sonar-secrets binary', () => {
    expect(openCodeIntegration.id).toBe('opencode');

    const feature = openCodeIntegration.features.find(
      (candidate) => candidate.id === 'sonar-secrets-hooks',
    );
    expect(feature?.dependencies).toHaveLength(1);
    expect(feature?.resources).toHaveLength(1);
  });

  it('declares the shared Vortex container with the SQAA plugin, instructions and the CAG skill as subfeatures', () => {
    const feature = openCodeIntegration.features.find(
      (candidate) => candidate.id === VORTEX_FEATURE_ID,
    );
    if (!feature || !isFeatureContainer(feature)) {
      throw new Error('Vortex container is not declared');
    }

    expect(feature.subfeatures.map((subfeature) => subfeature.id)).toEqual([
      'sonar-sqaa-hook',
      'sqaa-instructions',
      'context-augmentation',
    ]);
    const [sqaaHook, sqaaInstructions, contextAugmentation] = feature.subfeatures;
    for (const subfeature of [sqaaHook, sqaaInstructions]) {
      expect(subfeature.dependencies).toBeUndefined();
      expect(subfeature.resources).toHaveLength(1);
    }
    expect(contextAugmentation.dependencies).toHaveLength(1);
    expect(contextAugmentation.resources).toHaveLength(2);
    expect(contextAugmentation.operations).toHaveLength(1);
  });

  it('has no legacy CAG skill cleanup, since OpenCode never shipped one', () => {
    const feature = openCodeIntegration.features.find(
      (candidate) => candidate.id === VORTEX_FEATURE_ID,
    );

    expect(feature?.legacyCleanups).toEqual([]);
  });
});
