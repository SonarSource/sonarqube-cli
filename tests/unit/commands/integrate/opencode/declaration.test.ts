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

import {
  openCodeIntegration,
  resolveOpenCodePluginPath,
} from '@/commands/integrate/opencode/declaration.ts';
import type { IntegrationContext } from '@/core/framework/features';

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

describe('resolveOpenCodePluginPath', () => {
  it('writes to ~/.config/opencode/plugins for the global scope', () => {
    expect(resolveOpenCodePluginPath(fakeContext('global', '/home/jonathan'))).toBe(
      join('/home/jonathan', '.config', 'opencode', 'plugins', 'sonar.ts'),
    );
  });

  it('writes to <project>/.opencode/plugins for the project scope', () => {
    expect(resolveOpenCodePluginPath(fakeContext('project', '/project/root'))).toBe(
      join('/project/root', '.opencode', 'plugins', 'sonar.ts'),
    );
  });
});

describe('openCodeIntegration', () => {
  it('declares a single secret-scanning-hooks feature backed by the sonar-secrets binary', () => {
    expect(openCodeIntegration.id).toBe('opencode');
    expect(openCodeIntegration.features).toHaveLength(1);

    const [feature] = openCodeIntegration.features;
    expect(feature.dependencies).toHaveLength(1);
    expect(feature.resources).toHaveLength(1);
  });
});
