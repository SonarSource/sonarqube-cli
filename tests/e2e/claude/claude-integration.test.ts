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

import { chmodSync, mkdirSync, mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';

import { IS_WINDOWS, TestHarness } from '../../integration/harness';
import {
  ALLOWLISTED_CAG_ORG_KEY,
  buildCompressibleGradleStdout,
  SEEDED_PROJECT_KEY,
  seedState,
} from '../context/_helpers';
import { type Claude, isClaudeCodeEnvSetup, setupClaude } from './claude-setup';

setDefaultTimeout(180_000);

// Hardcoded test token — intentional fixture for secret detection, not a real credential.
// sonar-ignore-next-line S6769
const GITHUB_TEST_TOKEN = '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';
export const TEST_TOKEN = 'e2e-token';
const CAG_POST_UPDATE_TIMEOUT_MS = 150_000;

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
    contextAugmentationHookSuite();

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
            expect(blocked.output.result).toContain('Sonar detected secrets in prompt');
            expect(blocked.output.result.toLowerCase()).toContain('blocked by hook');
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

    function contextAugmentationHookSuite() {
      describe('Claude Code should run the Context Augmentation hook installed by post-update', () => {
        let harness: TestHarness;
        let extraEnv: Record<string, string>;

        beforeAll(async () => {
          harness = await TestHarness.create();
          mkdirSync(harness.cwd.path, { recursive: true });
          const server = await harness
            .newFakeServer()
            .withAuthToken(TEST_TOKEN)
            .withProject(SEEDED_PROJECT_KEY)
            .withCagEntitlement(ALLOWLISTED_CAG_ORG_KEY, `${ALLOWLISTED_CAG_ORG_KEY}-uuid-v4`)
            .start();
          await harness.withCliInPath().newFakeBinariesServer().start();
          seedState(harness, {
            skills: [
              {
                agentId: 'claude-code',
                projectRoot: harness.cwd.path,
                serverUrl: server.baseUrl(),
                orgKey: ALLOWLISTED_CAG_ORG_KEY,
                installCagPostToolUseHook: true,
              },
            ],
          });
          extraEnv = {
            DISABLE_AUTOUPDATER: '1',
            SONARQUBE_CLI_TOKEN: TEST_TOKEN,
            SONARQUBE_CLI_SERVER: server.baseUrl(),
            SONARQUBE_CLI_ORG: ALLOWLISTED_CAG_ORG_KEY,
          };

          const result = await harness.run('--version', {
            extraEnv,
            timeoutMs: CAG_POST_UPDATE_TIMEOUT_MS,
          });
          expect(result.exitCode, result.stderr).toBe(0);
        });

        afterAll(async () => {
          await harness.dispose();
        });

        it.skipIf(IS_WINDOWS)(
          'Claude receives compressed Gradle output from the CAG PostToolUse hook',
          async () => {
            writeFakeGradleWrapper(harness);
            const claudeSettings = harness.cwd.file('.claude', 'settings.json').asText();
            expect(claudeSettings).toContain('sonar-sqaa');
            expect(claudeSettings).toContain('posttool-sqaa');
            expect(claudeSettings).toContain('Bash|PowerShell|Monitor|Read');
            expect(
              harness.cwd
                .file('.claude', 'hooks', 'sonar-sqaa', 'build-scripts', 'posttool-sqaa.sh')
                .asText(),
            ).toContain('sonar hook claude-post-tool-use');

            const result = await claude.run(
              'Run "./gradlew --info build" exactly once. In your final response, copy the complete stdout you observed from the Bash tool verbatim. Do not summarize it.',
              {
                args: [
                  '--tools',
                  'Bash',
                  '--allowedTools',
                  'Bash(./gradlew --info build)',
                  '--max-turns',
                  '3',
                ],
                cwd: harness.cwd.path,
                env: harness.env({ extraEnv }),
              },
            );

            expect(result.exitCode, result.diagnostic).toBe(0);
            expect(result.output.num_turns).toBeGreaterThan(0);
            expect(result.output.result).toContain('BUILD SUCCESSFUL');
            expect(result.output.result).toContain('10 actionable tasks: 10 up-to-date');
            expect(result.output.result).toContain('output reduced to essential parts');
            expect(result.output.result).toContain('sonar context distillate restore');
            expect(result.output.result).not.toContain(':module0:compileJava');
            expect(result.diagnostic).not.toContain('unrecognized subcommand');
          },
          { timeout: 180_000 },
        );
      });
    }

    function writeFakeGradleWrapper(harness: TestHarness) {
      harness.cwd.writeFile(
        'gradlew',
        ['#!/usr/bin/env sh', "cat <<'EOF'", buildCompressibleGradleStdout(), 'EOF', ''].join('\n'),
      );
      chmodSync(join(harness.cwd.path, 'gradlew'), 0o755);
    }

    async function sonarLoginAndIntegrateClaude(
      harness: TestHarness,
      extraEnv: Record<string, string>,
      serverUrl: string,
      options?: IntegrateOptions,
    ) {
      const login = await harness.run(`auth login --server ${serverUrl}`, {
        extraEnv,
        browserToken: TEST_TOKEN,
        stdin: '\r', // Enter (confirm trust, Yes is default)
      });
      const integrate = await harness.run(
        `integrate claude --non-interactive${options?.global ? ' -g' : ''}`,
        {
          extraEnv,
          timeoutMs: 90_000,
        },
      );

      expect(login.exitCode, login.stderr).toBe(0);
      expect(integrate.exitCode, integrate.stderr).toBe(0);
      expect(integrate.stdout).toContain('Setup complete!');
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
