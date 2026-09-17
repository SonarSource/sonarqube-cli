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
 * Production-CDN smoke for sonar-context-augmentation.
 *
 * Seeds a stale declarative CAG feature so `runPostUpdateActions()` downloads
 * the real archive from `binaries.sonarsource.com`, PGP-verifies it, and
 * extracts the binary. Declarative skill→hook refresh is covered by
 * integration tests against the CAG stub / fake binaries server.
 */

import { existsSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';

import { detectPlatform } from '@/core/host/environment/platform-detector.ts';
import { buildLocalCagBinaryName } from '@/core/host/install/context-augmentation.ts';
import { SONAR_CONTEXT_AUGMENTATION_VERSION } from '@/core/host/install/signatures.ts';
import type { CliState } from '@/core/state/state.ts';

import { POST_UPDATE_TRIGGER_COMMAND } from '../../_common/isolated-cli-env.js';
import { TestHarness } from '../../integration/harness';
import { findRecordedCagDependency, seedState, STALE_CLI_VERSION } from './_helpers';

const DEFAULT_TIMEOUT_MS = 180_000;
const PRODUCTION_CDN_DOWNLOAD_TIMEOUT_MS = 150_000;
const HELP_TIMEOUT_MS = 30_000;

setDefaultTimeout(DEFAULT_TIMEOUT_MS);

describe('sonar-context-augmentation production CDN smoke (real binary, no SonarQube)', () => {
  let harness: TestHarness;
  let cagBinaryPath: string;
  let postUpdateResult: { exitCode: number; stdout: string; stderr: string };

  beforeAll(async () => {
    harness = await TestHarness.create();
    mkdirSync(harness.cwd.path, { recursive: true });
    mkdirSync(harness.cliHome.path, { recursive: true });

    cagBinaryPath = join(harness.cliHome.path, 'bin', buildLocalCagBinaryName(detectPlatform()));

    seedState(harness, {
      skills: [{ agentId: 'claude', projectRoot: harness.cwd.path }],
    });

    postUpdateResult = await harness.run(POST_UPDATE_TRIGGER_COMMAND, {
      timeoutMs: PRODUCTION_CDN_DOWNLOAD_TIMEOUT_MS,
    });
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

  it('records the installed CAG dependency and bumps cliVersion', () => {
    const state = harness.stateJsonFile.asJson() as CliState;
    expect(state.config.cliVersion).not.toBe(STALE_CLI_VERSION);
    expect(findRecordedCagDependency(state)?.version).toBe(SONAR_CONTEXT_AUGMENTATION_VERSION);
  });

  it('forwards `sonar context --help` to the real binary without requiring auth', async () => {
    const result = await harness.run('context --help', { timeoutMs: HELP_TIMEOUT_MS });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout.length + result.stderr.length).toBeGreaterThan(0);
  });
});
