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
 * Offline e2e for sonar-context-augmentation.
 *
 * Exercises the *real* CAG binary download, PGP signature verification,
 * tar extraction, and declarative skill refresh — without touching
 * SonarQube/Cloud. Only network reach is `binaries.sonarsource.com` for
 * the archive and detached signature; post-update refreshes the declarative
 * skill file but does not rerun `tool integrate`.
 *
 * Trigger path: pre-seed `state.json` with a stale declarative CAG feature and
 * a stale `config.cliVersion`. The next `sonar` invocation runs
 * `runPostUpdateActions()` which reconciles declarative integrations and
 * refreshes the recorded CAG features.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';

import { buildLocalCagBinaryName } from '../../../src/cli/commands/_common/install/context-augmentation';
import { CLAUDE_INTEGRATION_ID } from '../../../src/cli/commands/integrate/claude/declaration';
import { CONTEXT_AUGMENTATION_BINARY_NAME } from '../../../src/lib/install-types';
import { detectPlatform } from '../../../src/lib/platform-detector';
import { SONAR_CONTEXT_AUGMENTATION_VERSION } from '../../../src/lib/signatures';
import type { CliState } from '../../../src/lib/state';
import { TestHarness } from '../../integration/harness';
import {
  CLAUDE_SKILL_RELATIVE_PATH,
  findRecordedCagDependency,
  findRecordedCagFeature,
  seedState,
  STALE_CLI_VERSION,
} from './_helpers';

const DEFAULT_TIMEOUT_MS = 180_000;
const POST_UPDATE_TIMEOUT_MS = 150_000;
const HELP_TIMEOUT_MS = 30_000;

setDefaultTimeout(DEFAULT_TIMEOUT_MS);

const STALE_SKILL_SENTINEL = '<<stale-claude-skill-placeholder-cag-offline-e2e>>';

