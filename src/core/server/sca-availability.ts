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
import { CommandFailedError } from '@/core/command-error.ts';
import type { SonarQubeClient } from '@/core/server/client.ts';
import { fetchServerVersion, isAtLeast } from '@/core/server/server-info.ts';

export const MIN_SCA_SQS_VERSION = '2026.4';

export async function assertScaAvailable(
  client: Pick<SonarQubeClient, 'checkScaEnabled'>,
  auth: Pick<ResolvedAuth, 'connectionType' | 'serverUrl' | 'orgKey'>,
): Promise<void> {
  if (auth.connectionType !== 'cloud') {
    let serverVersion: string;
    try {
      serverVersion = await fetchServerVersion(auth.serverUrl);
    } catch (err) {
      throw new CommandFailedError(
        `Could not determine SonarQube Server version. Running Software Composition Analysis from this CLI requires SonarQube Server ${MIN_SCA_SQS_VERSION} or later.`,
        {
          cause: err,
          remediationHint:
            'Learn more: https://docs.sonarsource.com/sonarqube-cli/analysis/sca#prerequisites',
        },
      );
    }
    if (!isAtLeast(serverVersion, MIN_SCA_SQS_VERSION)) {
      throw new CommandFailedError(
        `Running Software Composition Analysis from this CLI requires SonarQube Server ${MIN_SCA_SQS_VERSION} or later (server is ${serverVersion}).`,
        {
          remediationHint:
            'Learn more: https://docs.sonarsource.com/sonarqube-cli/analysis/sca#prerequisites',
        },
      );
    }
  }
  const enabled = await client.checkScaEnabled(auth.connectionType, auth.orgKey);
  if (!enabled) {
    throw new CommandFailedError(
      'Software Composition Analysis is not available for the current connection.',
      {
        remediationHint:
          'Software Composition Analysis must be enabled by an administrator and requires an eligible SonarQube plan. Learn more: https://docs.sonarsource.com/sonarqube-cli/analysis/sca',
      },
    );
  }
}
