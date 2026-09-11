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
 * Offline e2e proving the post-update path migrates a recorded `codex` CAG
 * install from the retired skill file to the session-start hook.
 */

import { existsSync, mkdirSync } from 'node:fs';

import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';

import { CODEX_INTEGRATION_ID } from '@/commands/integrate/codex/declaration.ts';
import { SONAR_CONTEXT_AUGMENTATION_VERSION } from '@/core/host/install/signatures.ts';
import type { CliState } from '@/core/state/state.ts';

import { TestHarness } from '../../integration/harness';
import {
  expectSessionStartHookRefreshed,
  findRecordedCagDependency,
  findRecordedCagFeature,
  findRecordedCagSkillResource,
  findRecordedSessionStartScriptResource,
  seedLegacySkillFile,
  seedState,
  sessionStartScriptPath,
  STALE_CLI_VERSION,
} from './_helpers';

const DEFAULT_TIMEOUT_MS = 180_000;
const POST_UPDATE_TIMEOUT_MS = 150_000;

setDefaultTimeout(DEFAULT_TIMEOUT_MS);

describe('sonar-context-augmentation codex hook refresh (offline, real binary)', () => {
  let harness: TestHarness;
  let codexSkillPath: string;

  beforeAll(async () => {
    harness = await TestHarness.create();
    mkdirSync(harness.cwd.path, { recursive: true });
    seedState(harness, {
      skills: [{ agentId: 'codex', projectRoot: harness.cwd.path }],
    });
    codexSkillPath = seedLegacySkillFile(harness.cwd.path, 'codex', '# stale skill\n');

    const result = await harness.run('--version', { timeoutMs: POST_UPDATE_TIMEOUT_MS });
    expect(result.exitCode, result.stderr).toBe(0);
  });

  afterAll(async () => {
    await harness.dispose();
  });

  it('deletes the retired skill and installs the session-start hook', () => {
    expect(existsSync(codexSkillPath)).toBe(false);
    expectSessionStartHookRefreshed(harness.cwd.path, 'codex');
  });

  it('refreshes the declarative codex CAG state and bumps cliVersion', () => {
    const state = harness.stateJsonFile.asJson() as CliState;
    expect(state.config.cliVersion).not.toBe(STALE_CLI_VERSION);
    expect(findRecordedCagDependency(state)?.version).toBe(SONAR_CONTEXT_AUGMENTATION_VERSION);

    const feature = findRecordedCagFeature(
      state,
      ({ integrationId, feature: installedFeature }) =>
        integrationId === CODEX_INTEGRATION_ID && installedFeature.targetRoot === harness.cwd.path,
    );
    expect(feature).toBeDefined();
    if (!feature) {
      throw new Error('Expected a recorded declarative Codex CAG feature');
    }
    expect(findRecordedSessionStartScriptResource(feature)?.path).toBe(
      sessionStartScriptPath(harness.cwd.path, 'codex'),
    );
    expect(findRecordedCagSkillResource(feature)).toBeUndefined();
  });
});
