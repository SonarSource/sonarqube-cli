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
 * Offline e2e proving the post-update path refreshes a recorded `copilot-cli`
 * skill (writes `.github/skills/...` rather than `.claude/skills/...`).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';

import { CONTEXT_AUGMENTATION_BINARY_NAME } from '../../../src/lib/install-types';
import { SONAR_CONTEXT_AUGMENTATION_VERSION } from '../../../src/lib/signatures';
import type { CliState } from '../../../src/lib/state';
import { TestHarness } from '../../integration/harness';
import {
  COPILOT_SKILL_RELATIVE_PATH,
  findRecordedCagSkill,
  seedState,
  STALE_CLI_VERSION,
} from './_helpers';

const DEFAULT_TIMEOUT_MS = 180_000;
const POST_UPDATE_TIMEOUT_MS = 150_000;

setDefaultTimeout(DEFAULT_TIMEOUT_MS);

const STALE_SKILL_SENTINEL = '<<stale-copilot-skill-placeholder-cag-copilot-e2e>>';

describe('sonar-context-augmentation copilot skill refresh (offline, real binary)', () => {
  let harness: TestHarness;
  let copilotSkillPath: string;

  beforeAll(async () => {
    harness = await TestHarness.create();
    mkdirSync(harness.cwd.path, { recursive: true });
    seedState(harness, {
      skills: [{ agentId: 'copilot-cli', projectRoot: harness.cwd.path }],
    });
    copilotSkillPath = join(harness.cwd.path, COPILOT_SKILL_RELATIVE_PATH);

    // Pre-write a sentinel into the skill file so the refresh has to overwrite
    // it — proves the post-update path actually invoked `tool install-skill`
    // rather than the file existing as a side effect of something else.
    mkdirSync(dirname(copilotSkillPath), { recursive: true });
    writeFileSync(copilotSkillPath, STALE_SKILL_SENTINEL, 'utf-8');

    const result = await harness.run('--version', { timeoutMs: POST_UPDATE_TIMEOUT_MS });
    expect(result.exitCode, result.stderr).toBe(0);
  });

  afterAll(async () => {
    await harness.dispose();
  });

  it('overwrites the stale copilot SKILL.md with refreshed content under .github/skills/...', () => {
    expect(existsSync(copilotSkillPath)).toBe(true);
    const content = readFileSync(copilotSkillPath, 'utf-8');
    expect(content).not.toContain(STALE_SKILL_SENTINEL);
    expect(content).toContain(CONTEXT_AUGMENTATION_BINARY_NAME);
  });

  it('refreshes the recorded copilot-cli skill version and bumps cliVersion', () => {
    const state = harness.stateJsonFile.asJson() as CliState;
    expect(state.config.cliVersion).not.toBe(STALE_CLI_VERSION);
    const skill = findRecordedCagSkill(state, (s) => s.agentId === 'copilot-cli');
    expect(skill?.version).toBe(SONAR_CONTEXT_AUGMENTATION_VERSION);
  });
});
