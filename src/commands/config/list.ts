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
// Print every sonar config key with its current value

import type { CommandInvocationContext } from '@/core/commands/invocation-context.ts';
import { resolveFormatOption } from '@/core/commands/parsing.ts';
import { getConfigValue } from '@/core/config/config-repository.ts';
import { CONFIG_KEY_DEFINITIONS, type ConfigEntryJson } from '@/core/config/config-schema.ts';
import { columnFormatting } from '@/core/ui/formatter/column-formatting.ts';

export const VALID_FORMATS = ['text', 'table', 'json'] as const;
type ConfigListFormat = (typeof VALID_FORMATS)[number];

export interface ConfigListOptions {
  format?: string;
}

const NOT_SET_MESSAGE = '(not set)';

function displayValue(sensitive: boolean, value: string | undefined): string {
  if (value === undefined) {
    return NOT_SET_MESSAGE;
  }
  return sensitive ? '(hidden)' : value;
}

function formatTable(rows: { key: string; display: string }[]): string {
  const [keyWidth] = columnFormatting([rows.map((row) => row.key)]);

  const header = ['KEY'.padEnd(keyWidth), 'VALUE'].join(' | ');
  const separator = '-'.repeat(header.length);

  const lines = [header, separator];
  for (const row of rows) {
    lines.push([row.key.padEnd(keyWidth), row.display].join(' | '));
  }

  return lines.join('\n');
}

export async function listConfig(
  options: ConfigListOptions,
  ctx: CommandInvocationContext,
): Promise<void> {
  const { console } = ctx;
  const format: ConfigListFormat = resolveFormatOption(options.format, VALID_FORMATS, 'text');

  const entries = await Promise.all(
    CONFIG_KEY_DEFINITIONS.map(async (definition) => ({
      definition,
      value: await getConfigValue(definition.key),
    })),
  );

  if (format === 'json') {
    const payload: ConfigEntryJson[] = entries.map(({ definition, value }) => ({
      key: definition.key,
      sensitive: definition.sensitive,
      set: value !== undefined,
      ...(!definition.sensitive && value !== undefined ? { value } : {}),
    }));
    console.print(JSON.stringify(payload, null, 2));
    return;
  }

  if (format === 'table') {
    console.print(
      formatTable(
        entries.map(({ definition, value }) => ({
          key: definition.key,
          display: displayValue(definition.sensitive, value),
        })),
      ),
    );
    return;
  }

  for (const { definition, value } of entries) {
    console.print(`${definition.key}=${displayValue(definition.sensitive, value)}`);
  }
}
