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

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { version as CLI_VERSION } from '../../package.json';
import { ONBOARD_PROFILE_FILE } from './config-constants';
import type { DetectedAgentId } from './detect-installed-agents';

export interface MachineOnboardProfile {
  onboardedAt: string;
  onboardedByCliVersion: string;
  agents: DetectedAgentId[];
  preset: 'recommended' | 'minimal';
}

export function loadOnboardProfile(): MachineOnboardProfile | null {
  try {
    const raw = readFileSync(ONBOARD_PROFILE_FILE, 'utf-8');
    return JSON.parse(raw) as MachineOnboardProfile;
  } catch {
    return null;
  }
}

export function saveOnboardProfile(
  profile: Omit<MachineOnboardProfile, 'onboardedAt' | 'onboardedByCliVersion'>,
): MachineOnboardProfile {
  const saved: MachineOnboardProfile = {
    ...profile,
    onboardedAt: new Date().toISOString(),
    onboardedByCliVersion: CLI_VERSION,
  };
  mkdirSync(dirname(ONBOARD_PROFILE_FILE), { recursive: true });
  writeFileSync(ONBOARD_PROFILE_FILE, JSON.stringify(saved, null, 2), 'utf-8');
  return saved;
}
