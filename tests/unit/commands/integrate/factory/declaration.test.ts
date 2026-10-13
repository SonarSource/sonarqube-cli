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
  FACTORY_CONFIG_DIR,
  factoryIntegration,
  resolveFactoryConfigDir,
} from '@/commands/integrate/factory/declaration.ts';
import type { IntegrationContext } from '@/core/framework/features';

describe('Factory declaration', () => {
  it('defines a state-only integration without file resources', () => {
    expect(factoryIntegration.id).toBe('factory');
    expect(factoryIntegration.features).toHaveLength(1);
    expect(factoryIntegration.features[0]?.resources).toEqual([]);
    expect(factoryIntegration.features[0]?.shouldInstall?.({} as never)).toEqual({
      action: 'install',
    });
  });

  it('resolves the shared global configuration directory from the target home', () => {
    expect(FACTORY_CONFIG_DIR).toBe('.factory');
    expect(resolveFactoryConfigDir({ targetRoot: '/home/user' } as IntegrationContext)).toBe(
      join('/home/user', '.factory'),
    );
  });
});
