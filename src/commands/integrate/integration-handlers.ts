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

import type { AgentIntegrationHandlers } from '@/core/update/post-update.ts';

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

/**
 * Agent integrate handlers the global-integrations migration reruns, keyed by integration id. Git is
 * deliberately absent: a global git hook is overridden by any repository that sets its own
 * `core.hooksPath`, so local git integrations are left untouched.
 */
export const AGENT_INTEGRATION_HANDLERS: AgentIntegrationHandlers = {
  [CLAUDE_INTEGRATION_ID]: integrateClaude,
  [CODEX_INTEGRATION_ID]: integrateCodex,
  [COPILOT_INTEGRATION_ID]: integrateCopilot,
  [CURSOR_INTEGRATION_ID]: integrateCursor,
  [ANTIGRAVITY_INTEGRATION_ID]: integrateAntigravity,
};
