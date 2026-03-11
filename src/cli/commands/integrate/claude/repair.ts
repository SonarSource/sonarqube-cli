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

// Repair orchestrator - fixes configuration issues

import {
  generateTokenViaBrowser,
  saveToken,
  validateToken,
  deleteToken,
} from '../../_common/token';
import { installHooks } from './hooks';
import type { HealthCheckResult } from './health';
import logger from '../../../../lib/logger';
import { text, success } from '../../../../ui';

/**
 * Run repair actions based on health check results
 */
export async function runRepair(
  serverURL: string,
  projectRoot: string,
  healthResult: HealthCheckResult,
  projectKey?: string,
  organization?: string,
  globalDir?: string,
  installA3s = false,
): Promise<string | undefined> {
  let newToken: string | undefined;

  // Fix token if invalid
  if (!healthResult.tokenValid) {
    text('Obtaining access token...');

    // Delete old token
    try {
      await deleteToken(serverURL, organization);
    } catch (error) {
      logger.debug(`Failed to delete token during repair: ${(error as Error).message}`);
    }

    // Generate new token
    newToken = await generateTokenViaBrowser(serverURL);

    // Validate new token
    const valid = await validateToken(serverURL, newToken);
    if (!valid) {
      throw new Error('Generated token is invalid');
    }

    // Save to keychain
    await saveToken(serverURL, newToken, organization);
    success('Token saved to keychain');
  }

  // Ensure hooks are installed (idempotent); A3S hook only when entitlement confirmed
  text('Installing secret scanning hooks...');
  await installHooks(projectRoot, globalDir, installA3s, projectKey);
  success('Secret scanning hooks installed');

  return newToken;
}
