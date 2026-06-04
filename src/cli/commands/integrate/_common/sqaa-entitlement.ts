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

import { SonarQubeClient } from '../../../../sonarqube/client';
import { warn } from '../../../../ui';

/**
 * Check if the organization has SonarQube Agentic Analysis (SQAA) entitlement.
 *
 * Returns false for on-premise, missing org, or failed API call. The underlying
 * `hasSqaaEntitlement` already swallows network/API errors, so the try/catch
 * here is defence-in-depth for unexpected throws (e.g. malformed URLs from the
 * client constructor).
 */
export async function resolveSqaaEntitlement(
  serverURL: string,
  token: string,
  organization: string | undefined,
): Promise<boolean> {
  try {
    const client = new SonarQubeClient(serverURL, token);
    return await client.hasSqaaEntitlement(organization);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    warn(`Could not determine SonarQube Agentic Analysis entitlement — skipping: ${detail}`);
    return false;
  }
}

/**
 * Consistent notice shown across all agent integrations when SonarQube Agentic
 * Analysis is skipped because the integration is global.
 */
export const SQAA_GLOBAL_SKIP_MESSAGE =
  'Skipping SonarQube Agentic Analysis: not supported with --global. Re-run without --global from a project directory to install it there.';

export interface ResolveSqaaSetupParams {
  serverURL: string;
  token: string;
  organization: string | undefined;
  isGlobal: boolean;
}

/**
 * Resolve whether SonarQube Agentic Analysis (SQAA) should be installed.
 *
 * SQAA is always project-scoped, so a `--global` integration can never install
 * it. We still resolve org entitlement first so that, on a global install, the
 * skip notice is only shown to orgs that could actually use SQAA (avoiding noise
 * for unentitled orgs). For project installs this returns the raw entitlement.
 */
export async function resolveSqaaSetup(params: ResolveSqaaSetupParams): Promise<boolean> {
  const entitled = await resolveSqaaEntitlement(
    params.serverURL,
    params.token,
    params.organization,
  );
  if (params.isGlobal) {
    if (entitled) {
      warn(SQAA_GLOBAL_SKIP_MESSAGE);
    }
    return false;
  }
  return entitled;
}
