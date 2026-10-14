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

// Which AI agents are installed on this machine. Distinct from
// `agent-detector.ts`, which identifies the agent *currently invoking* the CLI:
// this answers "what should a machine-wide `sonar integrate` set up?", which
// is a superset.

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { CURSOR_CONFIG_DIR } from '@/core/config-constants.ts';

import type { CallerAgent } from './agent-detector.ts';
import { resolveDevinConfigDir } from './devin-config-dir.ts';

/** Same id set as `CallerAgent` — reused, not redeclared, so adding a new agent can't let the two drift apart. */
export type DetectedAgentId = CallerAgent;

const AGENT_LABELS: Record<CallerAgent, string> = {
  cursor: 'Cursor',
  claude: 'Claude Code',
  codex: 'Codex',
  copilot: 'Copilot',
  antigravity: 'Antigravity',
  opencode: 'OpenCode',
  devin: 'Devin',
};

export const SUPPORTED_AGENT_IDS = Object.keys(AGENT_LABELS) as CallerAgent[];

export function agentDisplayName(agentId: DetectedAgentId): string {
  return AGENT_LABELS[agentId];
}

/** Where to look: the home directory plus the environment and platform that locate per-OS config dirs. */
interface MarkerLocation {
  home: string;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
}

type MarkerResolver = (location: MarkerLocation) => string[];

function underHome(...markers: string[]): MarkerResolver {
  return ({ home }) => markers.map((marker) => join(home, marker));
}

/**
 * Marker paths that indicate an agent has run at least once. Deliberately
 * excludes shared cross-tool directories such as `~/.agents`, which several
 * agents write to and so identify none of them.
 */
const AGENT_MARKERS: Record<DetectedAgentId, MarkerResolver> = {
  cursor: underHome(CURSOR_CONFIG_DIR),
  claude: underHome('.claude', '.claude.json'),
  codex: underHome('.codex'),
  copilot: underHome('.copilot'),
  antigravity: underHome(join('.gemini', 'config')),
  opencode: underHome(join('.config', 'opencode')),
  devin: ({ home, env, platform }) => [resolveDevinConfigDir(home, env, platform)],
};

export function detectInstalledAgents(
  home: string = homedir(),
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): DetectedAgentId[] {
  return SUPPORTED_AGENT_IDS.filter((agentId) =>
    AGENT_MARKERS[agentId]({ home, env, platform }).some((marker) => existsSync(marker)),
  );
}

/** True when `value` is one of the agents actually detected as installed on this machine. */
export function isDetectedAgentId(
  value: string,
  home: string = homedir(),
): value is DetectedAgentId {
  return (detectInstalledAgents(home) as readonly string[]).includes(value);
}
