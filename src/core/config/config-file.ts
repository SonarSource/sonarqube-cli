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
import { dirname } from 'node:path';

import { CommandFailedError } from '@/core/commands/command-error.ts';
import { getConfigFile } from '@/core/config-constants.ts';
import { parseProperties, removeProperty, setProperty } from '@/core/io/properties.ts';

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

/** Returns whether a value was actually removed; no-op (false) when the config file doesn't exist or doesn't hold `key`. */
export function removeConfigFileValue(key: string): boolean {
  const configFile = getConfigFile();
  if (!fs.existsSync(configFile)) {
    return false;
  }
  const content = readConfigContent();
  if (!parseProperties(content).has(key)) {
    return false;
  }
  try {
    fs.writeFileSync(configFile, removeProperty(content, key), 'utf-8');
  } catch (error) {
    throw new CommandFailedError(`Failed to save config: ${(error as Error).message}`);
  }
  return true;
}
