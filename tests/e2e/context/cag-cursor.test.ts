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

/**
 * Offline e2e proving the post-update path refreshes a recorded `cursor` CAG
 * rule. Unlike the SKILL.md agents, Cursor writes the rendered skill to
 * `.cursor/rules/sonar-context-augmentation.mdc` wrapped in `alwaysApply: true`
 * front-matter, so this asserts both the path and the wrapping (real binary).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';

import { CURSOR_INTEGRATION_ID } from '../../../src/cli/commands/integrate/cursor/declaration';
import { SONAR_CONTEXT_AUGMENTATION_VERSION } from '../../../src/lib/signatures';
import type { CliState } from '../../../src/lib/state';
import { TestHarness } from '../../integration/harness';
import {
  CURSOR_SKILL_RELATIVE_PATH,
  expectSkillRendersWithWrapperInvocation,
  findRecordedCagDependency,
  findRecordedCagFeature,
  seedState,
  STALE_CLI_VERSION,
} from './_helpers';

const DEFAULT_TIMEOUT_MS = 180_000;
const POST_UPDATE_TIMEOUT_MS = 150_000;

setDefaultTimeout(DEFAULT_TIMEOUT_MS);

const STALE_SKILL_SENTINEL = '<<stale-cursor-rule-placeholder-cag-cursor-e2e>>';

describe('sonar-context-augmentation cursor rule refresh (offline, real binary)', () => {
  let harness: TestHarness;
  let cursorRulePath: string;

  beforeAll(async () => {
    harness = await TestHarness.create();
    mkdirSync(harness.cwd.path, { recursive: true });
    seedState(harness, {
      skills: [{ agentId: 'cursor', projectRoot: harness.cwd.path }],
    });
    cursorRulePath = join(harness.cwd.path, CURSOR_SKILL_RELATIVE_PATH);

    // Pre-write a sentinel so the refresh has to overwrite it — proves the
    // post-update path actually re-rendered the declarative rule.
    mkdirSync(dirname(cursorRulePath), { recursive: true });
    writeFileSync(cursorRulePath, STALE_SKILL_SENTINEL, 'utf-8');

    const result = await harness.run('--version', { timeoutMs: POST_UPDATE_TIMEOUT_MS });
    expect(result.exitCode, result.stderr).toBe(0);
  });

  afterAll(async () => {
    await harness.dispose();
  });

  it('overwrites the stale rule with refreshed content under .cursor/rules/, wrapped in alwaysApply front-matter', () => {
    expect(existsSync(cursorRulePath)).toBe(true);
    const content = readFileSync(cursorRulePath, 'utf-8');
    expect(content).not.toContain(STALE_SKILL_SENTINEL);
    // Cursor injects the rule into every session via the front-matter.
    expect(content.startsWith('---\nalwaysApply: true\n---')).toBe(true);
    // The wrapped body is still the real rendered skill.
    expectSkillRendersWithWrapperInvocation(content);
  });

  it('refreshes the declarative cursor CAG state and bumps cliVersion', () => {
    const state = harness.stateJsonFile.asJson() as CliState;
    expect(state.config.cliVersion).not.toBe(STALE_CLI_VERSION);
    expect(findRecordedCagDependency(state)?.version).toBe(SONAR_CONTEXT_AUGMENTATION_VERSION);

    const feature = findRecordedCagFeature(
      state,
      ({ integrationId, feature: installedFeature }) =>
        integrationId === CURSOR_INTEGRATION_ID && installedFeature.targetRoot === harness.cwd.path,
    );
    expect(feature).toBeDefined();
    if (!feature) {
      throw new Error('Expected a recorded declarative Cursor CAG feature');
    }
    const resource = feature.feature.resources.find(
      (entry) => entry.id === 'context-augmentation-skill-file',
    );
    expect(resource).toBeDefined();
    expect(resource?.version).toBe(SONAR_CONTEXT_AUGMENTATION_VERSION);
    expect(resource?.path).toBe(cursorRulePath);
  });
});
