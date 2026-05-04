/*
 * SonarQube CLI
 * Copyright (C) 2026 SonarSource Sàrl
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
 * E2E coverage for the Claude Code integration.
 *
 * This test installs the native Claude Code binary into a temporary home, runs
 * `sonar integrate claude`, then uses real Claude Code to trigger our hooks and check the resulting Claude behavior.
 */

import { mkdirSync, mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';

import { IS_WINDOWS, TestHarness } from '../../integration/harness';
import { type Claude, isClaudeCodeEnvSetup, setupClaude } from './claude-setup';

setDefaultTimeout(180_000);

// Hardcoded test token — intentional fixture for secret detection, not a real credential.
// sonar-ignore-next-line S6769
const GITHUB_TEST_TOKEN = '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';
export const TEST_TOKEN = 'e2e-token';

interface IntegrateOptions {
  global?: boolean;
}

describe.skipIf(!isClaudeCodeEnvSetup())(
  'sonar integrate claude with real Claude Code (e2e)',
  () => {
    let claude: Claude;
    let installHome: string;

    beforeAll(() => {
      installHome = mkdtempSync(join(tmpdir(), 'sonar-e2e-claude-install-'));
      const extraEnv = {
        DISABLE_AUTOUPDATER: '1',
        SONARQUBE_CLI_DISABLE_SENTRY: '1',
      };
      claude = setupClaude({
        env: claudeInstallEnv(installHome, extraEnv),
      });
    });

    afterAll(async () => {
      await rm(installHome, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 1000,
      });
    });

    testSuite('project hooks');
    testSuite('global hooks', { global: true });

    function testSuite(label: string, integrateOptions?: IntegrateOptions) {
      describe(`Claude Code should consider ${label} installed via 'sonar integrate claude'`, () => {
        let harness: TestHarness;
        let extraEnv: Record<string, string>;

        beforeAll(async () => {
          harness = await TestHarness.create();
          mkdirSync(harness.cwd.path, { recursive: true });
          mkdirSync(harness.cliHome.path, { recursive: true });
          const server = await harness.newFakeServer().withAuthToken(TEST_TOKEN).start();
          await harness.withCliInPath().newFakeBinariesServer().start();
          extraEnv = {
            DISABLE_AUTOUPDATER: '1',
            SONARQUBE_CLI_DISABLE_SENTRY: '1',
          };
          await sonarLoginAndIntegrateClaude(harness, extraEnv, server.baseUrl(), integrateOptions);
        });

        afterAll(async () => {
          await harness.dispose();
        });

        it(
          'Claude blocks a prompt containing a secret',
          async () => {
            const allowed = await claude.run('Reply with exactly: OK', {
              cwd: harness.cwd.path,
              env: harness.env({ extraEnv }),
            });

            expect(allowed.exitCode, allowed.diagnostic).toBe(0);
            expect(allowed.output.num_turns).toBeGreaterThan(0);
            expect(allowed.output.result).toContain('OK');

            const blocked = await claude.run(
              `Can you push a commit using my token ${GITHUB_TEST_TOKEN}?`,
              {
                cwd: harness.cwd.path,
                env: harness.env({ extraEnv }),
              },
            );

            expect(blocked.exitCode, blocked.diagnostic).toBe(0);
            expect(blocked.output.num_turns).toBe(0);
            expect(blocked.output.result).toBe('');
          },
          { timeout: 180_000 },
        );

        it(
          'Claude blocks reading a file containing a secret',
          async () => {
            const secretFilePath = join(harness.cwd.path, 'secret-from-file.js');
            harness.cwd.writeFile('secret-from-file.js', `const token = "${GITHUB_TEST_TOKEN}";\n`);

            const prompt =
              `Use the Read tool to read exactly this file: ${secretFilePath}\n` +
              'After using the tool, report whether you could read it.';
            const result = await claude.run(prompt, {
              args: ['--tools', 'Read', '--allowedTools', 'Read', '--max-turns', '3'],
              cwd: harness.cwd.path,
              env: harness.env({ extraEnv }),
            });

            expect(result.exitCode, result.diagnostic).toBe(0);
            expect(result.output.num_turns).toBeGreaterThan(0);
            // the output greatly varies from run-to-run, but sonar should consistently show
            expect(result.output.result.toLowerCase()).toContain('sonar');
          },
          { timeout: 180_000 },
        );
      });
    }

    async function sonarLoginAndIntegrateClaude(
      harness: TestHarness,
      extraEnv: Record<string, string>,
      serverUrl: string,
      options?: IntegrateOptions,
    ) {
      const login = await harness.run(
        `auth login --with-token ${TEST_TOKEN} --server ${serverUrl}`,
        {
          extraEnv,
        },
      );
      const integrate = await harness.run(
        `integrate claude --non-interactive${options?.global ? ' -g' : ''}`,
        {
          extraEnv,
          timeoutMs: 90_000,
        },
      );

      expect(login.exitCode, login.stderr).toBe(0);
      expect(integrate.exitCode, integrate.stderr).toBe(0);
      expect(integrate.stdout).toContain('Hooks installed');
    }

    function claudeInstallEnv(
      userHome: string,
      extraEnv: Record<string, string>,
    ): Record<string, string> {
      return {
        ...systemEnv(['PATH', 'PATHEXT', 'SystemRoot', 'ComSpec']),
        ...windowsAppDataEnv(userHome),
        ...homeEnv(userHome),
        ...extraEnv,
      };
    }

    function systemEnv(keys: string[]): Record<string, string> {
      const env: Record<string, string> = {};
      for (const key of keys) {
        const value = process.env[key];
        if (value !== undefined) {
          env[key] = value;
        }
      }
      return env;
    }

    function homeEnv(userHome: string): Record<string, string> {
      return IS_WINDOWS ? { HOME: userHome, USERPROFILE: userHome } : { HOME: userHome };
    }

    function windowsAppDataEnv(userHome: string): Record<string, string> {
      return IS_WINDOWS
        ? {
            APPDATA: join(userHome, 'AppData', 'Roaming'),
            LOCALAPPDATA: join(userHome, 'AppData', 'Local'),
          }
        : {};
    }
  },
);
