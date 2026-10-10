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

import { afterEach, describe, expect, it } from 'bun:test';

import {
  CONTEXT_AUGMENTATION_FEATURE_ID,
  CONTEXT_AUGMENTATION_INSTRUCTIONS_BODY,
  createContextAugmentationSkillSubfeature,
} from '@/commands/integrate/_common/features/context-augmentation-feature.ts';
import type { IntegrateAgentOptions } from '@/commands/integrate/_common/types.ts';
import type { IntegrationContext } from '@/core/framework/features/types.ts';

const SKIP_ENV = '__SQCLI_DEV_SKIP_CAG';

const subfeature = createContextAugmentationSkillSubfeature<IntegrateAgentOptions>({
  targetPath: () => '/skills/SKILL.md',
  instructionsTargetPath: () => '/AGENTS.md',
});

describe('createContextAugmentationSkillSubfeature', () => {
  afterEach(() => {
    delete process.env[SKIP_ENV];
  });

  it('uses the context-augmentation feature id', () => {
    expect(subfeature.id).toBe(CONTEXT_AUGMENTATION_FEATURE_ID);
  });

  it('declares the skill file and the instructions snippet as resources', () => {
    expect(subfeature.resources?.map((resource) => resource.id)).toEqual([
      'context-augmentation-skill',
      'context-augmentation-instructions-file',
    ]);
  });

  it('declares the Context binary as its only dependency', () => {
    expect(subfeature.dependencies).toHaveLength(1);
  });

  it('is available by default', async () => {
    expect(await subfeature.isAvailable?.({} as never)).toEqual({ available: true });
  });

  it('is unavailable when Context augmentation is disabled by the dev flag', async () => {
    process.env[SKIP_ENV] = '1';

    expect(await subfeature.isAvailable?.({} as never)).toEqual({ available: false });
  });

  it('runs the tool integration only for a project-scope install with a project key', () => {
    const operation = subfeature.operations?.[0];
    const context = (
      scope: IntegrationContext['scope'],
      attrs: Record<string, unknown>,
    ): IntegrationContext =>
      ({ scope, attrs, executionMode: 'install', targetRoot: '/project' }) as never;

    expect(operation?.shouldApply?.(context('project', { projectKey: 'proj' }))).toBe(true);
    expect(operation?.shouldApply?.(context('project', {}))).toBe(false);
    expect(operation?.shouldApply?.(context('global', { projectKey: 'proj' }))).toBe(false);
  });
});

describe('CONTEXT_AUGMENTATION_INSTRUCTIONS_BODY', () => {
  it('tells the agent to load the skill and to use the sonar context commands', () => {
    expect(CONTEXT_AUGMENTATION_INSTRUCTIONS_BODY).toContain('`sonar-context-augmentation` skill');
    expect(CONTEXT_AUGMENTATION_INSTRUCTIONS_BODY).toContain('`sonar context guidelines get`');
    expect(CONTEXT_AUGMENTATION_INSTRUCTIONS_BODY).toContain('`sonar context navigation`');
  });
});
