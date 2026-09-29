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

import { existsSync, rmSync } from 'node:fs';

import { CONFIG_KEY_DEFINITIONS } from '@/core/config/config-schema.ts';
import { getCliDir, getConfigFile } from '@/core/config-constants.ts';
import { deleteConfigSecret } from '@/core/host/keychain.ts';
import { type PhaseItem, phaseItem } from '@/core/ui/console.ts';

import { resolveSafePath } from './safe-path.ts';

export interface ConfigResetResult {
  item: PhaseItem;
}

const SENSITIVE_CONFIG_KEYS = CONFIG_KEY_DEFINITIONS.filter(
  (definition) => definition.sensitive,
).map((definition) => definition.key);

function removeConfigFile(): boolean {
  const configFile = resolveSafePath(getConfigFile(), [getCliDir()]);
  if (!configFile) {
    throw new Error('path rejected');
  }
  if (!existsSync(configFile)) {
    return false;
  }
  rmSync(configFile, { force: true });
  return true;
}

async function removeConfigSecrets(): Promise<boolean> {
  let removedAny = false;
  // Sequential: the file-backed keychain does an unsynchronized read-modify-write.
  for (const key of SENSITIVE_CONFIG_KEYS) {
    removedAny = (await deleteConfigSecret(key)) || removedAny;
  }
  return removedAny;
}

export async function clearConfig(): Promise<ConfigResetResult> {
  const failures: string[] = [];
  let removedAny = false;

  try {
    removedAny = removeConfigFile();
  } catch (err) {
    failures.push(`config file: ${(err as Error).message}`);
  }

  try {
    removedAny = (await removeConfigSecrets()) || removedAny;
  } catch (err) {
    failures.push(`keychain: ${(err as Error).message.split('\n')[0]}`);
  }

  if (failures.length > 0) {
    return {
      item: phaseItem('Config', 'warn', `Failed to remove CLI settings: ${failures.join('; ')}`),
    };
  }
  if (!removedAny) {
    return { item: phaseItem('Config', 'info', 'Nothing to clear.') };
  }
  return { item: phaseItem('Config', 'done', 'Removed CLI settings.') };
}
