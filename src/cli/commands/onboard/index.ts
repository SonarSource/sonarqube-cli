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

import type { ResolvedAuth } from '../../../lib/auth-resolver';
import {
  agentDisplayName,
  type DetectedAgentId,
  detectInstalledAgents,
  parseAgentFilter,
} from '../../../lib/detect-installed-agents';
import { saveOnboardProfile } from '../../../lib/onboard-profile';
import {
  blank as uiBlank,
  confirmPrompt,
  info,
  intro,
  phase,
  phaseItem,
  success,
  text,
  warn,
} from '../../../ui';
import { CommandFailedError } from '../_common/error';
import type { IntegrateAgentOptions } from '../integrate/_common/types';
import { integrateAntigravity } from '../integrate/antigravity';
import { integrateClaude } from '../integrate/claude';
import { integrateCodex } from '../integrate/codex';
import { integrateCopilot } from '../integrate/copilot';
import { integrateCursor } from '../integrate/cursor';

export interface OnboardOptions {
  yes?: boolean;
  nonInteractive?: boolean;
  agents?: string;
  minimal?: boolean;
  skipContext?: boolean;
}

const AGENT_HANDLERS: Record<
  DetectedAgentId,
  (options: IntegrateAgentOptions, auth: ResolvedAuth) => Promise<void>
> = {
  claude: integrateClaude,
  codex: integrateCodex,
  copilot: integrateCopilot,
  cursor: integrateCursor,
  antigravity: integrateAntigravity,
};

export async function runOnboard(options: OnboardOptions, auth: ResolvedAuth): Promise<void> {
  intro('SonarQube Onboarding');
  phase('Connection', [
    phaseItem('Server', 'done', auth.serverUrl),
    phaseItem('Organization', auth.orgKey ? 'done' : 'skipped', auth.orgKey ?? 'n/a'),
  ]);
  uiBlank();

  const filter = options.agents ? parseAgentFilter(options.agents) : undefined;
  const detected = detectInstalledAgents(filter);
  if (detected.length === 0) {
    throw new CommandFailedError('No supported AI agents detected on this machine.', {
      remediationHint:
        'Install Cursor, Claude Code, Codex, Copilot, or Antigravity, or pass --agents to target a specific tool.',
    });
  }

  phase(
    'Agents detected',
    detected.map((agentId) => phaseItem(agentDisplayName(agentId), 'done', agentId)),
  );
  uiBlank();

  info('This will install global SonarQube integration for detected agents.');
  info('Sonar-linked repositories will be resolved automatically at runtime — no per-repo setup.');
  uiBlank();

  const interactive =
    !options.yes && !options.nonInteractive && process.stdin.isTTY && process.stdout.isTTY;
  if (interactive) {
    const confirmed = await confirmPrompt('Proceed with machine-wide installation?', true);
    if (!confirmed) {
      throw new CommandFailedError('Onboarding cancelled.');
    }
    uiBlank();
  }

  const integrateOptions: IntegrateAgentOptions = {
    global: true,
    nonInteractive: true,
    onboardMode: true,
    skipContext: options.skipContext,
    skipSqaa: options.minimal,
  };

  const installed: DetectedAgentId[] = [];
  for (const agentId of detected) {
    text(`Installing ${agentDisplayName(agentId)}...`);
    try {
      await AGENT_HANDLERS[agentId](integrateOptions, auth);
      installed.push(agentId);
    } catch (err) {
      warn(
        `Failed to onboard ${agentDisplayName(agentId)}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    uiBlank();
  }

  if (installed.length === 0) {
    throw new CommandFailedError('Onboarding failed for all detected agents.', {
      remediationHint:
        'Fix any agent config errors reported above (e.g. invalid ~/.cursor/mcp.json) and re-run: sonar onboard --yes',
    });
  }

  if (installed.length < detected.length) {
    warn(
      `Onboarded ${installed.length}/${detected.length} agents. Re-run after fixing reported errors.`,
    );
  }

  if (!options.skipContext && !options.minimal) {
    info(
      'Context augmentation daemon starts automatically on first sonar context use in a Sonar-linked repo.',
    );
  }

  saveOnboardProfile({
    agents: installed,
    preset: options.minimal ? 'minimal' : 'recommended',
  });

  success('Setup complete!');
  uiBlank();
  text('Next steps:');
  text('  1. Restart your AI tool(s)');
  text('  2. Open a Sonar-linked project and start coding');
  text('  3. Run: sonar auth status');
}
