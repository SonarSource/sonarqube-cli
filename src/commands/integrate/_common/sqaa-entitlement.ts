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

import { AGENTIC_ANALYSIS_DOCS_URL } from '@/core/config-constants.ts';
import { SonarQubeClient, type SqaaEntitlementStatus } from '@/core/server/client.ts';
import { info, warn } from '@/core/ui';

export const SQAA_HOOK_FEATURE_ID = 'sonar-sqaa-hook';

/**
 * Consistent notice shown across all agent integrations when SonarQube Agentic
 * Analysis is skipped because the integration is global.
 */
export const SQAA_GLOBAL_SKIP_MESSAGE =
  'Skipping Vortex agentic analysis: not supported with --global. Re-run without --global from a project directory to install it there.';

/**
 * Shown when SonarQube Agentic Analysis is not available for the current connection.
 */
export const SQAA_PROMOTION_MESSAGE = `Vortex agentic analysis is available on SonarQube Cloud. Learn more: ${AGENTIC_ANALYSIS_DOCS_URL}`;

/**
 * Shown when the organization is entitled to SonarQube Agentic Analysis but has
 * reached its current usage limit. The integration is still installed so it works
 * again once consumption resets.
 */
export const SQAA_OVER_CONSUMPTION_MESSAGE =
  'Your organization has reached its Vortex agentic analysis usage limit. Installing it anyway — analysis will resume once your usage resets.';

export interface ResolveSqaaSetupParams {
  serverURL: string;
  token: string;
  organization: string | undefined;
  isGlobal: boolean;
}

/**
 * Resolve whether SonarQube Agentic Analysis (SQAA) can be installed.
 */
export async function resolveSqaaSetup(params: ResolveSqaaSetupParams): Promise<boolean> {
  let status: SqaaEntitlementStatus;
  try {
    status = await new SonarQubeClient(params.serverURL, params.token).hasSqaaEntitlement(
      params.organization,
    );
  } catch {
    status = 'check_failed';
  }

  if (status === 'check_failed') {
    warn('Could not determine Vortex agentic analysis entitlement — skipping.');
    return false;
  }
  if (status === 'not_enabled') {
    info(SQAA_PROMOTION_MESSAGE);
    return false;
  }
  if (params.isGlobal) {
    warn(SQAA_GLOBAL_SKIP_MESSAGE);
    return false;
  }
  // Entitled but over the current usage limit: still install so it works once
  // consumption resets, and warn the user it cannot run right now.
  if (status === 'over_consumption') {
    warn(SQAA_OVER_CONSUMPTION_MESSAGE);
  }
  // Explicit check so future statuses don't fall through to true.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  return status === 'enabled' || status === 'over_consumption';
}
