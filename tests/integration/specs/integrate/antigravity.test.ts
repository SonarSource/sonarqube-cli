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

// Integration tests for `sonar integrate antigravity` (CLI-549 orchestration).

import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { TestHarness } from '../../harness';
import { findInstalledFeature, getInstalledIntegration } from './state-helpers';

const TEST_PROJECT = 'my-project';

describe('integrate antigravity', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
    harness.state().withSecretsBinaryInstalled();
    const server = await harness.newFakeServer().withAuthToken('tok').start();
    harness.withAuth(server.baseUrl(), 'tok');
  });

  afterEach(async () => {
    await harness.dispose();
  });

  describe('project-level install (default)', () => {
    it(
      'completes successfully and records integration state with connection metadata',
      async () => {
        const result = await harness.run(
          `integrate antigravity --project ${TEST_PROJECT} --non-interactive`,
        );

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('Setup complete!');

        const integration = getInstalledIntegration(harness, 'antigravity-cli');
        expect(integration).toBeDefined();

        const setupFeature = findInstalledFeature(harness, 'antigravity-cli', 'integration-setup');
        expect(setupFeature).toBeDefined();
        expect(setupFeature?.scope).toBe('project');
        expect(setupFeature?.attrs?.projectKey).toBe(TEST_PROJECT);
        expect(setupFeature?.attrs?.serverUrl).toBeTruthy();
      },
      { timeout: 30000 },
    );

    it(
      'is idempotent on re-run (health check / repair)',
      async () => {
        await harness.run(`integrate antigravity --project ${TEST_PROJECT} --non-interactive`);
        const result = await harness.run(
          `integrate antigravity --project ${TEST_PROJECT} --non-interactive`,
        );

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('Setup complete!');
        const integration = getInstalledIntegration(harness, 'antigravity-cli');
        expect(
          integration?.features.filter((f) => f.featureId === 'integration-setup'),
        ).toHaveLength(1);
      },
      { timeout: 30000 },
    );

    it(
      'announces Context Augmentation skip when --skip-context is set',
      async () => {
        const result = await harness.run('integrate antigravity --non-interactive --skip-context');

        expect(result.exitCode).toBe(0);
        expect(result.stdout + result.stderr).toContain(
          'Skipping Context Augmentation (--skip-context)',
        );
      },
      { timeout: 30000 },
    );
  });

  describe('global install', () => {
    it(
      'targets the Antigravity global config directory',
      async () => {
        const result = await harness.run('integrate antigravity -g --non-interactive');

        expect(result.exitCode).toBe(0);

        const expectedGlobalRoot = join(harness.userHome.path, '.gemini', 'config');
        const setupFeature = findInstalledFeature(
          harness,
          'antigravity-cli',
          'integration-setup',
          'global',
        );
        expect(setupFeature?.targetRoot).toBe(expectedGlobalRoot);
      },
      { timeout: 30000 },
    );
  });

  describe('option validation', () => {
    it(
      'exits with code 2 when both --global and --project are provided',
      async () => {
        const result = await harness.run('integrate antigravity --global --project foo');

        expect(result.exitCode).toBe(2);
        expect(result.stdout + result.stderr).toContain(
          '--global and --project are mutually exclusive',
        );
      },
      { timeout: 15000 },
    );
  });

  describe('authentication and cloud org', () => {
    it(
      'exits with error when user is not authenticated',
      async () => {
        const unauthHarness = await TestHarness.create();
        try {
          const result = await unauthHarness.run('integrate antigravity --non-interactive');

          expect(result.exitCode).toBe(1);
          expect(result.stdout + result.stderr).toContain('Not authenticated');
        } finally {
          await unauthHarness.dispose();
        }
      },
      { timeout: 15000 },
    );

    it(
      'fails clearly when SonarQube Cloud org is missing',
      async () => {
        const cloudHarness = await TestHarness.create();
        try {
          const server = await cloudHarness.newFakeServer().withAuthToken('cloud-token').start();
          const serverUrl = server.baseUrl();
          cloudHarness.withAuth(serverUrl, 'cloud-token');
          cloudHarness.state().withSecretsBinaryInstalled();

          const result = await cloudHarness.run('integrate antigravity --non-interactive', {
            extraEnv: {
              SONARQUBE_CLI_SONARCLOUD_URL: serverUrl,
              SONARQUBE_CLI_SONARCLOUD_API_URL: `${serverUrl}/api`,
            },
          });

          expect(result.exitCode).toBe(1);
          expect(result.stdout + result.stderr).toContain(
            'SonarQube Cloud requires an organization',
          );
        } finally {
          await cloudHarness.dispose();
        }
      },
      { timeout: 30000 },
    );
  });

  describe('--help', () => {
    it(
      'documents options consistent with other agent integrate commands',
      async () => {
        const result = await harness.run('integrate antigravity --help');

        expect(result.exitCode).toBe(0);
        const help = result.stdout;
        expect(help).toContain('--project');
        expect(help).toContain('--global');
        expect(help).toContain('--non-interactive');
        expect(help).toContain('--skip-context');
        expect(help).toContain('sonar.projectKey');
      },
      { timeout: 15000 },
    );
  });
});
