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

import type { IntegrationDeclaration } from '@/core/framework/features';

import type { IntegrateAgentOptions } from '../_common/types.ts';

export const DEVIN_INTEGRATION_ID = 'devin';
const DEVIN_DISPLAY_NAME = 'Devin';

export type DevinIntegrationOptions = IntegrateAgentOptions;

// No features yet: until the epic CLI-1250 features land, `sonar integrate devin` fails with
// "No feature selected for Devin" because the framework rejects an integration with no feature.
export const devinIntegration: IntegrationDeclaration<DevinIntegrationOptions> = {
  id: DEVIN_INTEGRATION_ID,
  displayName: DEVIN_DISPLAY_NAME,
  features: [],
};
