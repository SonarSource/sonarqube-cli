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

import type { DetectedAgentId } from '@/core/host/environment/installed-agent-detector.ts';
import type { AgentIntegrationHandlers } from '@/core/update/post-update.ts';

import type { IntegrateAgentOptions } from './_common/types.ts';
import { integrateAntigravity } from './antigravity';
import { ANTIGRAVITY_INTEGRATION_ID } from './antigravity/declaration.ts';
import { integrateClaude } from './claude';
import { CLAUDE_INTEGRATION_ID } from './claude/declaration.ts';
import { integrateCodex } from './codex';
import { CODEX_INTEGRATION_ID } from './codex/declaration.ts';
import { integrateCopilot } from './copilot';
import { COPILOT_INTEGRATION_ID } from './copilot/declaration.ts';
import { integrateCursor } from './cursor';
import { CURSOR_INTEGRATION_ID } from './cursor/declaration.ts';
import { integrateDevin } from './devin';
import { DEVIN_INTEGRATION_ID } from './devin/declaration.ts';
import { integrateOpenCode } from './opencode';
import { OPENCODE_INTEGRATION_ID } from './opencode/declaration.ts';
import { integratePi } from './pi';
import { PI_INTEGRATION_ID } from './pi/declaration.ts';

/**
 * Agent integrate handlers the global-integrations migration reruns, keyed by integration id. Git is
 * deliberately absent: a global git hook is overridden by any repository that sets its own
 * `core.hooksPath`, so local git integrations are left untouched.
 */
export const AGENT_INTEGRATION_HANDLERS = {
  [CLAUDE_INTEGRATION_ID]: integrateClaude,
  [CODEX_INTEGRATION_ID]: integrateCodex,
  [COPILOT_INTEGRATION_ID]: integrateCopilot,
  [CURSOR_INTEGRATION_ID]: integrateCursor,
  [ANTIGRAVITY_INTEGRATION_ID]: integrateAntigravity,
  [OPENCODE_INTEGRATION_ID]: integrateOpenCode,
  [DEVIN_INTEGRATION_ID]: integrateDevin,
  [PI_INTEGRATION_ID]: integratePi,
} satisfies AgentIntegrationHandlers;

export const AGENT_INTEGRATION_IDS = {
  antigravity: ANTIGRAVITY_INTEGRATION_ID,
  claude: CLAUDE_INTEGRATION_ID,
  codex: CODEX_INTEGRATION_ID,
  copilot: COPILOT_INTEGRATION_ID,
  cursor: CURSOR_INTEGRATION_ID,
  devin: DEVIN_INTEGRATION_ID,
  opencode: OPENCODE_INTEGRATION_ID,
  pi: PI_INTEGRATION_ID,
} satisfies Record<DetectedAgentId, keyof typeof AGENT_INTEGRATION_HANDLERS>;

export const BULK_SETUP_OPTIONS: IntegrateAgentOptions = {
  nonInteractive: true,
  isFromRouter: true,
  fromBulkSetup: true,
};
