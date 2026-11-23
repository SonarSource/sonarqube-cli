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

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { parse } from 'smol-toml';

import type { ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import { CommandFailedError } from '@/core/commands/command-error.ts';
import type { CommandInvocationContext } from '@/core/commands/invocation-context.ts';
import {
  ANTIGRAVITY_GLOBAL_HOOKS_JSON,
  ANTIGRAVITY_GLOBAL_MCP_CONFIG_JSON,
  CURSOR_CONFIG_DIR,
} from '@/core/config-constants.ts';
import { resolveDevinConfigDir } from '@/core/host/environment/devin-config-dir.ts';
import {
  agentDisplayName,
  type DetectedAgentId,
  detectInstalledAgents,
} from '@/core/host/environment/installed-agent-detector.ts';
import { normalizeServerUrl } from '@/core/host/keychain.ts';
import type { AgentOnboardingState, CliState } from '@/core/state/state.ts';
import { loadState, updateState } from '@/core/state/state-repository.ts';
import type { Console } from '@/core/ui/console.ts';

import {
  AGENT_INTEGRATION_HANDLERS,
  AGENT_INTEGRATION_IDS,
  BULK_SETUP_OPTIONS,
} from '../integration-handlers.ts';
import { withAgentInstallLock } from './agent-install-lock.ts';
import { pendingAgentSetups, setupMatches, type SetupTarget } from './pending-agent-setup.ts';

type AgentSetupStatus = 'Ready to configure' | 'Already configured' | 'Skipped' | 'Needs review';

const SONAR_CONFIGURATION =
  /"sonarqube"\s*:|\[mcp_servers\.(?:["']sonarqube["']|sonarqube)\]|sonar-(?:secrets|sqaa|vortex|context-augmentation|agentic-analysis)/i;

function configFiles(agent: DetectedAgentId): string[] {
  const home = homedir();
  const files = {
    antigravity: [
      ANTIGRAVITY_GLOBAL_HOOKS_JSON,
      ANTIGRAVITY_GLOBAL_MCP_CONFIG_JSON,
      join(home, '.gemini', 'GEMINI.md'),
    ],
    claude: [join(home, '.claude.json'), join(home, '.claude', 'settings.json')],
    codex: [join(home, '.codex', 'hooks.json'), join(home, '.codex', 'config.toml')],
    copilot: [
      join(home, '.copilot', 'hooks', 'hooks.json'),
      join(home, '.copilot', 'mcp-config.json'),
    ],
    cursor: [
      join(home, CURSOR_CONFIG_DIR, 'hooks.json'),
      join(home, CURSOR_CONFIG_DIR, 'mcp.json'),
    ],
    devin: ['config.json', 'mcp_config.json'].map((file) =>
      join(resolveDevinConfigDir(home), file),
    ),
    opencode: ['opencode.json', 'plugins/sonar-secrets.ts', 'plugins/sonar-sqaa.ts'].map((file) =>
      join(home, '.config', 'opencode', file),
    ),
    pi: ['mcp.json', 'extensions/sonar-secrets.ts', 'extensions/sonar-sqaa.ts'].map((file) =>
      join(home, '.pi', 'agent', file),
    ),
  };
  return files[agent];
}

async function hasExistingConfig(agent: DetectedAgentId): Promise<boolean> {
  for (const file of configFiles(agent)) {
    try {
      const content = await readFile(file, 'utf8');
      if (SONAR_CONFIGURATION.test(content) || hasSonarMcpEntry(file, content)) {
        return true;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return true;
    }
  }
  return false;
}

function hasSonarMcpEntry(file: string, content: string): boolean {
  try {
    if (!file.endsWith('.json') && !file.endsWith('.toml')) return false;
    const config = (file.endsWith('.toml') ? parse(content) : JSON.parse(content)) as unknown;
    if (!config || typeof config !== 'object') return false;
    const settings = config as Record<string, unknown>;
    return ['mcp_servers', 'mcpServers', 'mcp'].some((key) => {
      const servers = settings[key];
      return typeof servers === 'object' && servers !== null && Object.hasOwn(servers, 'sonarqube');
    });
  } catch {
    return false;
  }
}

export async function agentSetupStatus(
  agent: DetectedAgentId,
  state: CliState,
): Promise<AgentSetupStatus> {
  const id = AGENT_INTEGRATION_IDS[agent];
  const onboarding = state.integrations.onboarding?.[id];
  if (onboarding?.status === 'skipped') return 'Skipped';
  if (onboarding?.status === 'retry_setup') return 'Ready to configure';
  if (
    state.integrations.installed.some(
      (integration) => integration.integrationId === id && integration.features.length > 0,
    ) ||
    (Object.hasOwn(state.agents, id) && state.agents[id].configured) ||
    state.agentExtensions.some((extension) => extension.agentId === id)
  ) {
    return 'Already configured';
  }
  return (await hasExistingConfig(agent)) ? 'Needs review' : 'Ready to configure';
}

export async function previewBulkSetup(
  console: Console,
  agents: DetectedAgentId[],
): Promise<boolean> {
  if (!agents.length) return true;
  const state = loadState();
  const statuses = await Promise.all(agents.map((agent) => agentSetupStatus(agent, state)));
  agents.forEach((agent, index) => {
    console.print(agentDisplayName(agent) + ': ' + statuses[index]);
  });
  return (
    (await console.confirmPrompt('Set up the new coding agents listed above?', false)) === true
  );
}

export async function integrateAllAgents(
  ctx: CommandInvocationContext,
  auth: ResolvedAuth | null,
  agents = detectInstalledAgents(),
  target: SetupTarget = {},
  pendingOnly = false,
): Promise<void> {
  if (!agents.length) {
    ctx.console.info('No supported coding agents detected.');
    return;
  }

  const failed = await agents.reduce(async (previous, agent) => {
    const alreadyFailed = await previous;
    try {
      const outcome = await withAgentInstallLock(() =>
        configureAgent(ctx, agent, auth, target, pendingOnly),
      );
      ctx.console.print(agentDisplayName(agent) + ': ' + outcome);
      return alreadyFailed;
    } catch (error) {
      ctx.console.warn(agentDisplayName(agent) + ': Retry setup. ' + (error as Error).message);
      return true;
    }
  }, Promise.resolve(false));
  if (failed) {
    throw new CommandFailedError('Some agents could not be configured.', {
      remediationHint: "Retry with 'sonar integrate --all --non-interactive'.",
    });
  }
}

async function configureAgent(
  ctx: CommandInvocationContext,
  agent: DetectedAgentId,
  auth: ResolvedAuth | null,
  target: SetupTarget,
  pendingOnly: boolean,
): Promise<string> {
  const state = loadState();
  const status = await agentSetupStatus(agent, state);
  if (status !== 'Ready to configure') return status;

  const id = AGENT_INTEGRATION_IDS[agent];
  const pending = state.integrations.onboarding?.[id];
  if (pendingOnly && (!pending || !auth || !setupMatches(auth, pending))) {
    return 'Setup no longer pending for this connection';
  }
  const requested = combineSetupTargets(pending, target);
  const usesSavedLogin =
    pending?.status === 'waiting_for_sign_in' ||
    target.server !== undefined ||
    pending?.server !== undefined;
  if (!auth || !setupMatches(auth, requested) || (usesSavedLogin && auth.comesFromEnv())) {
    if (!pending || pending.server !== requested.server || pending.org !== requested.org) {
      saveAgentOnboarding(id, { ...requested, status: pending?.status ?? 'waiting_for_sign_in' });
    }
    return 'Waiting for sign-in';
  }

  const boundTarget = usesSavedLogin
    ? { server: normalizeServerUrl(auth.serverUrl), org: auth.orgKey }
    : requested;
  saveAgentOnboarding(id, { ...boundTarget, status: 'retry_setup' });
  const installContext = ctx.withAuth(auth);
  try {
    await AGENT_INTEGRATION_HANDLERS[id](BULK_SETUP_OPTIONS, installContext);
  } finally {
    ctx.recordTelemetry(...installContext.telemetryFacts());
    for (const fact of installContext.statsFacts()) ctx.recordStats(() => fact);
  }
  return 'Configured';
}

function combineSetupTargets(pending: SetupTarget | undefined, target: SetupTarget): SetupTarget {
  const conflicts = (['server', 'org'] as const).some(
    (key) =>
      pending?.[key] !== undefined && target[key] !== undefined && pending[key] !== target[key],
  );
  if (conflicts) {
    throw new CommandFailedError('Pending setup targets a different SonarQube connection.');
  }
  return { server: target.server ?? pending?.server, org: target.org ?? pending?.org };
}

function saveAgentOnboarding(id: string, pending: AgentOnboardingState): void {
  updateState((state) => {
    state.integrations.onboarding ??= {};
    state.integrations.onboarding[id] = pending;
  });
}

export async function resumePendingAgentSetups(
  ctx: CommandInvocationContext,
  auth: ResolvedAuth,
): Promise<boolean> {
  if (auth.comesFromEnv()) return false;
  const agents = pendingAgentSetups(loadState())
    .filter((pending) => setupMatches(auth, pending))
    .map((pending) => pending.agent);
  if (!agents.length) return false;
  try {
    await integrateAllAgents(ctx, auth, agents, {}, true);
  } catch {
    ctx.console.warn(
      "Sign-in succeeded. Retry pending setup with 'sonar integrate --all --non-interactive'.",
    );
  }
  return true;
}
