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
 * Offline e2e for `sonar integrate <agent>` Vortex/Context Augmentation
 * pre-flight checks, against a fake SonarQube server. Asserts that the CLI
 * never reaches the real CAG binary on connections where CAG must be skipped:
 *
 *   - SonarQube Server (non-Cloud) connections.
 *   - Cloud connections where the org is not allowed to use CAG.
 *
 * Both paths must exit before `installContextAugmentationBinary()` runs, so
 * we assert no binary lands under `<cliHome>/bin/` and no declarative CAG
 * feature is recorded in state.
 *
 * The positive happy-path (Cloud + entitled + real binary install + real
 * `tool integrate`) is intentionally NOT covered here: CAG's daemon socket
 * lives at `<HOME>/.sonar/context-augmentation/projects/<32-char-hash>/daemon.sock`
 * (~82 chars), and the AF_UNIX path limit (103 on macOS, 108 on Linux)
 * does not leave room for TestHarness's `<tmpdir>/sonar-cli-harness-<ts>-<uuid>/home`
 * prefix. A live-server e2e against real SQ Cloud would side-step the harness
 * entirely; until then, the integrate happy path remains covered by
 * `tests/integration/specs/integrate/context-augmentation.test.ts` (stub
 * binary) and the post-update replay path is covered by the rest of
 * `tests/e2e/context/` (real binary, no daemon).
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from 'bun:test';

import { buildLocalCagBinaryName } from '@/core/host/install/context-augmentation.ts';
import { detectPlatform } from '@/core/host/platform-detector.ts';
import type { CliState } from '@/core/state/state.ts';

import { TestHarness } from '../../integration/harness';
import { findRecordedCagFeature } from './_helpers';

const DEFAULT_TIMEOUT_MS = 60_000;
const INTEGRATE_TIMEOUT_MS = 30_000;

setDefaultTimeout(DEFAULT_TIMEOUT_MS);

const PROJECT_KEY = 'cag-e2e-project';
const ORG_KEY = 'cag-e2e-org';
const TOKEN = 'cag-e2e-token';

describe('sonar integrate <agent> — CAG pre-flight skip paths (real CLI, fake server)', () => {
  let harness: TestHarness;
  let cagBinaryPath: string;

  beforeEach(async () => {
    harness = await TestHarness.create();
    cagBinaryPath = join(harness.cliHome.path, 'bin', buildLocalCagBinaryName(detectPlatform()));
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it('skips CAG entirely on a SonarQube Server connection (no Cloud URL override)', async () => {
    const server = await harness
      .newFakeServer()
      .withAuthToken(TOKEN)
      .withProject(PROJECT_KEY)
      .start();
    // No SONARQUBE_CLI_SONARCLOUD_URL override → the localhost URL falls
    // outside the cloud-hostname allowlist and is treated as SonarQube Server.
    // No org is supplied (SonarQube Server auth path).
    harness.withAuth(server.baseUrl(), TOKEN);
    harness.state().withSecretsBinaryInstalled();
    harness.cwd.writeFile(
      'sonar-project.properties',
      [`sonar.host.url=${server.baseUrl()}`, `sonar.projectKey=${PROJECT_KEY}`].join('\n'),
    );

    const result = await harness.run('integrate claude --non-interactive', {
      timeoutMs: INTEGRATE_TIMEOUT_MS,
    });

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain('Vortex is available on SonarQube Cloud.');
    expect(existsSync(cagBinaryPath), 'no CAG download on SonarQube Server').toBe(false);
    expect(findRecordedCagFeature(harness.stateJsonFile.asJson() as CliState)).toBeUndefined();
  });

  it('skips CAG when the Cloud org is not allowed to use it', async () => {
    const server = await harness
      .newFakeServer()
      .withAuthToken(TOKEN)
      .withProject(PROJECT_KEY)
      .withVortexEntitlement(ORG_KEY, `${ORG_KEY}-uuid-v4`, { allowed: false })
      .start();
    const serverUrl = server.baseUrl();
    harness.withAuth(serverUrl, TOKEN, ORG_KEY);
    harness.state().withSecretsBinaryInstalled();
    harness.cwd.writeFile(
      'sonar-project.properties',
      [
        `sonar.host.url=${serverUrl}`,
        `sonar.projectKey=${PROJECT_KEY}`,
        `sonar.organization=${ORG_KEY}`,
      ].join('\n'),
    );

    const result = await harness.run('integrate claude --non-interactive', {
      timeoutMs: INTEGRATE_TIMEOUT_MS,
      extraEnv: {
        SONARQUBE_CLI_SONARCLOUD_URL: serverUrl,
        SONARQUBE_CLI_SONARCLOUD_API_URL: serverUrl,
      },
    });

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain('Vortex is available on SonarQube Cloud.');
    expect(existsSync(cagBinaryPath), 'no CAG download when access is denied').toBe(false);
    expect(findRecordedCagFeature(harness.stateJsonFile.asJson() as CliState)).toBeUndefined();
  });

  it('skips CAG entirely for `integrate cursor` on a SonarQube Server connection', async () => {
    const server = await harness
      .newFakeServer()
      .withAuthToken(TOKEN)
      .withProject(PROJECT_KEY)
      .start();
    harness.withAuth(server.baseUrl(), TOKEN);
    harness.state().withSecretsBinaryInstalled();
    harness.cwd.writeFile(
      'sonar-project.properties',
      [`sonar.host.url=${server.baseUrl()}`, `sonar.projectKey=${PROJECT_KEY}`].join('\n'),
    );

    const result = await harness.run('integrate cursor --non-interactive', {
      timeoutMs: INTEGRATE_TIMEOUT_MS,
    });

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain('Vortex is available on SonarQube Cloud.');
    expect(existsSync(cagBinaryPath), 'no CAG download on SonarQube Server').toBe(false);
    expect(findRecordedCagFeature(harness.stateJsonFile.asJson() as CliState)).toBeUndefined();
  });
});
