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
} from '@/commands/integrate/_common/features/context-augmentation-feature.ts';
import { VORTEX_FEATURE_ID } from '@/commands/integrate/_common/vortex.ts';
import { ANTIGRAVITY_INTEGRATION_ID } from '@/commands/integrate/antigravity/declaration.ts';
import { CLAUDE_INTEGRATION_ID } from '@/commands/integrate/claude/declaration.ts';
import { CODEX_INTEGRATION_ID } from '@/commands/integrate/codex/declaration.ts';
import { COPILOT_INTEGRATION_ID } from '@/commands/integrate/copilot/declaration.ts';
import { CURSOR_INTEGRATION_ID } from '@/commands/integrate/cursor/declaration.ts';
import { CONTEXT_AUGMENTATION_BINARY_NAME } from '@/core/host/install-types.ts';
import type {
  CliState,
  InstalledIntegrationDependency,
  InstalledIntegrationFeature,
  InstalledIntegrationResource,
  InstalledSubfeature,
} from '@/core/state/state.ts';
import { getDefaultState } from '@/core/state/state.ts';

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
// Cursor reads skills from the shared `.agents/skills` directory (like Codex and
// Antigravity), so CAG is written there — one skill shared across those tools,
// not a duplicate Cursor-private copy.
export const CURSOR_SKILL_RELATIVE_PATH = join(
  '.agents',
  'skills',
  CONTEXT_AUGMENTATION_BINARY_NAME,
  'SKILL.md',
);
// Antigravity also reads from the shared `.agents/skills` directory.
export const ANTIGRAVITY_SKILL_RELATIVE_PATH = join(
  '.agents',
  'skills',
  CONTEXT_AUGMENTATION_BINARY_NAME,
  'SKILL.md',
);

export interface SeedSkillOptions {
  agentId: 'claude-code' | 'copilot-cli' | 'codex' | 'cursor' | 'antigravity';
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

  const resource = {
    id: CONTEXT_AUGMENTATION_SKILL_RESOURCE_ID,
    resourceType: 'whole-file' as const,
    version: skill.version ?? STALE_SKILL_VERSION,
    path: join(skill.projectRoot, resolveSkillRelativePath(skill.agentId)),
    updatedByCliVersion: STALE_CLI_VERSION,
    updatedAt: SEEDED_UPDATED_AT,
  };
  const operation = {
    id: CONTEXT_AUGMENTATION_TOOL_INTEGRATION_OPERATION_ID,
    updatedByCliVersion: STALE_CLI_VERSION,
    updatedAt: SEEDED_UPDATED_AT,
  };
  const attrs = {
    orgKey: skill.orgKey ?? SEEDED_ORG_KEY,
    projectKey: skill.projectKey ?? SEEDED_PROJECT_KEY,
    serverUrl: 'https://sonarcloud.io',
    scaEnabled: false,
  };

  const feature: InstalledIntegrationFeature = {
    featureId: VORTEX_FEATURE_ID,
    scope: 'project',
    targetRoot: skill.projectRoot,
    installedByCliVersion: STALE_CLI_VERSION,
    installedAt: SEEDED_UPDATED_AT,
    updatedByCliVersion: STALE_CLI_VERSION,
    updatedAt: SEEDED_UPDATED_AT,
    dependencies: [],
    resources: [],
    operations: [],
    attrs,
    subfeatures: [
      {
        featureId: CONTEXT_AUGMENTATION_FEATURE_ID,
        dependencies: [{ id: CONTEXT_AUGMENTATION_BINARY_NAME }],
        resources: [resource],
        operations: [operation],
      },
    ],
  };
  integration.features.push(feature);
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
    case 'antigravity':
      return ANTIGRAVITY_INTEGRATION_ID;
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
    case 'antigravity':
      return ANTIGRAVITY_SKILL_RELATIVE_PATH;
  }
}

export interface RecordedCagFeature {
  integrationId: string;
  feature: InstalledIntegrationFeature;
}

function findCagSubfeature(feature: InstalledIntegrationFeature): InstalledSubfeature | undefined {
  return feature.subfeatures?.find(
    (subfeature) => subfeature.featureId === CONTEXT_AUGMENTATION_FEATURE_ID,
  );
}

export function findRecordedCagFeature(
  state: CliState,
  predicate?: (entry: RecordedCagFeature) => boolean,
): RecordedCagFeature | undefined {
  for (const integration of state.integrations.installed) {
    for (const feature of integration.features) {
      const cagSubfeature = findCagSubfeature(feature);
      if (feature.featureId !== VORTEX_FEATURE_ID || !cagSubfeature) {
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

export function findRecordedCagSkillResource(
  entry: RecordedCagFeature,
): InstalledIntegrationResource | undefined {
  return findCagSubfeature(entry.feature)?.resources?.find(
    (resource) => resource.id === CONTEXT_AUGMENTATION_SKILL_RESOURCE_ID,
  );
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
