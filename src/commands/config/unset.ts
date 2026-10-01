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
// Remove a stored sonar config value

import type { CommandInvocationContext } from '@/core/commands/invocation-context.ts';
import { getKeyDefinition, unsetConfigValue } from '@/core/config/config-repository.ts';
import type { ConfigKey } from '@/core/config/config-schema.ts';

export async function unsetConfig(key: string, ctx: CommandInvocationContext): Promise<void> {
  const { console } = ctx;
  const configKey = key as ConfigKey;
  // Throws InvalidOptionError for an unknown key before any store is touched.
  const definition = getKeyDefinition(configKey);
  await unsetConfigValue(configKey);
  console.success(
    definition.sensitive
      ? `Removed '${configKey}' from the system keychain.`
      : `Removed '${configKey}'.`,
  );
}
