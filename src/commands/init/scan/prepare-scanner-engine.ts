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

import { createHash } from 'node:crypto';
import { renameSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { CommandFailedError } from '@/core/commands/command-error.ts';
import { OWNER_ONLY_FILE_MODE } from '@/core/config-constants.ts';
import type { SonarHttpClient } from '@/core/server/http-client.ts';

import { ScannerEngineApi } from './scanner-engine-api.ts';

export async function prepareScannerEngine(
  http: SonarHttpClient,
  directory: string,
): Promise<string> {
  const api = new ScannerEngineApi(http);
  // An empty override is ignored by legacy bootstrap and fails closed if modern bootstrap is used.
  if (!(await api.usesModernBootstrap())) return '';
  const temporaryPath = resolve(directory, 'scanner-engine.tmp');
  const enginePath = resolve(directory, 'scanner-engine.jar');
  try {
    const { bytes, sha256 } = await api.download();
    writeFileSync(temporaryPath, new Uint8Array(bytes), { flag: 'wx', mode: OWNER_ONLY_FILE_MODE });
    if (createHash('sha256').update(new Uint8Array(bytes)).digest('hex') !== sha256.toLowerCase()) {
      throw new CommandFailedError('Scanner engine download failed SHA-256 verification.');
    }
    renameSync(temporaryPath, enginePath);
    return enginePath;
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}
