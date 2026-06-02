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
 * Offline e2e for `sonar context` passthrough behaviors against the real
 * CAG binary: unauthenticated-action error path, bare-invocation falls
 * through to CAG's help, and child exit-code propagation.
 */

import { mkdirSync } from 'node:fs';

import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';

import { TestHarness } from '../../integration/harness';
import { SEEDED_ORG_KEY, seedState } from './_helpers';

const DEFAULT_TIMEOUT_MS = 180_000;
const POST_UPDATE_TIMEOUT_MS = 150_000;
const PASSTHROUGH_TIMEOUT_MS = 30_000;

setDefaultTimeout(DEFAULT_TIMEOUT_MS);

describe('sonar-context-augmentation passthrough behaviors (offline, real binary)', () => {
  let harness: TestHarness;

  beforeAll(async () => {
    harness = await TestHarness.create();
    mkdirSync(harness.cwd.path, { recursive: true });
    seedState(harness, {
      skills: [{ agentId: 'claude-code', projectRoot: harness.cwd.path }],
    });
    const install = await harness.run('--version', { timeoutMs: POST_UPDATE_TIMEOUT_MS });
    expect(install.exitCode, install.stderr).toBe(0);
  });

  afterAll(async () => {
    await harness.dispose();
  });

  it('fails with a clear CLI error when invoking a non-help action without auth', async () => {
    const result = await harness.run('context tool status', { timeoutMs: PASSTHROUGH_TIMEOUT_MS });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('Not authenticated');
  });

  it('treats a bare `sonar context` (no action) as a help request and exits 0', async () => {
    const result = await harness.run('context', { timeoutMs: PASSTHROUGH_TIMEOUT_MS });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout + result.stderr).toContain('Usage:');
  });

  it("propagates the real binary's non-zero exit code to the parent process", async () => {
    const result = await harness.run('context bogus-subcommand', {
      timeoutMs: PASSTHROUGH_TIMEOUT_MS,
      extraEnv: {
        SONARQUBE_CLI_TOKEN: 'offline-e2e-token',
        SONARQUBE_CLI_SERVER: 'https://sonarcloud.io',
        SONARQUBE_CLI_ORG: SEEDED_ORG_KEY,
      },
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('unrecognized subcommand');
  });
});
