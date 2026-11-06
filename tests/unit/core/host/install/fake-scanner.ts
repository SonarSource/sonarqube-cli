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

import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { SONAR_SCANNER_VERSION } from '@/core/host/install/sonar-scanner.ts';

export interface FakeLauncherOptions {
  /** What `--version` prints; defaults to the pinned scanner version. */
  version?: string;
  /** Exit code of `--version`. */
  exitCode?: number;
  /** Whether the reported class path entry exists. */
  jarExists?: boolean;
  /** The raw `scanner.home` line value, for exercising Java property escapes. */
  homeValue?: string;
}

export interface FakeLauncher {
  binDir: string;
  home: string;
  javaPath: string;
  jar: string;
}

export function writeExecutable(path: string, lines: string[]): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, lines.join('\n'));
  chmodSync(path, 0o755);
}

/** A `java` that prints the scanner banner, as the real one does for `--version`. */
export function writeFakeJava(path: string, version = SONAR_SCANNER_VERSION, exitCode = 0): void {
  writeExecutable(path, ['#!/bin/sh', `echo "SonarScanner CLI ${version}"`, `exit ${exitCode}`]);
}

/**
 * A `sonar-scanner` launcher that answers `--version` and, like the real one in simulation mode,
 * writes the runtime it would use to the file named by `-Dsonar.scanner.internal.dumpToFile`.
 */
export function writeFakeLauncher(root: string, options: FakeLauncherOptions = {}): FakeLauncher {
  const version = options.version ?? SONAR_SCANNER_VERSION;
  const binDir = join(root, 'bin');
  const home = join(root, 'home');
  const javaHome = join(root, 'jdk');
  const jar = join(home, 'lib', `sonar-scanner-cli-${version}.jar`);
  const javaPath = join(javaHome, 'bin', 'java');
  mkdirSync(join(home, 'lib'), { recursive: true });
  if (options.jarExists !== false) writeFileSync(jar, '');
  writeFakeJava(javaPath, version);
  writeExecutable(join(binDir, 'sonar-scanner'), [
    '#!/bin/sh',
    `if [ "$1" = "--version" ]; then echo "SonarScanner CLI ${version}"; exit ${options.exitCode ?? 0}; fi`,
    'for arg in "$@"; do case "$arg" in -Dsonar.scanner.internal.dumpToFile=*) dump="${arg#*=}";; esac; done',
    `printf 'scanner.home=%s\\njava.home=%s\\njava.class.path=%s\\n' '${options.homeValue ?? home}' '${javaHome}' '${jar}' > "$dump"`,
    'exit 0',
  ]);
  return { binDir, home, javaPath, jar };
}
