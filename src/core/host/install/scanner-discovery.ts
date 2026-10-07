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

import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, extname, isAbsolute, join } from 'node:path';

import { CommandFailedError } from '@/core/commands/command-error.ts';
import { parseProperties } from '@/core/io/properties.ts';
import logger from '@/core/observability/logger.ts';
import { spawnProcessWithTimeout } from '@/core/process/process.ts';

export interface ScannerInstallation {
  home: string;
  javaPath: string;
  classPath: string;
  version: string;
}

const PROBE_TIMEOUT_MS = 30000;
const PROBE_ENV: NodeJS.ProcessEnv = {
  SONAR_TOKEN: undefined,
  SONAR_REGION: undefined,
  SONAR_SCANNER_JSON_PARAMS: '{}',
  SONARQUBE_SCANNER_PARAMS: '{}',
  SONAR_SCANNER_PROXY_HOST: undefined,
  SONAR_SCANNER_PROXY_PORT: undefined,
  SONAR_SCANNER_PROXY_USER: undefined,
  SONAR_SCANNER_PROXY_PASSWORD: undefined,
};

function scannerVersion(output: string): string {
  const version = /SonarScanner(?: CLI)? (\d+(?:\.\d+){1,3})/.exec(output)?.[1];
  if (!version || Number(version.split('.')[0]) < 6) {
    throw new CommandFailedError('An installed SonarScanner CLI version 6.0 or later is required.');
  }
  return version;
}

export function scannerJavaArgs(scanner: ScannerInstallation, projectRoot: string): string[] {
  return [
    '-Djava.awt.headless=true',
    '-Djdk.http.auth.tunneling.disabledSchemes=',
    '-classpath',
    scanner.classPath,
    `-Dscanner.home=${scanner.home}`,
    `-Dproject.home=${projectRoot}`,
    'org.sonarsource.scanner.cli.Main',
  ];
}

export async function verifyScanner(scanner: ScannerInstallation): Promise<void> {
  const result = await spawnProcessWithTimeout(
    scanner.javaPath,
    [...scannerJavaArgs(scanner, scanner.home), '--version'],
    { env: PROBE_ENV },
    PROBE_TIMEOUT_MS,
    'SonarScanner installation verification timed out.',
  );
  if (result.exitCode !== 0 || scannerVersion(result.stdout + result.stderr) !== scanner.version) {
    throw new CommandFailedError('SonarScanner installation verification failed.');
  }
}

function decodeJavaProperty(value: string | undefined): string {
  if (!value)
    throw new CommandFailedError('The installed scanner did not report its runtime location.');
  return value.replace(/\\(u[\da-fA-F]{4}|.)/g, (_, escaped: string) => {
    if (escaped.startsWith('u') && escaped.length === 5)
      return String.fromCharCode(Number.parseInt(escaped.slice(1), 16));
    const escapes: Record<string, string> = { t: '\t', r: '\r', n: '\n', f: '\f' };
    return escapes[escaped] ?? escaped;
  });
}

async function probeLauncher(command: string): Promise<ScannerInstallation> {
  const versionResult = await spawnProcessWithTimeout(
    command,
    ['--version'],
    { env: PROBE_ENV },
    PROBE_TIMEOUT_MS,
    'SonarScanner version check timed out.',
  );
  if (versionResult.exitCode !== 0)
    throw new CommandFailedError('The installed scanner could not run.');
  const version = scannerVersion(versionResult.stdout + versionResult.stderr);
  const directory = mkdtempSync(join(tmpdir(), 'sonar-scanner-probe-'));
  try {
    const reportPath = join(directory, 'runtime.properties');
    // Simulation reports the launcher's own runtime, including Homebrew wrapper and JAVA_HOME choices.
    const result = await spawnProcessWithTimeout(
      command,
      [`-Dsonar.scanner.internal.dumpToFile=${reportPath}`, '-Dsonar.host.url=http://127.0.0.1:1'],
      { cwd: directory, env: PROBE_ENV },
      PROBE_TIMEOUT_MS,
      'SonarScanner runtime discovery timed out.',
    );
    if (result.exitCode !== 0)
      throw new CommandFailedError('The installed scanner could not report its runtime.');
    const properties = parseProperties(readFileSync(reportPath, 'utf8'));
    const scanner: ScannerInstallation = {
      home: decodeJavaProperty(properties.get('scanner.home')),
      javaPath: join(
        decodeJavaProperty(properties.get('java.home')),
        'bin',
        process.platform === 'win32' ? 'java.exe' : 'java',
      ),
      classPath: decodeJavaProperty(properties.get('java.class.path')),
      version,
    };
    if (
      !isAbsolute(scanner.home) ||
      !isAbsolute(scanner.javaPath) ||
      !scanner.classPath.split(delimiter).every((path) => isAbsolute(path) && existsSync(path))
    ) {
      throw new CommandFailedError('The installed scanner reported invalid runtime paths.');
    }
    await verifyScanner(scanner);
    return scanner;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

async function resolveWindowsDistribution(command: string): Promise<ScannerInstallation> {
  const root = dirname(dirname(realpathSync(command)));
  for (const home of [root, join(root, 'libexec')]) {
    const library = join(home, 'lib');
    if (!existsSync(library)) continue;
    const jars = readdirSync(library).filter((name) =>
      /^sonar-scanner-cli-\d+(?:\.\d+){1,3}\.jar$/.test(name),
    );
    if (jars.length !== 1) continue;
    const embeddedJava = join(home, 'jre', 'bin', 'java.exe');
    const javaPath = existsSync(embeddedJava)
      ? embeddedJava
      : process.env.JAVA_HOME
        ? join(process.env.JAVA_HOME, 'bin', 'java.exe')
        : Bun.which('java.exe');
    if (!javaPath) continue;
    const version = scannerVersion(
      `SonarScanner CLI ${jars[0].slice('sonar-scanner-cli-'.length, -4)}`,
    );
    const scanner = { home, javaPath, classPath: join(library, jars[0]), version };
    await verifyScanner(scanner);
    return scanner;
  }
  throw new CommandFailedError('Could not resolve the installed Windows scanner distribution.');
}

export async function discoverSonarScanner(): Promise<ScannerInstallation | null> {
  const names =
    process.platform === 'win32'
      ? ['sonar-scanner.bat', 'sonar-scanner.cmd', 'sonar-scanner.exe', 'sonar-scanner']
      : ['sonar-scanner'];
  const command = names.map((name) => Bun.which(name)).find((path) => path !== null);
  if (!command) return null;
  try {
    return ['.bat', '.cmd'].includes(extname(command).toLowerCase())
      ? await resolveWindowsDistribution(command)
      : await probeLauncher(command);
  } catch {
    logger.debug(
      `Could not reuse SonarScanner at ${command}; falling back to the managed installation.`,
    );
    return null;
  }
}
