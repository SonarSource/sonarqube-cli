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

import { expect } from 'bun:test';

import {
  CONTEXT_AUGMENTATION_FEATURE_ID,
  CONTEXT_AUGMENTATION_SKILL_RESOURCE_ID,
  CONTEXT_AUGMENTATION_TOOL_INTEGRATION_OPERATION_ID,
} from '../../../src/cli/commands/integrate/_common/features/context-augmentation-feature';
import { CLAUDE_INTEGRATION_ID } from '../../../src/cli/commands/integrate/claude/declaration';
import { CODEX_INTEGRATION_ID } from '../../../src/cli/commands/integrate/codex/declaration';
import { COPILOT_INTEGRATION_ID } from '../../../src/cli/commands/integrate/copilot/declaration';
import { CURSOR_INTEGRATION_ID } from '../../../src/cli/commands/integrate/cursor/declaration';
import { CONTEXT_AUGMENTATION_BINARY_NAME } from '../../../src/lib/install-types';
import type {
  CliState,
  InstalledIntegrationDependency,
  InstalledIntegrationFeature,
} from '../../../src/lib/state';
import { getDefaultState } from '../../../src/lib/state';
import type { TestHarness } from '../../integration/harness';

export const STALE_CLI_VERSION = '0.0.1';
export const STALE_SKILL_VERSION = '0.0.0';
export const SEEDED_PROJECT_KEY = 'offline-test-project';
export const SEEDED_ORG_KEY = 'offline-test-org';
const SEEDED_UPDATED_AT = new Date(0).toISOString();

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
export const CODEX_SKILL_RELATIVE_PATH = join(
  '.agents',
  'skills',
  CONTEXT_AUGMENTATION_BINARY_NAME,
  'SKILL.md',
);
// Cursor delivers CAG as an always-applied `.cursor/rules` rule rather than a
// SKILL.md, so the rendered skill is wrapped in `.mdc` front-matter.
export const CURSOR_SKILL_RELATIVE_PATH = join(
  '.cursor',
  'rules',
  'sonar-context-augmentation.mdc',
);

export interface SeedSkillOptions {
  agentId: 'claude-code' | 'copilot-cli' | 'codex' | 'cursor';
  projectRoot: string;
  global?: boolean;
  version?: string;
  projectKey?: string;
  orgKey?: string;
}

export interface SeedStateOptions {
  cliVersion?: string;
  skills?: SeedSkillOptions[];
}

export function seedState(harness: TestHarness, options: SeedStateOptions = {}): void {
  mkdirSync(harness.cliHome.path, { recursive: true });
  const state = getDefaultState(options.cliVersion ?? STALE_CLI_VERSION);
  for (const skill of options.skills ?? []) {
    seedDeclarativeContextAugmentationFeature(state, skill);
  }
  writeFileSync(harness.stateJsonFile.path, JSON.stringify(state, null, 2), 'utf-8');
}

function seedDeclarativeContextAugmentationFeature(state: CliState, skill: SeedSkillOptions): void {
  if (skill.global) {
    return;
  }

  const integrationId = resolveIntegrationId(skill.agentId);
  let integration = state.integrations.installed.find(
    (entry) => entry.integrationId === integrationId,
  );
  if (!integration) {
    integration = {
      id: `e2e-integration-${randomUUID()}`,
      integrationId,
      installedByCliVersion: STALE_CLI_VERSION,
      installedAt: SEEDED_UPDATED_AT,
      updatedByCliVersion: STALE_CLI_VERSION,
      updatedAt: SEEDED_UPDATED_AT,
      features: [],
    };
    state.integrations.installed.push(integration);
  }

  integration.features.push({
    featureId: CONTEXT_AUGMENTATION_FEATURE_ID,
    scope: 'project',
    targetRoot: skill.projectRoot,
    installedByCliVersion: STALE_CLI_VERSION,
    installedAt: SEEDED_UPDATED_AT,
    updatedByCliVersion: STALE_CLI_VERSION,
    updatedAt: SEEDED_UPDATED_AT,
    dependencies: [{ id: CONTEXT_AUGMENTATION_BINARY_NAME }],
    resources: [
      {
        id: CONTEXT_AUGMENTATION_SKILL_RESOURCE_ID,
        resourceType: 'whole-file',
        version: skill.version ?? STALE_SKILL_VERSION,
        path: join(skill.projectRoot, resolveSkillRelativePath(skill.agentId)),
        updatedByCliVersion: STALE_CLI_VERSION,
        updatedAt: SEEDED_UPDATED_AT,
      },
    ],
    operations: [
      {
        id: CONTEXT_AUGMENTATION_TOOL_INTEGRATION_OPERATION_ID,
        updatedByCliVersion: STALE_CLI_VERSION,
        updatedAt: SEEDED_UPDATED_AT,
      },
    ],
    attrs: {
      orgKey: skill.orgKey ?? SEEDED_ORG_KEY,
      projectKey: skill.projectKey ?? SEEDED_PROJECT_KEY,
      serverUrl: 'https://sonarcloud.io',
      scaEnabled: false,
    },
  });
}

