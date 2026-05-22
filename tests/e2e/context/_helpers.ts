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

// Shared scaffolding for offline `tests/e2e/context/*` suites.

import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { CONTEXT_AUGMENTATION_BINARY_NAME } from '../../../src/lib/install-types';
import type { CliState, SkillExtension } from '../../../src/lib/state';
import { getDefaultState } from '../../../src/lib/state';
import type { TestHarness } from '../../integration/harness';

export const STALE_CLI_VERSION = '0.0.1';
export const STALE_SKILL_VERSION = '0.0.0';
export const SEEDED_PROJECT_KEY = 'offline-test-project';
export const SEEDED_ORG_KEY = 'offline-test-org';

export const CLAUDE_SKILL_RELATIVE_PATH = join(
  '.claude',
  'skills',
  CONTEXT_AUGMENTATION_BINARY_NAME,
  'SKILL.md',
);
export const COPILOT_SKILL_RELATIVE_PATH = join(
  '.github',
  'skills',
  CONTEXT_AUGMENTATION_BINARY_NAME,
  'SKILL.md',
);

export interface SeedSkillOptions {
  agentId: 'claude-code' | 'copilot-cli';
  projectRoot: string;
  global?: boolean;
  version?: string;
  projectKey?: string;
  orgKey?: string;
}

export function buildSkillExtension(opts: SeedSkillOptions): SkillExtension {
  return {
    id: `e2e-skill-${randomUUID()}`,
    kind: 'skill',
    agentId: opts.agentId,
    projectRoot: opts.projectRoot,
    global: opts.global ?? false,
    projectKey: opts.projectKey ?? SEEDED_PROJECT_KEY,
    orgKey: opts.orgKey ?? SEEDED_ORG_KEY,
    serverUrl: 'https://sonarcloud.io',
    updatedByCliVersion: STALE_CLI_VERSION,
    updatedAt: new Date(0).toISOString(),
    name: CONTEXT_AUGMENTATION_BINARY_NAME,
    version: opts.version ?? STALE_SKILL_VERSION,
    scaEnabled: false,
  };
}

export interface SeedStateOptions {
  cliVersion?: string;
  skills?: SeedSkillOptions[];
}

export function seedState(harness: TestHarness, options: SeedStateOptions = {}): void {
  mkdirSync(harness.cliHome.path, { recursive: true });
  const state = getDefaultState(options.cliVersion ?? STALE_CLI_VERSION);
  state.telemetry.enabled = false;
  for (const skill of options.skills ?? []) {
    state.agentExtensions.push(buildSkillExtension(skill));
  }
  writeFileSync(harness.stateJsonFile.path, JSON.stringify(state, null, 2), 'utf-8');
}

export function findRecordedCagSkill(
  state: CliState,
  predicate?: (skill: SkillExtension) => boolean,
): SkillExtension | undefined {
  return state.agentExtensions.find((extension): extension is SkillExtension => {
    if (extension.kind !== 'skill' || extension.name !== CONTEXT_AUGMENTATION_BINARY_NAME) {
      return false;
    }
    return predicate ? predicate(extension) : true;
  });
}
