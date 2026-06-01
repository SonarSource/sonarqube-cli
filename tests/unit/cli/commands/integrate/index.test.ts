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

import { ALL_INTEGRATIONS, supportedIntegrations } from '../../../../../src/cli/commands/integrate';
import { createIntegrationRegistry } from '../../../../../src/cli/commands/integrate/_common/registry/core';

describe('ALL_INTEGRATIONS', () => {
  it('seeds the global supportedIntegrations registry in order', () => {
    const expectedIntegrationIds = ALL_INTEGRATIONS.map((integration) => integration.id);

    expect(supportedIntegrations.list().map((integration) => integration.id)).toEqual(
      expectedIntegrationIds,
    );
  });

  it('can seed a fresh registry from the static data', () => {
    const registry = createIntegrationRegistry(ALL_INTEGRATIONS);

    expect(registry.list().map((integration) => integration.id)).toEqual(
      ALL_INTEGRATIONS.map((integration) => integration.id),
    );
  });
});
