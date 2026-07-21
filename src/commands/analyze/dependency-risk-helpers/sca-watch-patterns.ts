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

import picomatch from 'picomatch';

import logger from '../../../lib/logger.ts';
import type { ScaScannerInstaller } from '../../_common/install/sca-scanner.ts';
import type { ScaScannerSpawner } from './sca-scanner-spawner.ts';

interface WatchPatternsPayload {
  patterns?: unknown;
}

export class ScaWatchPatternsRunner {
  constructor(
    private readonly installer: ScaScannerInstaller,
    private readonly spawner: ScaScannerSpawner,
  ) {}

  async run(): Promise<string[]> {
    try {
      const binaryPath = await this.installer.install();
      const result = await this.spawner.spawn(binaryPath, ['watch-patterns']);
      if ((result.exitCode ?? 1) !== 0) {
        logger.debug(`watch-patterns exited with code ${String(result.exitCode)}`);
        return [];
      }
      const parsed: WatchPatternsPayload = JSON.parse(result.stdout) as WatchPatternsPayload;
      if (!Array.isArray(parsed.patterns)) return [];
      return parsed.patterns.filter((p): p is string => typeof p === 'string');
    } catch (err) {
      logger.debug(`watch-patterns failed: ${(err as Error).message}`);
      return [];
    }
  }
}

export function anyFileMatches(files: readonly string[], patterns: readonly string[]): boolean {
  if (patterns.length === 0 || files.length === 0) return false;
  const normalizedPatterns = patterns.map((p) => (p.includes('/') ? p : `**/${p}`));
  const match = picomatch(normalizedPatterns, { dot: true, nocase: process.platform === 'win32' });
  return files.some((file) => match(file));
}
