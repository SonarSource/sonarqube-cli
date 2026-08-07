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

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';

import { OPENCODE_INTEGRATION_ID } from '@/commands/integrate/opencode/declaration.ts';
import { SONAR_CONTEXT_AUGMENTATION_VERSION } from '@/core/host/install/signatures.ts';
import type { CliState } from '@/core/state/state.ts';

import { TestHarness } from '../../integration/harness';
import {
  expectSkillRendersWithWrapperInvocation,
  findRecordedCagDependency,
  findRecordedCagFeature,
  findRecordedCagSkillResource,
  OPENCODE_SKILL_RELATIVE_PATH,
  seedState,
  STALE_CLI_VERSION,
} from './_helpers';

const DEFAULT_TIMEOUT_MS = 180_000;
const POST_UPDATE_TIMEOUT_MS = 150_000;

setDefaultTimeout(DEFAULT_TIMEOUT_MS);

const STALE_SKILL_SENTINEL = '<<stale-opencode-skill-placeholder-cag-opencode-e2e>>';

describe('sonar-context-augmentation OpenCode skill refresh (offline, real binary)', () => {
  let harness: TestHarness;
  let openCodeSkillPath: string;

  beforeAll(async () => {
    harness = await TestHarness.create();
    mkdirSync(harness.cwd.path, { recursive: true });
    seedState(harness, {
      skills: [{ agentId: 'opencode', projectRoot: harness.cwd.path }],
    });
    openCodeSkillPath = join(harness.cwd.path, OPENCODE_SKILL_RELATIVE_PATH);

    mkdirSync(dirname(openCodeSkillPath), { recursive: true });
    writeFileSync(openCodeSkillPath, STALE_SKILL_SENTINEL, 'utf-8');

    const result = await harness.run('--version', { timeoutMs: POST_UPDATE_TIMEOUT_MS });
    expect(result.exitCode, result.stderr).toBe(0);
  });

  afterAll(async () => {
    await harness.dispose();
  });

  it('overwrites the stale OpenCode SKILL.md under .opencode/skills/...', () => {
    expect(existsSync(openCodeSkillPath)).toBe(true);
    const content = readFileSync(openCodeSkillPath, 'utf-8');
    expect(content).not.toContain(STALE_SKILL_SENTINEL);
    expectSkillRendersWithWrapperInvocation(content);
  });

  it('refreshes the declarative OpenCode CAG state and bumps cliVersion', () => {
    const state = harness.stateJsonFile.asJson() as CliState;
    expect(state.config.cliVersion).not.toBe(STALE_CLI_VERSION);
    expect(findRecordedCagDependency(state)?.version).toBe(SONAR_CONTEXT_AUGMENTATION_VERSION);

    const feature = findRecordedCagFeature(
      state,
      ({ integrationId, feature: installedFeature }) =>
        integrationId === OPENCODE_INTEGRATION_ID &&
        installedFeature.targetRoot === harness.cwd.path,
    );
    expect(feature).toBeDefined();
    if (!feature) {
      throw new Error('Expected a recorded declarative OpenCode CAG feature');
    }
    const resource = findRecordedCagSkillResource(feature);
    expect(resource).toBeDefined();
    expect(resource?.version).toBe(SONAR_CONTEXT_AUGMENTATION_VERSION);
    expect(resource?.path).toBe(openCodeSkillPath);
  });
});
