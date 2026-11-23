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

import { join } from 'node:path';

import type { SessionStartAgent } from '@/commands/hook/agent-session-start/types.ts';
import { CURSOR_CONFIG_DIR } from '@/core/config-constants.ts';
import type { FeatureDeclaration, IntegrationContext } from '@/core/framework/features';
import { jsonPatch, type ResourceDeclaration, wholeFile } from '@/core/framework/resources';
import { resolveDevinConfigDir } from '@/core/host/environment/devin-config-dir.ts';
import type { DetectedAgentId } from '@/core/host/environment/installed-agent-detector.ts';

import {
  buildCopilotHookEntry,
  removeCopilotHooks,
  upsertCopilotHooks,
} from '../../copilot/hooks.ts';
import { buildCursorHookEntry, removeCursorHooks, upsertCursorHooks } from '../../cursor/hooks.ts';
import { PI_EXTENSION_HELPERS } from '../../pi/extension-helpers.ts';
import {
  buildUnixHookScript,
  buildWindowsHookScript,
  createAgentHookEntry,
  removeAgentHooks,
  resolveAgentHookScriptPath,
  upsertAgentHooks,
} from '../hooks.ts';
import type { IntegrateAgentOptions } from '../types.ts';

export const AGENT_ONBOARDING_FEATURE_ID = 'agent-onboarding';
const MARKER = 'sonar-agent-onboarding';
const SCRIPT = MARKER + '/session-start';

const SESSION_CONFIGS = {
  claude: ['.claude', 'settings.json'],
  codex: ['.codex', 'hooks.json'],
  copilot: ['.copilot', 'hooks/hooks.json'],
  cursor: [CURSOR_CONFIG_DIR, 'hooks.json'],
  devin: ['', 'config.json'],
} satisfies Record<Exclude<SessionStartAgent, 'pi'>, string[]>;

const ON_DEMAND_SKILL = `---
name: sonar-sign-in
description: Help the user sign in and complete pending SonarQube setup when they ask for a Sonar check.
---

If the user asks for a Sonar check, run \`sonar system status --format json\`. When this agent has a pending integration, tell the user that signing in activates SonarQube for this agent. Ask the user to run \`sonar auth login\` in their terminal. Include the server and organization from the pending entry if supplied. Do not open a browser on the user's behalf or ask for a token. After sign-in, recheck status and continue the original request. If pending setup remains with the intended account, use \`sonar integrate --all --non-interactive\`. Explain any required session restart or project linking before the check can run.
`;

function sessionContext(agent: SessionStartAgent, context: IntegrationContext): IntegrationContext {
  return agent === 'devin'
    ? { ...context, targetRoot: resolveDevinConfigDir(context.targetRoot) }
    : context;
}

function createHookResources(agent: Exclude<SessionStartAgent, 'pi'>): ResourceDeclaration[] {
  const [configDir, file] = SESSION_CONFIGS[agent];
  const scriptPath = (context: IntegrationContext) =>
    resolveAgentHookScriptPath(sessionContext(agent, context), configDir, SCRIPT);
  const command = 'agent-onboarding --agent ' + agent;
  return [
    wholeFile({
      id: 'agent-onboarding-hook-script',
      targetPath: scriptPath,
      executable: true,
      content: { unix: buildUnixHookScript(command), windows: buildWindowsHookScript(command) },
    }),
    jsonPatch({
      id: 'agent-onboarding-hook-config',
      targetPath: (context) => join(sessionContext(agent, context).targetRoot, configDir, file),
      defaultValue: {
        ...(agent === 'cursor' || agent === 'copilot' ? { version: 1 } : {}),
        hooks: {},
      },
      patch: (doc, context) => {
        if (agent === 'copilot') {
          return upsertCopilotHooks(doc, MARKER, {
            sessionStart: buildCopilotHookEntry(scriptPath(context)),
          });
        }
        if (agent === 'cursor') {
          return upsertCursorHooks(doc, [
            buildCursorHookEntry(context, configDir, 'sessionStart', SCRIPT, { marker: MARKER }),
          ]);
        }
        const matcher = agent === 'devin' ? '' : 'startup|clear';
        return upsertAgentHooks(doc, [
          createAgentHookEntry(
            sessionContext(agent, context),
            configDir,
            'SessionStart',
            matcher,
            MARKER,
            SCRIPT,
          ),
        ]);
      },
      removePatch: (doc) => {
        if (agent === 'copilot') return removeCopilotHooks(doc, [MARKER]);
        if (agent === 'cursor') return removeCursorHooks(doc, [MARKER]);
        return removeAgentHooks(doc, [MARKER]);
      },
    }),
  ];
}

function createPiExtension(): ResourceDeclaration {
  return wholeFile({
    id: 'agent-onboarding-pi-extension',
    managedMarker: MARKER,
    targetPath: (context) => join(context.targetRoot, '.pi', 'agent', 'extensions', MARKER + '.ts'),
    content: `// ${MARKER} — do not edit by hand.
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
${PI_EXTENSION_HELPERS}

export default function (pi: ExtensionAPI) {
  pi.on('session_start', async (_event, ctx) => {
    try {
      const { userMessage } = await runHook<{ userMessage?: string }>(
        'agent-onboarding --agent pi',
        { sessionID: ctx.sessionManager.getSessionId(), cwd: ctx.cwd },
        3000,
        ctx.cwd,
      );
      if (userMessage) {
        pi.sendMessage({
          customType: '${MARKER}',
          content: [{ type: 'text', text: userMessage }],
          display: true,
        });
      }
    } catch {
      return;
    }
  });
}
`,
  });
}

export function createAgentOnboardingFeature<TOptions extends IntegrateAgentOptions>(
  agent: DetectedAgentId,
): FeatureDeclaration<TOptions> {
  return {
    id: AGENT_ONBOARDING_FEATURE_ID,
    displayName: 'SonarQube sign-in guidance',
    required: true,
    isAvailable: ({ options }) => ({ available: options.prepareOnboarding === true }),
    resources: onboardingResources(agent),
  };
}

function onboardingResources(agent: DetectedAgentId): ResourceDeclaration[] {
  if (agent === 'pi') return [createPiExtension()];
  if (agent === 'opencode' || agent === 'antigravity') {
    return [
      wholeFile({
        id: 'agent-onboarding-skill',
        managedMarker: MARKER,
        targetPath: (context) =>
          join(
            context.targetRoot,
            ...(agent === 'opencode' ? ['.config', 'opencode'] : []),
            'skills',
            'sonar-sign-in',
            'SKILL.md',
          ),
        content: ON_DEMAND_SKILL + '\n<!-- ' + MARKER + ' -->\n',
      }),
    ];
  }
  return createHookResources(agent);
}
