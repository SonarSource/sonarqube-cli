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

// Binary version refresh for already-installed SonarSource tools, consumed by
// the post-update mechanism that runs automatically after CLI upgrades.

import { SCA_SCANNER_BINARY_NAME, SECRETS_BINARY_NAME } from '@/core/host/install/install-types.ts';
import { installScaScannerBinary } from '@/core/host/install/sca-scanner.ts';
import { installSecretsBinary } from '@/core/host/install/secrets.ts';
import { TerminalConsole } from '@/core/ui/terminal-console.ts';

import logger from '../observability/logger.ts';
import type { CliState } from '../state/state.ts';
import { loadState } from '../state/state-repository.ts';

/**
 * Update the sonar-secrets binary if it is already installed but targets a different version
 * than the one bundled with this CLI release.
 */
export async function updateSecretsBinaryIfNeeded(): Promise<void> {
  const state = loadState();

  if (!hasBinaryInState(state, SECRETS_BINARY_NAME)) {
    logger.debug('sonar-secrets not installed — skipping binary update');
    return;
  }

  await installSecretsBinary(new TerminalConsole());
}

/**
 * Update the sca-scanner-cli binary if it is already installed but targets a different version
 * than the one bundled with this CLI release.
 */
export async function updateScaScannerBinaryIfNeeded(): Promise<void> {
  const state = loadState();

  if (!hasBinaryInState(state, SCA_SCANNER_BINARY_NAME)) {
    logger.debug('sca-scanner-cli not installed — skipping binary update');
    return;
  }

  await installScaScannerBinary(new TerminalConsole());
}

function hasBinaryInState(state: CliState, binaryName: string): boolean {
  return state.dependencies.installed.some((dependency) => dependency.id === binaryName);
}
