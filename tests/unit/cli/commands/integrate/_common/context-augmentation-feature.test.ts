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

import { describe, expect, test } from 'bun:test';

import {
  CONTEXT_AUGMENTATION_TOOL_INTEGRATION_OPERATION_ID,
  createContextAugmentationFeature,
} from '../../../../../../src/cli/commands/integrate/_common/features/context-augmentation-feature';
import type { IntegrationContext } from '../../../../../src/cli/commands/integrate/_common/registry/types';

function makeContext(overrides: Partial<IntegrationContext> = {}): IntegrationContext {
  return {
    state: {
      integrations: { installed: [] },
      dependencies: { installed: [] },
    } as IntegrationContext['state'],
    targetRoot: '/tmp',
    scope: 'global',
    executionMode: 'install',
    resolvedDependencies: new Map(),
    ...overrides,
  };
}

describe('createContextAugmentationFeature', () => {
  test('skips tool integrate on global install without a project key', () => {
    const feature = createContextAugmentationFeature({
      targetPath: () => '/tmp/skill.md',
    });
    const operation = feature.operations?.find(
      (entry) => entry.id === CONTEXT_AUGMENTATION_TOOL_INTEGRATION_OPERATION_ID,
    );
    expect(operation?.shouldApply).toBeDefined();

    const shouldApply = operation!.shouldApply!(makeContext({ attrs: { projectKey: null } }));
    expect(shouldApply).toBe(false);
  });

  test('runs tool integrate on project install with a project key', () => {
    const feature = createContextAugmentationFeature({
      targetPath: () => '/tmp/skill.md',
    });
    const operation = feature.operations?.find(
      (entry) => entry.id === CONTEXT_AUGMENTATION_TOOL_INTEGRATION_OPERATION_ID,
    );

    const shouldApply = operation!.shouldApply!(
      makeContext({
        scope: 'project',
        attrs: { projectKey: 'my-org:demo' },
      }),
    );
    expect(shouldApply).toBe(true);
  });
});
