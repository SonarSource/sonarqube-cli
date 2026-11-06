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

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { CommandFailedError } from '@/core/commands/command-error.ts';
import {
  discoverSonarScanner,
  type ScannerInstallation,
  scannerJavaArgs,
  verifyScanner,
} from '@/core/host/install/scanner-discovery.ts';
import { SONAR_SCANNER_VERSION } from '@/core/host/install/sonar-scanner.ts';

import { restoreEnv } from '../../../../_common/isolated-cli-env.ts';
import { writeFakeJava, writeFakeLauncher } from './fake-scanner.ts';

const posixOnly = process.platform === 'win32' ? describe.skip : describe;

let root: string;
let previousPath: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'scanner-discovery-test-'));
  previousPath = process.env.PATH;
});

afterEach(() => {
  restoreEnv('PATH', previousPath);
  rmSync(root, { recursive: true, force: true });
});

function putOnPath(binDir: string): void {
  process.env.PATH = `${binDir}${delimiter}${previousPath ?? ''}`;
}

describe('scannerJavaArgs', () => {
  it('runs the scanner main class from its jar, with the scanner and project homes', () => {
    const scanner: ScannerInstallation = {
      home: '/opt/scanner',
      javaPath: '/opt/scanner/jre/bin/java',
      classPath: '/opt/scanner/lib/scanner.jar',
      version: SONAR_SCANNER_VERSION,
    };

    const args = scannerJavaArgs(scanner, '/work/project');

    expect(args).toContain('-Djava.awt.headless=true');
    expect(args.slice(args.indexOf('-classpath'), args.indexOf('-classpath') + 2)).toEqual([
      '-classpath',
      '/opt/scanner/lib/scanner.jar',
    ]);
    expect(args).toContain('-Dscanner.home=/opt/scanner');
    expect(args).toContain('-Dproject.home=/work/project');
    expect(args.at(-1)).toBe('org.sonarsource.scanner.cli.Main');
  });
});

posixOnly('verifyScanner', () => {
  function scannerWith(javaPath: string): ScannerInstallation {
    return { home: root, javaPath, classPath: join(root, 'x.jar'), version: SONAR_SCANNER_VERSION };
  }

  it('accepts a scanner that reports the expected version', async () => {
    const javaPath = join(root, 'java');
    writeFakeJava(javaPath);

    expect(await verifyScanner(scannerWith(javaPath))).toBeUndefined();
  });

  it('rejects a scanner that reports another version', async () => {
    const javaPath = join(root, 'java');
    writeFakeJava(javaPath, '8.0.0.1');

    const error = await verifyScanner(scannerWith(javaPath)).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(CommandFailedError);
    expect((error as CommandFailedError).message).toBe(
      'SonarScanner installation verification failed.',
    );
  });

  it('rejects a scanner that exits with an error', async () => {
    const javaPath = join(root, 'java');
    writeFakeJava(javaPath, SONAR_SCANNER_VERSION, 1);

    const error = await verifyScanner(scannerWith(javaPath)).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(CommandFailedError);
  });

  it('rejects output that does not name a scanner version', async () => {
    const javaPath = join(root, 'java');
    writeFakeJava(javaPath, 'not-a-version');

    const error = await verifyScanner(scannerWith(javaPath)).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(CommandFailedError);
  });
});

posixOnly('discoverSonarScanner', () => {
  it('finds nothing when no launcher is on the PATH', async () => {
    const empty = join(root, 'empty');
    mkdirSync(empty);
    process.env.PATH = empty;

    expect(await discoverSonarScanner()).toBeNull();
  });

  it('reuses the runtime the launcher reports', async () => {
    const launcher = writeFakeLauncher(root);
    putOnPath(launcher.binDir);

    const scanner = await discoverSonarScanner();

    expect(scanner).toEqual({
      home: launcher.home,
      javaPath: launcher.javaPath,
      classPath: launcher.jar,
      version: SONAR_SCANNER_VERSION,
    });
  });

  it('decodes the Java property escapes in the reported paths', async () => {
    const launcher = writeFakeLauncher(root, { homeValue: '/opt/sc\\u0041nner\\:1' });
    putOnPath(launcher.binDir);

    const scanner = await discoverSonarScanner();

    expect(scanner?.home).toBe('/opt/scAnner:1');
  });

  it.each([
    ['is older than version 6', { version: '5.0.1.3006' }],
    ['cannot report its version', { exitCode: 1 }],
    ['reports a class path that does not exist', { jarExists: false }],
  ])('falls back to a managed install when the launcher %s', async (_reason, options) => {
    const launcher = writeFakeLauncher(root, options);
    putOnPath(launcher.binDir);

    expect(await discoverSonarScanner()).toBeNull();
  });
});
