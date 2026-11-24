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

import type { CommandInvocationContext } from '@/core/commands/invocation-context.ts';
import { SUPPORTED_AGENT_IDS } from '@/core/host/environment/installed-agent-detector.ts';
import { normalizeServerUrl } from '@/core/host/keychain.ts';
import logger from '@/core/observability/logger.ts';
import { discoverProject } from '@/core/project-discovery/project-info.ts';
import { tryLoadState, updateState } from '@/core/state/state-repository.ts';

import { formatSetupLoginCommand } from '../integrate/_common/pending-agent-setup.ts';
import { AGENT_INTEGRATION_IDS } from '../integrate/integration-handlers.ts';
import { resolveAdapter } from './agent-session-start/index.ts';
import { inheritedClaudeHookHost } from './inherited-claude-hook.ts';
import { readStdinJson } from './stdin.ts';

export const AGENT_ONBOARDING_HOOK = 'agent-onboarding';

export async function agentOnboarding(
  ctx: CommandInvocationContext,
  rawAgent: string,
): Promise<void> {
  const agent = SUPPORTED_AGENT_IDS.find((id) => id === rawAgent);
  const adapter = agent ? resolveAdapter(agent) : undefined;
  if (!agent || !adapter) return;

  try {
    const state = tryLoadState();
    const id = AGENT_INTEGRATION_IDS[agent];
    const pending = state?.integrations.onboarding?.[id];
    if (pending?.status !== 'waiting_for_sign_in' || pending.invitationShown) return;

    const payload = await readStdinJson<unknown>();
    if (agent === 'claude' && inheritedClaudeHookHost(payload)) return;
    const input = adapter.parse(payload);
    if (input.eventName === 'SubagentStart' || !input.startDir) return;

    const project = await discoverProject(input.startDir, {
      auth: null,
      useGitRemoteBinding: false,
      silent: true,
      console: ctx.console,
    });
    if (!project.projectKey && !project.hasSonarConfig && !project.ambiguousProject) return;
    if (
      pending.server &&
      project.serverUrl &&
      normalizeServerUrl(project.serverUrl) !== pending.server
    )
      return;
    if (pending.org && project.organization && pending.org !== project.organization) return;
    if (!claimInvitation(id)) return;

    const loginCommand = formatSetupLoginCommand(pending);
    const userMessage =
      'Sign in to SonarQube to check the changes you make here. Run ' +
      loginCommand +
      ' in your terminal when ready, or dismiss this message to continue coding.';
    const additionalContext =
      'Show the following one-time invitation to the user and wait for acceptance before helping them sign in. ' +
      userMessage +
      ' If the user asks to check changes, retain the request across sign-in and continue when setup is ready.';
    process.stdout.write(
      JSON.stringify(adapter.emit({ userMessage, additionalContext }, input)) + '\n',
    );
  } catch (error) {
    logger.debug('Skipping SonarQube onboarding invitation: ' + (error as Error).message);
  }
}

function claimInvitation(id: string): boolean {
  return updateState((state) => {
    const pending = state.integrations.onboarding?.[id];
    if (pending?.status !== 'waiting_for_sign_in' || pending.invitationShown) return false;
    pending.invitationShown = true;
    return true;
  });
}