describe('sonar-context-augmentation offline e2e (real binary, no SonarQube)', () => {
  let harness: TestHarness;
  let cagBinaryPath: string;
  let postUpdateResult: { exitCode: number; stdout: string; stderr: string };

  beforeAll(async () => {
    harness = await TestHarness.create();
    mkdirSync(harness.cwd.path, { recursive: true });
    mkdirSync(harness.cliHome.path, { recursive: true });

    cagBinaryPath = join(harness.cliHome.path, 'bin', buildLocalCagBinaryName(detectPlatform()));

    seedState(harness, {
      skills: [{ agentId: 'claude-code', projectRoot: harness.cwd.path }],
    });

    // Pre-write a sentinel into the skill file so the refresh has to overwrite
    // it — proves the post-update path actually re-rendered the declarative
    // skill file rather than the file existing as a side effect of something else.
    const seededSkillPath = join(harness.cwd.path, CLAUDE_SKILL_RELATIVE_PATH);
    mkdirSync(dirname(seededSkillPath), { recursive: true });
    writeFileSync(seededSkillPath, STALE_SKILL_SENTINEL, 'utf-8');

    postUpdateResult = await harness.run('--version', { timeoutMs: POST_UPDATE_TIMEOUT_MS });
  });

  afterAll(async () => {
    await harness.dispose();
  });

  it('post-update completes successfully', () => {
    expect(postUpdateResult.exitCode, postUpdateResult.stderr).toBe(0);
  });

  it('downloads, verifies and extracts the real CAG binary to the expected versioned path', () => {
    expect(existsSync(cagBinaryPath)).toBe(true);
    if (process.platform !== 'win32') {
      const mode = statSync(cagBinaryPath).mode & 0o777;
      expect(mode & 0o100).toBeGreaterThan(0);
    }
  });

  it('the downloaded binary reports the pinned CAG version', () => {
    const probe = Bun.spawnSync([cagBinaryPath, '--version'], { stdout: 'pipe', stderr: 'pipe' });
    const stdout = new TextDecoder().decode(probe.stdout);
    const stderr = new TextDecoder().decode(probe.stderr);
    expect(probe.exitCode, `--version stderr:\n${stderr}`).toBe(0);
    const [major, minor, patch, build] = SONAR_CONTEXT_AUGMENTATION_VERSION.split('.');
    expect(stdout).toContain(`${major}.${minor}.${patch}`);
    expect(stdout).toContain(build);
  });

  it('bumps state.config.cliVersion past the seeded stale value', () => {
    const state = harness.stateJsonFile.asJson() as CliState;
    expect(state.config.cliVersion).not.toBe(STALE_CLI_VERSION);
  });

  it('refreshes the declarative CAG dependency and skill resource to the pinned version', () => {
    const state = harness.stateJsonFile.asJson() as CliState;
    expect(findRecordedCagDependency(state)?.version).toBe(SONAR_CONTEXT_AUGMENTATION_VERSION);

    const feature = findRecordedCagFeature(
      state,
      ({ integrationId, feature: installedFeature }) =>
        integrationId === CLAUDE_INTEGRATION_ID && installedFeature.targetRoot === harness.cwd.path,
    );
    expect(feature, 'expected a recorded declarative CAG feature in state.json').toBeDefined();
    if (!feature) {
      throw new Error('Expected a recorded declarative Claude CAG feature');
    }
    const resource = feature.feature.resources.find(
      (entry) => entry.id === 'context-augmentation-skill-file',
    );
    expect(resource).toBeDefined();
    expect(resource?.version).toBe(SONAR_CONTEXT_AUGMENTATION_VERSION);
    expect(resource?.path).toBe(join(harness.cwd.path, CLAUDE_SKILL_RELATIVE_PATH));
  });

  it('forwards `sonar context --help` to the real binary without requiring auth', async () => {
    const result = await harness.run('context --help', { timeoutMs: HELP_TIMEOUT_MS });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout.length + result.stderr.length).toBeGreaterThan(0);
  });

  it('overwrites the stale agent SKILL.md with refreshed content', () => {
    const skillPath = join(harness.cwd.path, CLAUDE_SKILL_RELATIVE_PATH);
    expect(existsSync(skillPath)).toBe(true);
    const content = readFileSync(skillPath, 'utf-8');
    expect(content).not.toContain(STALE_SKILL_SENTINEL);
    expect(content).toContain(CONTEXT_AUGMENTATION_BINARY_NAME);
  });

  describe('a second self-update (rewound state) reinstalls the skill', () => {
    let refreshResult: { exitCode: number; stdout: string; stderr: string };
    let skillPath: string;
    let preMutationContent: string;

    beforeAll(async () => {
      skillPath = join(harness.cwd.path, CLAUDE_SKILL_RELATIVE_PATH);
      preMutationContent = readFileSync(skillPath, 'utf-8');

      // Simulate a fresh CLI upgrade landing on the same machine: rewind the
      // persisted CLI version so `runPostUpdateActions()` fires again.
      const state = harness.stateJsonFile.asJson() as CliState;
      state.config.cliVersion = STALE_CLI_VERSION;
      writeFileSync(harness.stateJsonFile.path, JSON.stringify(state, null, 2), 'utf-8');

      // Delete the rendered skill so the rerun has to write it again — proves
      // the refresh re-applied the declarative resource rather than only
      // bumping state.
      rmSync(skillPath);

      refreshResult = await harness.run('--version', { timeoutMs: POST_UPDATE_TIMEOUT_MS });
    });

    it('the simulated self-update exits successfully', () => {
      expect(refreshResult.exitCode, refreshResult.stderr).toBe(0);
    });

    it('recreates the SKILL.md that was deleted before the rerun', () => {
      expect(existsSync(skillPath)).toBe(true);
      const restored = readFileSync(skillPath, 'utf-8');
      expect(restored).toEqual(preMutationContent);
    });

    it('re-bumps state.config.cliVersion past the rewound stale value', () => {
      const state = harness.stateJsonFile.asJson() as CliState;
      expect(state.config.cliVersion).not.toBe(STALE_CLI_VERSION);
    });

    it('re-records the pinned declarative CAG state', () => {
      const state = harness.stateJsonFile.asJson() as CliState;
      expect(findRecordedCagDependency(state)?.version).toBe(SONAR_CONTEXT_AUGMENTATION_VERSION);
      const feature = findRecordedCagFeature(
        state,
        ({ integrationId, feature: installedFeature }) =>
          integrationId === CLAUDE_INTEGRATION_ID &&
          installedFeature.targetRoot === harness.cwd.path,
      );
      expect(feature).toBeDefined();
      if (!feature) {
        throw new Error('Expected a recorded declarative Claude CAG feature after rerun');
      }
      const resource = feature.feature.resources.find(
        (entry) => entry.id === 'context-augmentation-skill-file',
      );
      expect(resource).toBeDefined();
      expect(resource?.version).toBe(SONAR_CONTEXT_AUGMENTATION_VERSION);
      expect(resource?.path).toBe(skillPath);
    });
  });
});
