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

import { CommandFailedError } from '@/core/commands/command-error.ts';
import type { Console } from '@/core/ui/console.ts';

export interface ScannerInstallation {
  home: string;
  javaPath: string;
  classPath: string;
  version: string;
}

/** Thrown when the first analysis is requested: the CLI no longer ships a SonarScanner. */
export class ScannerUnavailableError extends CommandFailedError {
  constructor() {
    super('SonarScanner is not available in this version of the CLI.');
    this.name = 'ScannerUnavailableError';
  }
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

export function installSonarScanner(_console: Console): Promise<ScannerInstallation> {
  return Promise.reject(new ScannerUnavailableError());
}
