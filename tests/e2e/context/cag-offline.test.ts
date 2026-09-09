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
 * tar extraction, and declarative resource refresh — without touching
 * SonarQube/Cloud. Only network reach is `binaries.sonarsource.com` for
 * the archive and detached signature; post-update refreshes the declarative
 * resources but does not rerun `tool integrate`.
 *
 * Trigger path: pre-seed `state.json` with a stale declarative CAG feature and
 * a stale `config.cliVersion`. The next `sonar` invocation runs
 * `runPostUpdateActions()` which reconciles declarative integrations, so an
 * older install recorded against the retired skill resource is migrated to the
 * session-start hook.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';

import { CLAUDE_INTEGRATION_ID } from '@/commands/integrate/claude/declaration.ts';
import { detectPlatform } from '@/core/host/environment/platform-detector.ts';
import { buildLocalCagBinaryName } from '@/core/host/install/context-augmentation.ts';
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
const HELP_TIMEOUT_MS = 30_000;

setDefaultTimeout(DEFAULT_TIMEOUT_MS);

describe('sonar-context-augmentation offline e2e (real binary, no SonarQube)', () => {
  let harness: TestHarness;
  let cagBinaryPath: string;
  let seededSkillPath: string;
  let postUpdateResult: { exitCode: number; stdout: string; stderr: string };

  beforeAll(async () => {
    harness = await TestHarness.create();
    mkdirSync(harness.cwd.path, { recursive: true });
    mkdirSync(harness.cliHome.path, { recursive: true });

    cagBinaryPath = join(harness.cliHome.path, 'bin', buildLocalCagBinaryName(detectPlatform()));

    seedState(harness, {
      skills: [{ agentId: 'claude', projectRoot: harness.cwd.path }],
    });

    seededSkillPath = seedLegacySkillFile(harness.cwd.path, 'claude', '# stale skill\n');

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

  it('refreshes the declarative CAG dependency and migrates the recorded resource', () => {
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
    expect(findRecordedSessionStartScriptResource(feature)?.path).toBe(
      sessionStartScriptPath(harness.cwd.path, 'claude'),
    );
    expect(findRecordedCagSkillResource(feature)).toBeUndefined();
  });

  it('forwards `sonar context --help` to the real binary without requiring auth', async () => {
    const result = await harness.run('context --help', { timeoutMs: HELP_TIMEOUT_MS });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout.length + result.stderr.length).toBeGreaterThan(0);
  });

  it('deletes the retired agent SKILL.md and installs the session-start hook', () => {
    expect(existsSync(seededSkillPath)).toBe(false);
    expectSessionStartHookRefreshed(harness.cwd.path, 'claude');
  });

  describe('a second self-update (rewound state) reinstalls the hook script', () => {
    let refreshResult: { exitCode: number; stdout: string; stderr: string };
    let scriptPath: string;
    let preMutationContent: string;

    beforeAll(async () => {
      scriptPath = sessionStartScriptPath(harness.cwd.path, 'claude');
      preMutationContent = readFileSync(scriptPath, 'utf-8');

      // Simulate a fresh CLI upgrade landing on the same machine: rewind the
      // persisted CLI version so `runPostUpdateActions()` fires again.
      const state = harness.stateJsonFile.asJson() as CliState;
      state.config.cliVersion = STALE_CLI_VERSION;
      writeFileSync(harness.stateJsonFile.path, JSON.stringify(state, null, 2), 'utf-8');

      // Delete the hook script so the rerun has to write it again — proves
      // the refresh re-applied the declarative resource rather than only
      // bumping state.
      rmSync(scriptPath);

      refreshResult = await harness.run('--version', { timeoutMs: POST_UPDATE_TIMEOUT_MS });
    });

    it('the simulated self-update exits successfully', () => {
      expect(refreshResult.exitCode, refreshResult.stderr).toBe(0);
    });

    it('recreates the hook script that was deleted before the rerun', () => {
      expect(existsSync(scriptPath)).toBe(true);
      const restored = readFileSync(scriptPath, 'utf-8');
      expect(restored).toEqual(preMutationContent);
    });

    it('re-bumps state.config.cliVersion past the rewound stale value', () => {
      const state = harness.stateJsonFile.asJson() as CliState;
      expect(state.config.cliVersion).not.toBe(STALE_CLI_VERSION);
    });
  });
});
