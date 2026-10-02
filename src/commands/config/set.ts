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
// Store a sonar config value

import { CommandFailedError } from '@/core/commands/command-error.ts';
import type { CommandInvocationContext } from '@/core/commands/invocation-context.ts';
import { getKeyDefinition, setConfigValue } from '@/core/config/config-repository.ts';
import type { ConfigKey } from '@/core/config/config-schema.ts';
import type { Console } from '@/core/ui/console.ts';

function canPrompt(): boolean {
  return process.stdin.isTTY || Boolean(process.env.SONARQUBE_CLI_MOCK_TTY);
}

/** Prompts for the value with a masked, non-echoing input when the terminal is interactive. */
async function promptForValue(console: Console, key: ConfigKey): Promise<string> {
  if (!canPrompt()) {
    throw new CommandFailedError(`Non-interactive mode requires a value.`, {
      remediationHint: `Run 'sonar config set ${key} <value>'.`,
    });
  }
  const value = await console.passwordPrompt(`Value for '${key}':`);
  if (value === null) {
    throw new CommandFailedError(`Aborted: no value provided for '${key}'.`);
  }
  return value;
}

export async function setConfig(
  key: string,
  value: string | undefined,
  ctx: CommandInvocationContext,
): Promise<void> {
  const { console } = ctx;
  const configKey = key as ConfigKey;
  // Throws InvalidOptionError for an unknown key before any store is written to.
  getKeyDefinition(configKey);
  const resolvedValue = value ?? (await promptForValue(console, configKey));
  await setConfigValue(configKey, resolvedValue);
  console.success(`Saved '${configKey}'.`);
}
