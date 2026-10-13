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

import type { IntegrationContext, IntegrationDeclaration } from '@/core/framework/features';
import { install } from '@/core/framework/features';

import type { IntegrateAgentOptions } from '../_common/types.ts';

export const FACTORY_INTEGRATION_ID = 'factory';
export const FACTORY_CONFIG_DIR = '.factory';

export type FactoryIntegrationOptions = IntegrateAgentOptions;

export function resolveFactoryConfigDir(context: IntegrationContext): string {
  return join(context.targetRoot, FACTORY_CONFIG_DIR);
}

export const factoryIntegration: IntegrationDeclaration<FactoryIntegrationOptions> = {
  id: FACTORY_INTEGRATION_ID,
  displayName: 'Factory',
  features: [
    {
      id: 'factory-integration',
      displayName: 'Factory integration',
      shouldInstall: () => install(),
      resources: [],
    },
  ],
};
