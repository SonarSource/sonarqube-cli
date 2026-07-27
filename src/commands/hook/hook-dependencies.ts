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

// Shared guard for hook handlers — resolves auth and binary path, throwing
// MissingDependenciesError if either is unavailable so handlers fail loudly.

import { CommandFailedError } from '@/core/command-error.ts';
import type { ResolvedAuth } from '@/core/host/auth-resolver.ts';
import { isEnvBasedAuth, resolveAuth } from '@/core/host/auth-resolver.ts';
import { resolveSecretsBinaryPath } from '@/core/host/install/secrets.ts';
import type { SecretsCallerCommand } from '@/core/telemetry/secrets-analysis-telemetry.ts';
import { warn } from '@/core/ui';

import {
  runSecretsBinary,
  runSecretsBinaryOnText,
  scanAndEmitSecrets,
} from '../analyze/secrets.ts';

export interface HookDependencies {
  auth: ResolvedAuth;
  binaryPath: string;
}

export const SECRETS_INACTIVE_UNAUTHENTICATED =
  "SonarQube secret scanning is inactive: not authenticated. Run 'sonar auth login'.";
export const SECRETS_INACTIVE_BINARY_MISSING =
  "SonarQube secret scanning is inactive: analyzer not installed. Re-run 'sonar integrate'.";
export const HOOK_INACTIVE_UNAUTHENTICATED =
  "SonarQube code scanning is inactive: not authenticated. Run 'sonar auth login'.";

export class MissingDependenciesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MissingDependenciesError';
  }
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

export async function resolveAuthAndSecrets(): Promise<HookDependencies> {
  const auth = await resolveAuth().catch(() => null);
  if (!auth) throw new MissingDependenciesError(SECRETS_INACTIVE_UNAUTHENTICATED);

  const binaryPath = resolveSecretsBinaryPath();
  if (!binaryPath) throw new MissingDependenciesError(SECRETS_INACTIVE_BINARY_MISSING);

  return { auth, binaryPath };
}

export async function runAndEmitFileSecretsScan(
  callerCommand: SecretsCallerCommand,
  deps: HookDependencies,
  filePath: string,
): Promise<number> {
  const { result } = await scanAndEmitSecrets(callerCommand, deps.auth, () =>
    runSecretsBinary(deps.binaryPath, [filePath], deps.auth),
  );
  return result.exitCode ?? 1;
}

export async function runAndEmitTextSecretsScan(
  callerCommand: SecretsCallerCommand,
  deps: HookDependencies,
  text: string,
): Promise<number> {
  const { result } = await scanAndEmitSecrets(callerCommand, deps.auth, () =>
    runSecretsBinaryOnText(deps.binaryPath, text, deps.auth),
  );
  return result.exitCode ?? 1;
}
