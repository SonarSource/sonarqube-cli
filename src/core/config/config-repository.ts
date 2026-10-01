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

import { InvalidOptionError } from '@/core/commands/command-error.ts';
import { deleteConfigSecret, getConfigSecret, saveConfigSecret } from '@/core/host/keychain.ts';

import { getConfigFileValue, removeConfigFileValue, setConfigFileValue } from './config-file.ts';
import {
  CONFIG_KEY_BY_NAME,
  type ConfigKey,
  type ConfigKeyDefinition,
  isValidConfigValue,
} from './config-schema.ts';

export function getKeyDefinition(key: ConfigKey): ConfigKeyDefinition {
  const definition = CONFIG_KEY_BY_NAME.get(key);
  if (!definition) {
    throw new InvalidOptionError(`Unknown config key '${key}'.`);
  }
  return definition;
}

export async function getConfigValue(key: ConfigKey): Promise<string | undefined> {
  const definition = getKeyDefinition(key);
  if (definition.sensitive) {
    return (await getConfigSecret(key)) ?? undefined;
  }
  return getConfigFileValue(key);
}

export async function setConfigValue(key: ConfigKey, value: string): Promise<void> {
  const definition = getKeyDefinition(key);
  const trimmedValue = value.trim();
  if (trimmedValue.length === 0) {
    throw new InvalidOptionError(`Value for config key '${key}' must not be empty.`);
  }
  if (!isValidConfigValue(definition, trimmedValue)) {
    throw new InvalidOptionError(
      `Invalid value '${trimmedValue}' for config key '${key}'. Allowed values: ${definition.allowedValues?.join(', ')}.`,
    );
  }
  if (definition.sensitive) {
    await saveConfigSecret(key, trimmedValue);
    return;
  }
  setConfigFileValue(key, trimmedValue);
}

/**
 * Returns whether a value was actually removed. No-op (false) when `key` is not
 * currently set — mirrors shell `unset` on an unset variable — so the caller can
 * tell "removed" apart from "there was nothing to remove" instead of reporting
 * success regardless.
 */
export async function unsetConfigValue(key: ConfigKey): Promise<boolean> {
  const definition = getKeyDefinition(key);
  if (definition.sensitive) {
    return await deleteConfigSecret(key);
  }
  return removeConfigFileValue(key);
}
