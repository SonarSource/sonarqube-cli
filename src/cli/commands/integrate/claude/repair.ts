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
import logger from '../../../../lib/logger';
import { text, success } from '../../../../ui';

export async function repairToken(serverURL: string, organization?: string): Promise<string> {
  text('Obtaining access token...');

  // Generate new token
  const newToken = await generateTokenViaBrowser(serverURL);

  // Validate new token
  const valid = await validateToken(serverURL, newToken);
  if (!valid) {
    throw new Error('Generated token is invalid');
  }

  // Delete old token
  try {
    await deleteToken(serverURL, organization);
  } catch (error) {
    logger.debug(`Failed to delete token during repair: ${(error as Error).message}`);
  }

  // Save to keychain
  await saveToken(serverURL, newToken, organization);
  success('Token saved to keychain');
  return newToken;
}
