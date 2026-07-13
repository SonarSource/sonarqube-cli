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

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

import type {
  AppliedResource,
  IntegrationContext,
  ResourceDeclaration,
} from '../../../../../../src/cli/commands/integrate/_common/registry';
import { CONTEXT_AUGMENTATION_BINARY_NAME } from '../../../../../../src/lib/install-types';
import { getDefaultState } from '../../../../../../src/lib/state';
import { findMockUiCall, setMockUi } from '../../../../../../src/ui';

let toolIntegrateError = new Error('tool integrate failed');

const integrateCagModule =
  await import('../../../../../../src/cli/commands/integrate/_common/context-augmentation');
await mock.module(
  '../../../../../../src/cli/commands/integrate/_common/context-augmentation',
  () => ({
    ...integrateCagModule,
    printContextAugmentationSkill: () => Promise.resolve('skill'),
    runToolIntegrateCommand: () => Promise.reject(toolIntegrateError),
  }),
);

const { createContextAugmentationFeature } =
  await import('../../../../../../src/cli/commands/integrate/_common/features/context-augmentation-feature');

describe('createContextAugmentationFeature', () => {
  beforeEach(() => {
    toolIntegrateError = new Error('tool integrate failed');
    setMockUi(true);
  });

  afterEach(() => {
    setMockUi(false);
  });

  it('attempts all extra resource rollbacks and rethrows the original tool integrate error', async () => {
    const removed: string[] = [];
    const rollbackError = new Error('rollback failed');
    const feature = createContextAugmentationFeature({
      integrationId: 'test-integration',
      targetPath: () => 'SKILL.md',
      resources: [
        makeResource('first-extra-resource', () => {
          removed.push('first-extra-resource');
        }),
        makeResource('second-extra-resource', () => {
          removed.push('second-extra-resource');
          throw rollbackError;
        }),
      ],
    });
    const operation = feature.operations?.[0];

    expect(operation).toBeDefined();
    let caught: unknown;
    try {
      await Promise.resolve().then(() => operation!.apply(makeContext()));
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(toolIntegrateError);
    expect(removed).toEqual(['second-extra-resource', 'first-extra-resource']);
    expect(
      findMockUiCall('warn', 'Manual cleanup may be needed for: second-extra-resource'),
    ).toBeDefined();
  });
});

function makeResource(id: string, remove: () => void): ResourceDeclaration {
  return {
    id,
    resourceType: 'test-resource',
    apply: () => ({ id, resourceType: 'test-resource' }) satisfies AppliedResource,
    isApplied: () => true,
    remove,
  };
}

function makeContext(): IntegrationContext {
  return {
    state: getDefaultState('test'),
    targetRoot: '/tmp/project',
    scope: 'project',
    executionMode: 'install',
    auth: {
      connectionType: 'cloud',
      orgKey: 'org',
      serverUrl: 'https://sonarcloud.io',
      token: 'token',
    },
    resolvedDependencies: new Map([
      [
        CONTEXT_AUGMENTATION_BINARY_NAME,
        {
          id: CONTEXT_AUGMENTATION_BINARY_NAME,
          dependencyType: 'sonarsource-binary',
          path: '/tmp/sonar-context-augmentation',
        },
      ],
    ]),
  };
}
