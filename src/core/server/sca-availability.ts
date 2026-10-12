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

import type { ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import { CommandFailedError } from '@/core/commands/command-error.ts';
import type { FeatureAvailability } from '@/core/framework/features/types.ts';
import logger from '@/core/observability/logger.ts';
import type { ScaEnablement } from '@/core/server/sca.ts';
import { fetchServerVersion, isAtLeast } from '@/core/server/server-info.ts';

export const MIN_SCA_SQS_VERSION = '2026.4';

/**
 * The one call this module needs, expressed as a plain `Promise`. `ScaClient`
 * returns `ResultAsync`, so callers collapse it first (e.g. `ScaScanApi` in `sca-api.ts`,
 * or an inline adapter) before handing it here.
 */
export interface ScaAvailabilityCheck {
  getScaEnablement(
    connectionType: ResolvedAuth['connectionType'],
    orgKey?: string,
  ): Promise<ScaEnablement>;
}

const SCA_PREREQUISITES_HINT =
  'Learn more: https://docs.sonarsource.com/sonarqube-cli/analysis/sca#prerequisites';

type ScaAuth = Pick<ResolvedAuth, 'connectionType' | 'serverUrl' | 'orgKey'>;

/** Throws `CommandFailedError` when availability cannot be determined. */
async function resolveScaAvailability(
  client: ScaAvailabilityCheck,
  auth: ScaAuth,
): Promise<FeatureAvailability> {
  if (auth.connectionType !== 'cloud') {
    let serverVersion: string;
    try {
      serverVersion = await fetchServerVersion(auth.serverUrl);
    } catch (err) {
      throw new CommandFailedError(
        `Could not determine SonarQube Server version. Running Software Composition Analysis from this CLI requires SonarQube Server ${MIN_SCA_SQS_VERSION} or later.`,
        { cause: err, remediationHint: SCA_PREREQUISITES_HINT },
      );
    }
    if (!isAtLeast(serverVersion, MIN_SCA_SQS_VERSION)) {
      return {
        available: false,
        unavailableReason: `Running Software Composition Analysis from this CLI requires SonarQube Server ${MIN_SCA_SQS_VERSION} or later (server is ${serverVersion}). ${SCA_PREREQUISITES_HINT}`,
      };
    }
  }
  const enablement = await client.getScaEnablement(auth.connectionType, auth.orgKey);
  if (enablement === 'check_failed') {
    throw new CommandFailedError(
      'Could not check whether Software Composition Analysis is available for the current connection.',
      { remediationHint: SCA_PREREQUISITES_HINT },
    );
  }
  if (enablement === 'not_enabled') {
    return {
      available: false,
      unavailableReason:
        'Software Composition Analysis is not available for the current connection. It must be enabled by an administrator and requires an eligible SonarQube plan. Learn more: https://docs.sonarsource.com/sonarqube-cli/analysis/sca',
    };
  }
  return { available: true };
}

export async function checkScaAvailability(
  client: ScaAvailabilityCheck,
  auth: ScaAuth,
): Promise<FeatureAvailability> {
  try {
    return await resolveScaAvailability(client, auth);
  } catch (err) {
    const error = err as Error;
    const cause = error.cause instanceof Error ? `: ${error.cause.message}` : '';
    logger.debug(`${error.message}${cause}`);
    return { available: undefined };
  }
}

export async function assertScaAvailable(
  client: ScaAvailabilityCheck,
  auth: ScaAuth,
): Promise<void> {
  const { available, unavailableReason } = await resolveScaAvailability(client, auth);
  if (!available) {
    throw new CommandFailedError(
      unavailableReason ??
        'Software Composition Analysis is not available for the current connection.',
    );
  }
}
