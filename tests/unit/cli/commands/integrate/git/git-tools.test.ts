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

import { describe, expect, it } from 'bun:test';

import { IntegrationRegistry } from '../../../../../../src/cli/commands/integrate/_common/registry';
import {
  HUSKY_INTEGRATION_ID,
  NATIVE_GIT_INTEGRATION_ID,
  PRE_COMMIT_INTEGRATION_ID,
  registerGitIntegrations,
} from '../../../../../../src/cli/commands/integrate/git/tools';

describe('registerGitIntegrations', () => {
  it('is idempotent when git integrations are already registered', () => {
    const registry = new IntegrationRegistry();
    const expectedIntegrationIds = [
      NATIVE_GIT_INTEGRATION_ID,
      HUSKY_INTEGRATION_ID,
      PRE_COMMIT_INTEGRATION_ID,
    ];

    registerGitIntegrations(registry);

    expect(registry.list().map((integration) => integration.id)).toEqual(expectedIntegrationIds);
    expect(() => registerGitIntegrations(registry)).not.toThrow();
    expect(registry.list().map((integration) => integration.id)).toEqual(expectedIntegrationIds);
  });
});
