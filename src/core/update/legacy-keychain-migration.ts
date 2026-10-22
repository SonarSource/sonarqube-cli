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

import { generateKeychainAccount, MissingKeychainError, moveToken } from '@/core/host/keychain.ts';
import logger from '@/core/observability/logger.ts';
import type { AuthConnection } from '@/core/state/state.ts';
import { loadState } from '@/core/state/state-repository.ts';
import type { Console } from '@/core/ui/console.ts';

export async function migrateLegacyKeychainTokens(console: Console): Promise<void> {
  try {
    await Promise.all(loadState().auth.connections.map(moveLegacyToken));
  } catch (error) {
    logger.debug(`Keychain token migration failed: ${(error as Error).message}`);
    if (!(error instanceof MissingKeychainError)) {
      console.warn(
        "Could not move your stored login to its new keychain entry. Run 'sonar auth login' to sign in again.",
      );
    }
  }
}

async function moveLegacyToken(connection: AuthConnection): Promise<void> {
  if (!connection.orgKey) {
    return;
  }
  const account = generateKeychainAccount(connection.serverUrl);
  await moveToken(`${account}:${connection.orgKey}`, account);
}
