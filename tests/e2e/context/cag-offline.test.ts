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
 * tar extraction and `tool install-skill` rendering — without touching
 * SonarQube/Cloud. Only network reach is `binaries.sonarsource.com` for
 * the archive and detached signature.
 *
 * Trigger path: pre-seed `state.json` so CAG looks "previously installed"
 * with a stale-version skill entry + a stale `config.cliVersion`. The next
 * `sonar` invocation runs `runPostUpdateActions()` which calls
 * `updateContextAugmentationIfNeeded()` — that path explicitly does not
 * run `cag init` and does not need auth.
 */

import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';

import { buildLocalCagBinaryName } from '../../../src/cli/commands/_common/install/context-augmentation';
import { CONTEXT_AUGMENTATION_BINARY_NAME } from '../../../src/lib/install-types';
import { detectPlatform } from '../../../src/lib/platform-detector';
import { SONAR_CONTEXT_AUGMENTATION_VERSION } from '../../../src/lib/signatures';
import type { CliState, SkillExtension } from '../../../src/lib/state';
import { getDefaultState } from '../../../src/lib/state';
import { TestHarness } from '../../integration/harness';

const DEFAULT_TIMEOUT_MS = 180_000;
const POST_UPDATE_TIMEOUT_MS = 150_000;
const HELP_TIMEOUT_MS = 30_000;

setDefaultTimeout(DEFAULT_TIMEOUT_MS);

const STALE_CLI_VERSION = '0.0.1';
const STALE_SKILL_VERSION = '0.0.0';
const SEEDED_PROJECT_KEY = 'offline-test-project';
const SEEDED_ORG_KEY = 'offline-test-org';

describe('sonar-context-augmentation offline e2e (real binary, no SonarQube)', () => {
  let harness: TestHarness;
  let cagBinaryPath: string;
  let postUpdateResult: { exitCode: number; stdout: string; stderr: string };

  beforeAll(async () => {
    harness = await TestHarness.create();
    mkdirSync(harness.cwd.path, { recursive: true });
    mkdirSync(harness.cliHome.path, { recursive: true });

    cagBinaryPath = join(harness.cliHome.path, 'bin', buildLocalCagBinaryName(detectPlatform()));

    seedStaleState(harness);

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

  it('refreshes the recorded skill version to the pinned CAG version', () => {
    const state = harness.stateJsonFile.asJson() as CliState;
    const skill = findRecordedCagSkill(state);
    expect(skill, 'expected a recorded CAG skill in state.json').toBeDefined();
    expect(skill!.version).toBe(SONAR_CONTEXT_AUGMENTATION_VERSION);
    expect(skill!.updatedAt > new Date(0).toISOString()).toBe(true);
  });

  it('forwards `sonar context --help` to the real binary without requiring auth', async () => {
    const result = await harness.run('context --help', { timeoutMs: HELP_TIMEOUT_MS });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout.length + result.stderr.length).toBeGreaterThan(0);
  });
});

function seedStaleState(harness: TestHarness): void {
  const state = getDefaultState(STALE_CLI_VERSION);
  state.telemetry.enabled = false;

  const skill: SkillExtension = {
    id: 'offline-e2e-skill',
    kind: 'skill',
    agentId: 'claude-code',
    projectRoot: harness.cwd.path,
    global: false,
    projectKey: SEEDED_PROJECT_KEY,
    orgKey: SEEDED_ORG_KEY,
    serverUrl: 'https://sonarcloud.io',
    updatedByCliVersion: STALE_CLI_VERSION,
    updatedAt: new Date(0).toISOString(),
    name: CONTEXT_AUGMENTATION_BINARY_NAME,
    version: STALE_SKILL_VERSION,
    scaEnabled: false,
  };
  state.agentExtensions.push(skill);

  writeFileSync(harness.stateJsonFile.path, JSON.stringify(state, null, 2), 'utf-8');
}

function findRecordedCagSkill(state: CliState): SkillExtension | undefined {
  return state.agentExtensions.find(
    (extension): extension is SkillExtension =>
      extension.kind === 'skill' && extension.name === CONTEXT_AUGMENTATION_BINARY_NAME,
  );
}
