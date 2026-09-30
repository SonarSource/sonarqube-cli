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

import { readdirSync } from 'node:fs';
import { delimiter, join } from 'node:path';

import { ENV_MDM_BINARY_PATH, ENV_MDM_USER_HOMES } from '@/core/config-constants.ts';
import { isWindows } from '@/core/host/environment/platform-detector.ts';
import { spawnProcess } from '@/core/process/process.ts';

export interface MdmEnvironment {
  binaryPath: string;
  listUserHomes(): Promise<string[]>;
}

const UNIX_BINARY_PATH = '/usr/local/bin/sonar';
const WINDOWS_BINARY_PATH = String.raw`C:\Program Files\sonarqube-cli\bin\sonar.exe`;
const DSCL_LINE = /^(\S+)\s+(\S.*)$/;
const MACOS_HOME_PREFIX = '/Users/';
const LINUX_HOME_PREFIX = '/home/';
const PASSWD_HOME_FIELD = 5;

async function listMacosUserHomes(): Promise<string[]> {
  const { stdout } = await spawnProcess('dscl', ['.', 'list', '/Users', 'NFSHomeDirectory']);
  return stdout
    .split('\n')
    .map((line) => DSCL_LINE.exec(line.trim()))
    .filter((match): match is RegExpExecArray => match !== null)
    .filter(([, name, home]) => !name.startsWith('_') && home.startsWith(MACOS_HOME_PREFIX))
    .map(([, , home]) => home);
}

async function listLinuxUserHomes(): Promise<string[]> {
  const { stdout } = await spawnProcess('getent', ['passwd']);
  return stdout
    .split('\n')
    .map((line) => line.split(':').at(PASSWD_HOME_FIELD))
    .filter((home): home is string => home?.startsWith(LINUX_HOME_PREFIX) ?? false);
}

function listWindowsUserHomes(): string[] {
  const usersRoot = join(process.env.SystemDrive ?? 'C:', 'Users');
  return readdirSync(usersRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(usersRoot, entry.name));
}

export function defaultMdmEnvironment(): MdmEnvironment {
  const binaryPathOverride = process.env[ENV_MDM_BINARY_PATH];
  if (binaryPathOverride) {
    const userHomes = (process.env[ENV_MDM_USER_HOMES] ?? '').split(delimiter).filter(Boolean);
    return { binaryPath: binaryPathOverride, listUserHomes: () => Promise.resolve(userHomes) };
  }
  if (isWindows()) {
    return {
      binaryPath: WINDOWS_BINARY_PATH,
      listUserHomes: () => Promise.resolve(listWindowsUserHomes()),
    };
  }
  return {
    binaryPath: UNIX_BINARY_PATH,
    listUserHomes: process.platform === 'darwin' ? listMacosUserHomes : listLinuxUserHomes,
  };
}

export function standaloneBinaryPath(userHome: string): string {
  return isWindows()
    ? join(userHome, 'AppData', 'Local', 'sonarqube-cli', 'bin', 'sonar.exe')
    : join(userHome, '.local', 'share', 'sonarqube-cli', 'bin', 'sonar');
}
