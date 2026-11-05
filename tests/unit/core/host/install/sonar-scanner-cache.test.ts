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

import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import type { ScannerInstallation } from '@/core/host/install/scanner-discovery.ts';
import {
  cachedScannerIsUsable,
  installSonarScanner,
  SONAR_SCANNER_VERSION,
} from '@/core/host/install/sonar-scanner.ts';

import { FakeConsole } from '../../../../_common/fake-console.ts';
import { restoreEnv } from '../../../../_common/isolated-cli-env.ts';
import { writeFakeJava, writeFakeLauncher } from './fake-scanner.ts';

const posixOnly = process.platform === 'win32' ? describe.skip : describe;

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'scanner-cache-test-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** The layout of a managed install, with the `java` behaving as the test needs. */
function managedScanner(): ScannerInstallation {
  const home = join(root, `sonar-scanner-${SONAR_SCANNER_VERSION}-linux-x64`);
  return {
    home,
    javaPath: join(home, 'jre', 'bin', 'java'),
    classPath: join(home, 'lib', `sonar-scanner-cli-${SONAR_SCANNER_VERSION}.jar`),
    version: SONAR_SCANNER_VERSION,
  };
}

posixOnly('cachedScannerIsUsable', () => {
  it('reports no cache, and touches nothing, when the directory does not exist', async () => {
    expect(await cachedScannerIsUsable(managedScanner())).toBe(false);
    expect(existsSync(root)).toBe(true);
  });

  it('keeps a cached install that verifies', async () => {
    const scanner = managedScanner();
    writeFakeJava(scanner.javaPath);

    expect(await cachedScannerIsUsable(scanner)).toBe(true);
    expect(existsSync(scanner.home)).toBe(true);
  });

  it('deletes a directory that has no java, so the next install is not blocked by it', async () => {
    const scanner = managedScanner();
    mkdirSync(join(scanner.home, 'lib'), { recursive: true });

    expect(await cachedScannerIsUsable(scanner)).toBe(false);
    expect(existsSync(scanner.home)).toBe(false);
  });

  it('deletes an install whose java fails verification', async () => {
    const scanner = managedScanner();
    writeFakeJava(scanner.javaPath, SONAR_SCANNER_VERSION, 1);

    expect(await cachedScannerIsUsable(scanner)).toBe(false);
    expect(existsSync(scanner.home)).toBe(false);
  });

  it('deletes an install that reports another version', async () => {
    const scanner = managedScanner();
    writeFakeJava(scanner.javaPath, '7.0.0.1');

    expect(await cachedScannerIsUsable(scanner)).toBe(false);
    expect(existsSync(scanner.home)).toBe(false);
  });
});

posixOnly('installSonarScanner', () => {
  let previousPath: string | undefined;

  beforeEach(() => {
    previousPath = process.env.PATH;
  });

  afterEach(() => {
    restoreEnv('PATH', previousPath);
  });

  it('uses a scanner that is already installed instead of downloading one', async () => {
    const launcher = writeFakeLauncher(root);
    process.env.PATH = `${launcher.binDir}${delimiter}${previousPath ?? ''}`;
    const console = new FakeConsole();

    const scanner = await installSonarScanner(console);

    expect(scanner.home).toBe(launcher.home);
    const message = console.calls.find((call) => call.method === 'info')?.args[0];
    expect(message).toBe(
      `Using installed SonarScanner ${SONAR_SCANNER_VERSION} from ${launcher.home}.`,
    );
  });
});
