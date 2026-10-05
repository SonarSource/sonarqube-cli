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
import { resolveFormatOption } from '@/core/commands/params.ts';
import { getConfigValue, getKeyDefinition } from '@/core/config/config-repository.ts';
import {
  type ConfigEntryJson,
  type ConfigKey,
  MASKED_VALUE,
  NOT_SET_MESSAGE,
} from '@/core/config/config-schema.ts';
import { gray } from '@/core/ui/colors.ts';
import type { Console } from '@/core/ui/console.ts';

export const VALID_FORMATS = ['text', 'json'] as const;
type ConfigGetFormat = (typeof VALID_FORMATS)[number];

export interface ConfigGetOptions {
  format?: string;
}

function printJson(console: Console, payload: ConfigEntryJson): void {
  console.print(JSON.stringify(payload, null, 2));
}

export async function getConfig(
  key: ConfigKey,
  options: ConfigGetOptions,
  ctx: CommandInvocationContext,
): Promise<void> {
  const { console } = ctx;
  const format: ConfigGetFormat = resolveFormatOption(options.format, VALID_FORMATS, 'text');
  const definition = getKeyDefinition(key);
  const value = await getConfigValue(key);
  const isSet = value !== undefined;

  if (format === 'json') {
    printJson(console, {
      key,
      sensitive: definition.sensitive,
      set: isSet,
      ...(!definition.sensitive && isSet ? { value } : {}),
    });
    return;
  }

  if (definition.sensitive) {
    console.print(isSet ? gray(MASKED_VALUE) : gray(NOT_SET_MESSAGE));
    return;
  }

  console.print(value ?? gray(NOT_SET_MESSAGE));
}
