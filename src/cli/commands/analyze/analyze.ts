/*
 * SonarQube CLI
 * Copyright (C) 2026 SonarSource Sàrl
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
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnProcess } from '../../../lib/process';
import { buildLocalBinaryName, detectPlatform } from '../../../lib/platform-detector';
import { resolveAuth } from '../../../lib/auth-resolver';
import logger from '../../../lib/logger';
import { blank, text, warn } from '../../../ui';
import { InvalidOptionError } from '../_common/error.js';
import { BIN_DIR } from '../../../lib/config-constants';
import { runA3sAnalysis } from './a3s.js';

// ---------------------------------------------------------------------------
// Full file analysis pipeline: secrets → A3S
// ---------------------------------------------------------------------------

const SECRETS_FOUND_EXIT_CODE = 51;
const SCAN_TIMEOUT_MS = 30000;

export async function analyzeFile(file: string, branch?: string): Promise<void> {
  if (!file) {
    throw new InvalidOptionError('--file is required');
  }

  if (!existsSync(file)) {
    throw new InvalidOptionError(`File not found: ${file}`);
  }

  // Step 1: secrets scan
  const secretsResult = await runSecretsOnFile(file);
  if (secretsResult === 'secrets-found') {
    blank();
    warn('Secrets detected in this file.');
    text('  Remove the secrets before running full analysis to get additional issues.');
    blank();
    return;
  }

  // Step 2: A3S analysis
  await runA3sAnalysis(file, branch);
}

async function runSecretsOnFile(file: string): Promise<'secrets-found' | 'ok'> {
  try {
    const platform = detectPlatform();
    const binaryPath = join(BIN_DIR, buildLocalBinaryName(platform));
    if (!existsSync(binaryPath)) {
      logger.debug('sonar-secrets binary not found, skipping secrets scan');
      return 'ok';
    }

    const auth = await resolveAuth({});

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        spawnProcess(binaryPath, ['--non-interactive', file], {
          stdin: 'pipe',
          stdout: 'pipe',
          stderr: 'pipe',
          env: {
            ...(auth.serverUrl && auth.token
              ? {
                  SONAR_SECRETS_AUTH_URL: auth.serverUrl,
                  SONAR_SECRETS_TOKEN: auth.token,
                }
              : {}),
          },
        }),
        new Promise<never>((_resolve, reject) => {
          timeoutId = setTimeout(() => {
            reject(new Error(`Scan timed out after ${SCAN_TIMEOUT_MS}ms`));
          }, SCAN_TIMEOUT_MS);
        }),
      ]);
      if ((result.exitCode ?? 0) === SECRETS_FOUND_EXIT_CODE) {
        return 'secrets-found';
      }
      return 'ok';
    } finally {
      clearTimeout(timeoutId);
    }
  } catch (err) {
    logger.debug(`Secrets scan error (non-blocking): ${(err as Error).message}`);
    return 'ok';
  }
}
