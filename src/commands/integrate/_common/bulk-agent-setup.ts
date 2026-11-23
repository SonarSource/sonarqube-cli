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

import { CommandFailedError } from '@/core/commands/command-error.ts';
import type { CommandAuthenticatedInvocationContext } from '@/core/commands/invocation-context.ts';
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
import type { CliState } from '@/core/state/state.ts';
import { loadState, updateState } from '@/core/state/state-repository.ts';
import type { Console } from '@/core/ui/console.ts';

import {
  AGENT_INTEGRATION_HANDLERS,
  AGENT_INTEGRATION_IDS,
  BULK_SETUP_OPTIONS,
} from '../integration-handlers.ts';
import { withAgentInstallLock } from './agent-install-lock.ts';

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
    copilot: [join(home, '.copilot', 'hooks.json'), join(home, '.copilot', 'mcp-config.json')],
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
      if (SONAR_CONFIGURATION.test(content) || (file.endsWith('.toml') && hasSonarToml(content))) {
        return true;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return true;
    }
  }
  return false;
}

function hasSonarToml(content: string): boolean {
  try {
    const servers = parse(content).mcp_servers;
    return typeof servers === 'object' && Object.hasOwn(servers, 'sonarqube');
  } catch {
    // The integration writer rejects malformed TOML before changing this file.
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
  for (const agent of agents) {
    console.print(agentDisplayName(agent) + ': ' + (await agentSetupStatus(agent, state)));
  }
  return (
    (await console.confirmPrompt('Set up the new coding agents listed above?', false)) === true
  );
}

export async function integrateAllAgents(
  ctx: CommandAuthenticatedInvocationContext,
  agents = detectInstalledAgents(),
): Promise<void> {
  if (!agents.length) {
    ctx.console.info('No supported coding agents detected.');
    return;
  }

  let failed = false;
  for (const agent of agents) {
    try {
      const outcome = await withAgentInstallLock(async () => {
        const status = await agentSetupStatus(agent, loadState());
        if (status !== 'Ready to configure') return status;

        const id = AGENT_INTEGRATION_IDS[agent];
        updateState((state) => {
          (state.integrations.onboarding ??= {})[id] = { status: 'retry_setup' };
        });
        await AGENT_INTEGRATION_HANDLERS[id](BULK_SETUP_OPTIONS, ctx);
        return 'Configured';
      });
      ctx.console.print(agentDisplayName(agent) + ': ' + outcome);
    } catch (error) {
      failed = true;
      ctx.console.warn(agentDisplayName(agent) + ': Retry setup. ' + (error as Error).message);
    }
  }
  if (failed) {
    throw new CommandFailedError('Some agents could not be configured.', {
      remediationHint: "Retry with 'sonar integrate --all --non-interactive'.",
    });
  }
}