function resolveIntegrationId(agentId: SeedSkillOptions['agentId']): string {
  switch (agentId) {
    case 'claude-code':
      return CLAUDE_INTEGRATION_ID;
    case 'copilot-cli':
      return COPILOT_INTEGRATION_ID;
    case 'codex':
      return CODEX_INTEGRATION_ID;
    case 'cursor':
      return CURSOR_INTEGRATION_ID;
  }
}

function resolveSkillRelativePath(agentId: SeedSkillOptions['agentId']): string {
  switch (agentId) {
    case 'claude-code':
      return CLAUDE_SKILL_RELATIVE_PATH;
    case 'copilot-cli':
      return COPILOT_SKILL_RELATIVE_PATH;
    case 'codex':
      return CODEX_SKILL_RELATIVE_PATH;
    case 'cursor':
      return CURSOR_SKILL_RELATIVE_PATH;
  }
}

export interface RecordedCagFeature {
  integrationId: string;
  feature: InstalledIntegrationFeature;
}

export function findRecordedCagFeature(
  state: CliState,
  predicate?: (entry: RecordedCagFeature) => boolean,
): RecordedCagFeature | undefined {
  for (const integration of state.integrations.installed) {
    for (const feature of integration.features) {
      if (feature.featureId !== CONTEXT_AUGMENTATION_FEATURE_ID) {
        continue;
      }
      const entry = {
        integrationId: integration.integrationId,
        feature,
      };
      if (!predicate || predicate(entry)) {
        return entry;
      }
    }
  }
  return undefined;
}

export function findRecordedCagDependency(
  state: CliState,
): InstalledIntegrationDependency | undefined {
  return state.dependencies.installed.find(
    (dependency) => dependency.id === CONTEXT_AUGMENTATION_BINARY_NAME,
  );
}

const MIN_WRAPPER_INVOCATIONS_IN_SKILL = 5;

/**
 * The rendered SKILL.md must reference the wrapper command (`sonar context …`)
 * everywhere, with the raw `sonar-context-augmentation` binary name appearing
 * only once — in the YAML frontmatter `name:` field. Catches regressions where
 * `tool print-skill` is invoked without `--invocation-prefix "sonar context"`.
 */
export function expectSkillRendersWithWrapperInvocation(content: string): void {
  const matches = [...content.matchAll(new RegExp(CONTEXT_AUGMENTATION_BINARY_NAME, 'g'))];
  expect(
    matches.length,
    `expected exactly one '${CONTEXT_AUGMENTATION_BINARY_NAME}' mention (the skill name in frontmatter) in SKILL.md`,
  ).toBe(1);
  const wrapperInvocations = [...content.matchAll(/\bsonar context\b/g)];
  expect(
    wrapperInvocations.length,
    `expected more than ${MIN_WRAPPER_INVOCATIONS_IN_SKILL} \`sonar context\` command examples in SKILL.md`,
  ).toBeGreaterThan(MIN_WRAPPER_INVOCATIONS_IN_SKILL);
}
