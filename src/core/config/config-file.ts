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

import fs from 'node:fs';
import { dirname, join } from 'node:path';

import { CommandFailedError } from '@/core/commands/command-error.ts';
import { CLI_CONFIG_FILE_NAME, getCliDir } from '@/core/config-constants.ts';
import { parseProperties, setProperty } from '@/core/io/properties.ts';

function getConfigFile(): string {
  return join(getCliDir(), CLI_CONFIG_FILE_NAME);
}

function readConfigContent(): string {
  const configFile = getConfigFile();
  if (!fs.existsSync(configFile)) {
    return '';
  }
  try {
    return fs.readFileSync(configFile, 'utf-8');
  } catch (error) {
    throw new CommandFailedError(`Failed to read config: ${(error as Error).message}`, {
      remediationHint: `Inspect or fix ${configFile}, then try again.`,
    });
  }
}

export function getConfigFileValue(key: string): string | undefined {
  return parseProperties(readConfigContent()).get(key);
}

export function setConfigFileValue(key: string, value: string): void {
  const configFile = getConfigFile();
  const content = setProperty(readConfigContent(), key, value);
  try {
    fs.mkdirSync(dirname(configFile), { recursive: true });
    fs.writeFileSync(configFile, content, 'utf-8');
  } catch (error) {
    throw new CommandFailedError(`Failed to save config: ${(error as Error).message}`);
  }
}
