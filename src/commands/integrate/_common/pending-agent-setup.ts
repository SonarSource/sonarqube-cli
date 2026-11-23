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

import {
  isSonarQubeCloud,
  isValidServerUrl,
  type ResolvedAuth,
} from '@/core/auth/auth-resolver.ts';
import { InvalidOptionError } from '@/core/commands/command-error.ts';
import { SONARCLOUD_URL } from '@/core/config-constants.ts';
import { SUPPORTED_AGENT_IDS } from '@/core/host/environment/installed-agent-detector.ts';
import { normalizeServerUrl } from '@/core/host/keychain.ts';
import { shellQuote } from '@/core/host/shell-quote.ts';
import type { AgentOnboardingState, CliState } from '@/core/state/state.ts';

import { AGENT_INTEGRATION_IDS } from '../integration-handlers.ts';

export type SetupTarget = Pick<AgentOnboardingState, 'server' | 'org'>;

export function resolveSetupTarget(options: SetupTarget): SetupTarget {
  const org = options.org?.trim();
  const server = options.server?.trim() ?? (org ? SONARCLOUD_URL : undefined);
  if (server !== undefined && !isValidServerUrl(server)) {
    throw new InvalidOptionError('--server requires a valid HTTP(S) URL.');
  }
  if (options.org !== undefined && (!org || !server || !isSonarQubeCloud(server))) {
    throw new InvalidOptionError('--org requires a nonempty SonarQube Cloud organization key.');
  }
  return { ...(server ? { server: normalizeServerUrl(server) } : {}), ...(org ? { org } : {}) };
}

export function formatSetupLoginCommand(target: SetupTarget): string {
  return [
    'sonar auth login',
    ...(target.server ? ['--server', shellQuote(target.server)] : []),
    ...(target.org ? ['--org', shellQuote(target.org)] : []),
  ].join(' ');
}

export function setupMatches(
  auth: Pick<ResolvedAuth, 'serverUrl' | 'orgKey'>,
  target: SetupTarget,
): boolean {
  return (
    (target.server === undefined || normalizeServerUrl(auth.serverUrl) === target.server) &&
    (target.org === undefined || auth.orgKey === target.org)
  );
}

export function pendingAgentSetups(state: CliState) {
  return SUPPORTED_AGENT_IDS.flatMap((agent) => {
    const pending = state.integrations.onboarding?.[AGENT_INTEGRATION_IDS[agent]];
    if (!pending || pending.status === 'skipped') return [];
    return [{ agent, status: pending.status, server: pending.server, org: pending.org }];
  });
}
