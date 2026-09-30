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
// Print a stored sonar config value

import type { CommandInvocationContext } from '@/core/commands/invocation-context.ts';
import { getConfigValue, getKeyDefinition } from '@/core/config/config-repository.ts';
import type { ConfigKey } from '@/core/config/config-schema.ts';

const NOT_SET_MESSAGE = 'Not set.';

export async function getConfig(key: string, ctx: CommandInvocationContext): Promise<void> {
  const { console } = ctx;
  const configKey = key as ConfigKey;
  // Throws InvalidOptionError for an unknown key before any store is read.
  const definition = getKeyDefinition(configKey);
  const value = await getConfigValue(configKey);

  if (definition.sensitive) {
    console.print(value === undefined ? NOT_SET_MESSAGE : 'Set (value hidden).');
    return;
  }

  console.print(value ?? NOT_SET_MESSAGE);
}
