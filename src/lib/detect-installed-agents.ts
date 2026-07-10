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

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { InvalidOptionError } from '../cli/commands/_common/error';

export const DETECTED_AGENT_IDS = ['cursor', 'claude', 'codex', 'copilot', 'antigravity'] as const;

export type DetectedAgentId = (typeof DETECTED_AGENT_IDS)[number];

const AGENT_LABELS: Record<DetectedAgentId, string> = {
  cursor: 'Cursor',
  claude: 'Claude Code',
  codex: 'Codex',
  copilot: 'Copilot',
  antigravity: 'Antigravity',
};

export function agentDisplayName(agentId: DetectedAgentId): string {
  return AGENT_LABELS[agentId];
}

/** Heuristic detection of locally installed AI agents under the user home directory. */
export function detectInstalledAgents(filter?: DetectedAgentId[]): DetectedAgentId[] {
  const home = homedir();
  const candidates: { id: DetectedAgentId; detected: boolean }[] = [
    { id: 'cursor', detected: existsSync(join(home, '.cursor')) },
    {
      id: 'claude',
      detected: existsSync(join(home, '.claude')) || existsSync(join(home, '.claude.json')),
    },
    { id: 'codex', detected: existsSync(join(home, '.codex')) },
    { id: 'copilot', detected: existsSync(join(home, '.copilot')) },
    {
      id: 'antigravity',
      detected:
        existsSync(join(home, '.gemini', 'antigravity')) || existsSync(join(home, '.agents')),
    },
  ];

  const detected = candidates
    .filter((candidate) => candidate.detected)
    .map((candidate) => candidate.id);
  if (!filter || filter.length === 0) {
    return detected;
  }

  const allowed = new Set(filter);
  return detected.filter((agentId) => allowed.has(agentId));
}

export function parseAgentFilter(raw: string): DetectedAgentId[] {
  const requested = raw
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.length > 0);

  if (requested.length === 0) {
    throw new InvalidOptionError('--agents must list at least one agent.');
  }

  const invalid = requested.filter(
    (agentId): agentId is string => !DETECTED_AGENT_IDS.includes(agentId as DetectedAgentId),
  );
  if (invalid.length > 0) {
    throw new InvalidOptionError(
      `Unknown agent(s) in --agents: ${invalid.join(', ')}. Valid values: ${DETECTED_AGENT_IDS.join(', ')}.`,
    );
  }

  return requested as DetectedAgentId[];
}
