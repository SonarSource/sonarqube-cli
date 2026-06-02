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

import { createIntegrationRegistry } from '../../../../../../src/cli/commands/integrate/_common/registry/core';
import {
  GIT_INTEGRATIONS,
  HUSKY_INTEGRATION_ID,
  NATIVE_GIT_INTEGRATION_ID,
  PRE_COMMIT_INTEGRATION_ID,
} from '../../../../../../src/cli/commands/integrate/git/tools';

describe('GIT_INTEGRATIONS', () => {
  it('can seed a registry from the static git integrations list', () => {
    const expectedIntegrationIds = [
      NATIVE_GIT_INTEGRATION_ID,
      HUSKY_INTEGRATION_ID,
      PRE_COMMIT_INTEGRATION_ID,
    ];

    const registry = createIntegrationRegistry(GIT_INTEGRATIONS);

    expect(registry.list().map((integration) => integration.id)).toEqual(expectedIntegrationIds);
  });
});
