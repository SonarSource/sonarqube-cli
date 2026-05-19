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

// Shared guard for hook handlers — resolves auth and binary path, returning null if either is
// unavailable so handlers can exit gracefully without repeating the same boilerplate.

import type { ResolvedAuth } from '../../../lib/auth-resolver';
import { isEnvBasedAuth, resolveAuth } from '../../../lib/auth-resolver';
import { warn } from '../../../ui';
import { CommandFailedError } from '../_common/error';
import { resolveSecretsBinaryPath } from '../_common/install/secrets';

export interface HookDependencies {
  auth: ResolvedAuth;
  binaryPath: string;
}

export function handleScanError(context: 'Commit' | 'Push', err: Error): void {
  if (isEnvBasedAuth()) {
    throw new CommandFailedError('Secrets scan failed.', {
      remediationHint:
        "Run 'sonar integrate' again or run 'sonar analyze secrets -- <files>' manually to debug the analyzer.",
    });
  }
  warn(
    `Secrets scan failed. ${context} is not blocked, but secrets were not checked. Reason: ${err.message}`,
  );
}

export async function resolveAuthAndSecrets(): Promise<HookDependencies | null> {
  const auth = await resolveAuth().catch(() => null);
  if (!auth) return null; // not authenticated — allow gracefully

  const binaryPath = resolveSecretsBinaryPath();
  if (!binaryPath) return null; // binary not installed — allow gracefully

  return { auth, binaryPath };
}
