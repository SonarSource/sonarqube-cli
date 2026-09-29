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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';

import { CommandFailedError } from '@/core/commands/command-error.ts';
import { getConfigFileValue, setConfigFileValue } from '@/core/config/config-file.ts';
import { ENV_SONAR_USER_HOME } from '@/core/config-constants.ts';

const previousSonarUserHome = process.env[ENV_SONAR_USER_HOME];
let testSonarUserHome: string;
let testConfigFile: string;

beforeEach(async () => {
  testSonarUserHome = await mkdtemp(join(tmpdir(), 'cli-config-file-test-'));
  testConfigFile = join(testSonarUserHome, 'sonarqube-cli', 'cli-config.properties');
  process.env[ENV_SONAR_USER_HOME] = testSonarUserHome;
});

afterEach(async () => {
  await rm(testSonarUserHome, { recursive: true, force: true });
  if (previousSonarUserHome === undefined) {
    delete process.env[ENV_SONAR_USER_HOME];
  } else {
    process.env[ENV_SONAR_USER_HOME] = previousSonarUserHome;
  }
});

function writeConfigFile(content: string): void {
  mkdirSync(dirname(testConfigFile), { recursive: true });
  writeFileSync(testConfigFile, content, 'utf-8');
}

describe('config file', () => {
  it('reads a missing file as empty without creating it', () => {
    expect(getConfigFileValue('log.level')).toBeUndefined();
    expect(existsSync(testConfigFile)).toBe(false);
  });

  it('stores a value under SONAR_USER_HOME and reads it back', () => {
    setConfigFileValue('log.level', 'DEBUG');

    expect(readFileSync(testConfigFile, 'utf-8')).toBe('log.level=DEBUG\n');
    expect(getConfigFileValue('log.level')).toBe('DEBUG');
  });

  it('fails with a remediation hint when the file cannot be read', () => {
    writeConfigFile('log.level=DEBUG\n');
    const readSpy = spyOn(fs, 'readFileSync').mockImplementation(() => {
      throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
    });

    let getError: unknown;
    try {
      getConfigFileValue('log.level');
    } catch (error) {
      getError = error;
    }
    try {
      expect(() => setConfigFileValue('log.level', 'WARN')).toThrow(CommandFailedError);
    } finally {
      readSpy.mockRestore();
    }

    expect(getError).toBeInstanceOf(CommandFailedError);
    expect((getError as CommandFailedError).remediationHint).toBe(
      `Inspect or fix ${testConfigFile}, then try again.`,
    );
    expect(readFileSync(testConfigFile, 'utf-8')).toBe('log.level=DEBUG\n');
  });
});
