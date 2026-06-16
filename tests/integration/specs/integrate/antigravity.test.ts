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

// Integration tests for `sonar integrate antigravity`.

import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { IS_WINDOWS, normalizePath, TestHarness } from '../../harness';
import {
  type AntigravityHooksJson,
  findAntigravityFeature,
  GLOBAL_HOOK_SCRIPT_PATH,
  GLOBAL_HOOKS_JSON_PATH,
  GLOBAL_INSTRUCTIONS_PATH,
  PROJECT_HOOK_SCRIPT_PATH,
  PROJECT_HOOKS_JSON_PATH,
  PROJECT_INSTRUCTIONS_PATH,
  writeDisabledGlobalHook,
  writeExistingGlobalHook,
  writeExistingGlobalInstructions,
  writeOrphanedGlobalHookConfig,
} from './antigravity-test-helpers';

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
      'writes hook script, hooks.json, and prompt-secrets instructions',
      async () => {
        const result = await harness.run(
          `integrate antigravity --project ${TEST_PROJECT} --non-interactive`,
        );

        expect(result.exitCode).toBe(0);
        expect(harness.cwd.exists(...PROJECT_HOOK_SCRIPT_PATH)).toBe(true);
        expect(harness.cwd.exists(...PROJECT_HOOKS_JSON_PATH)).toBe(true);
        expect(harness.cwd.exists(...PROJECT_INSTRUCTIONS_PATH)).toBe(true);

        const hooksJson = harness.cwd
          .file(...PROJECT_HOOKS_JSON_PATH)
          .asJson() as AntigravityHooksJson;
        const command = normalizePath(
          hooksJson['sonar-secrets']?.PreToolUse?.[0]?.hooks?.[0]?.command ?? '',
        );
        expect(command.startsWith('/')).toBe(false);
        expect(command.startsWith(IS_WINDOWS ? 'powershell' : 'bash')).toBe(true);
        expect(command).toContain('.agents/sonar/hooks');
        expect(command).toMatch(IS_WINDOWS ? /powershell -NoProfile -File "/ : /bash "/);
        expect(hooksJson['sonar-secrets']?.enabled).toBe(true);
        expect(hooksJson['sonar-secrets']?.PreToolUse?.[0]?.matcher).toBe('view_file');

        const scriptBody = harness.cwd.file(...PROJECT_HOOK_SCRIPT_PATH).asText();
        expect(scriptBody).toContain('sonar hook antigravity-pre-tool-use');

        const instructions = harness.cwd.file(...PROJECT_INSTRUCTIONS_PATH).asText();
        expect(instructions).toContain('# SonarQube secrets scanning for prompts protocol');
      },
      { timeout: 30000 },
    );

    it(
      'records sonar-secrets-hooks and prompt-secrets-instructions in state',
      async () => {
        await harness.run(`integrate antigravity --project ${TEST_PROJECT} --non-interactive`);

        const secretsFeature = findAntigravityFeature(harness, 'sonar-secrets-hooks');
        expect(secretsFeature?.scope).toBe('project');
        expect(secretsFeature?.attrs?.projectKey).toBe(TEST_PROJECT);

        const instructionsFeature = findAntigravityFeature(harness, 'prompt-secrets-instructions');
        expect(instructionsFeature?.scope).toBe('project');
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
        const instructions = harness.cwd.file(...PROJECT_INSTRUCTIONS_PATH).asText();
        const headingCount =
          instructions.split('# SonarQube secrets scanning for prompts protocol').length - 1;
        expect(headingCount).toBe(1);
      },
      { timeout: 60000 },
    );

    it(
      'preserves unrelated hooks.json blocks',
      async () => {
        harness.cwd.writeFile(
          '.agents/hooks.json',
          JSON.stringify({
            'other-hook': {
              PreToolUse: [{ matcher: 'run_command', hooks: [{ command: './lint.sh' }] }],
            },
          }),
        );

        const result = await harness.run('integrate antigravity --non-interactive');
        expect(result.exitCode).toBe(0);

        const hooksJson = harness.cwd
          .file(...PROJECT_HOOKS_JSON_PATH)
          .asJson() as AntigravityHooksJson;
        expect(hooksJson['other-hook']).toBeDefined();
        expect(hooksJson['sonar-secrets']).toBeDefined();
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

  describe('global install (-g)', () => {
    it(
      'writes hook script, hooks.json, and instructions under ~/.gemini/config',
      async () => {
        const result = await harness.run('integrate antigravity -g --non-interactive');

        expect(result.exitCode).toBe(0);
        expect(harness.userHome.exists(...GLOBAL_HOOK_SCRIPT_PATH)).toBe(true);
        expect(harness.userHome.exists(...GLOBAL_HOOKS_JSON_PATH)).toBe(true);
        expect(harness.userHome.exists(...GLOBAL_INSTRUCTIONS_PATH)).toBe(true);

        const json = harness.userHome
          .file(...GLOBAL_HOOKS_JSON_PATH)
          .asJson() as AntigravityHooksJson;
        const command = normalizePath(
          json['sonar-secrets']?.PreToolUse?.[0]?.hooks?.[0]?.command ?? '',
        );
        const homePathNorm = normalizePath(harness.userHome.path);
        expect(command.startsWith(IS_WINDOWS ? 'powershell' : 'bash')).toBe(true);
        expect(command.includes(homePathNorm)).toBe(true);
        expect(command).toContain('.gemini/config/sonar/hooks');
      },
      { timeout: 30000 },
    );

    it(
      'records secrets hooks and instructions as global features',
      async () => {
        await harness.run('integrate antigravity -g --non-interactive');

        expect(findAntigravityFeature(harness, 'sonar-secrets-hooks', 'global')).toBeDefined();
        expect(
          findAntigravityFeature(harness, 'prompt-secrets-instructions', 'global'),
        ).toBeDefined();

        const expectedGlobalRoot = join(harness.userHome.path, '.gemini', 'config');
        expect(findAntigravityFeature(harness, 'sonar-secrets-hooks', 'global')?.targetRoot).toBe(
          expectedGlobalRoot,
        );
      },
      { timeout: 30000 },
    );

    it(
      'preserves pre-existing global instructions and appends the managed prompt-secrets block',
      async () => {
        harness.userHome.writeFile(
          join('.gemini', 'config', 'instructions', 'sonarqube.instructions.md'),
          '# pre-existing\n',
        );

        const result = await harness.run('integrate antigravity -g --non-interactive');

        expect(result.exitCode).toBe(0);
        const body = harness.userHome.file(...GLOBAL_INSTRUCTIONS_PATH).asText();
        expect(body).toContain('# pre-existing');
        expect(body).toContain('# SonarQube secrets scanning for prompts protocol');
      },
      { timeout: 30000 },
    );
  });

  describe('project-level install when global Antigravity instructions already exist', () => {
    it(
      'writes the project-level instructions file and leaves the global file untouched',
      async () => {
        writeExistingGlobalInstructions(harness);
        const before = harness.userHome.file(...GLOBAL_INSTRUCTIONS_PATH).asText();

        const result = await harness.run('integrate antigravity --non-interactive');

        expect(result.exitCode).toBe(0);
        expect(harness.cwd.exists(...PROJECT_INSTRUCTIONS_PATH)).toBe(true);
        expect(harness.cwd.file(...PROJECT_INSTRUCTIONS_PATH).asText()).toContain(
          '# SonarQube secrets scanning for prompts protocol',
        );
        expect(harness.userHome.file(...GLOBAL_INSTRUCTIONS_PATH).asText()).toBe(before);
        expect(findAntigravityFeature(harness, 'prompt-secrets-instructions')?.scope).toBe(
          'project',
        );
      },
      { timeout: 30000 },
    );

    it(
      'auto-skips the hook (with message) and asks a custom question when a global hook and global instructions both exist',
      async () => {
        writeExistingGlobalHook(harness);
        writeExistingGlobalInstructions(harness);

        const result = await harness.run('integrate antigravity --skip-context', {
          stdinChunks: ['\r', '\r'],
        });

        expect(result.exitCode).toBe(0);
        const output = result.stdout + result.stderr;
        expect(output).toContain('global secrets scanning hook');
        expect(output).not.toContain('Install secret scanning hooks?');
        expect(harness.cwd.exists(...PROJECT_HOOK_SCRIPT_PATH)).toBe(false);
        expect(findAntigravityFeature(harness, 'sonar-secrets-hooks')).toBeUndefined();
        expect(output).toContain(
          'Global Antigravity instructions already exist. Do you also want to create a project-local copy for this repo?',
        );
        expect(harness.cwd.exists(...PROJECT_INSTRUCTIONS_PATH)).toBe(true);
        expect(findAntigravityFeature(harness, 'prompt-secrets-instructions')?.scope).toBe(
          'project',
        );
      },
      { timeout: 30000 },
    );
  });

  describe('project install when a global secrets hook already exists', () => {
    it(
      'skips project-level secrets hooks but still installs prompt instructions',
      async () => {
        writeExistingGlobalHook(harness);

        const result = await harness.run('integrate antigravity --non-interactive');

        expect(result.exitCode).toBe(0);
        expect(result.stdout + result.stderr).toContain('global secrets scanning hook');
        expect(harness.cwd.exists(...PROJECT_HOOK_SCRIPT_PATH)).toBe(false);
        expect(harness.cwd.exists(...PROJECT_INSTRUCTIONS_PATH)).toBe(true);
        expect(findAntigravityFeature(harness, 'sonar-secrets-hooks')).toBeUndefined();
        expect(findAntigravityFeature(harness, 'prompt-secrets-instructions')).toBeDefined();
      },
      { timeout: 30000 },
    );

    it(
      'installs project-level secrets hooks when the global block is disabled',
      async () => {
        writeDisabledGlobalHook(harness);

        const result = await harness.run('integrate antigravity --non-interactive');

        expect(result.exitCode).toBe(0);
        expect(harness.cwd.exists(...PROJECT_HOOK_SCRIPT_PATH)).toBe(true);
        expect(harness.cwd.exists(...PROJECT_HOOKS_JSON_PATH)).toBe(true);
        expect(findAntigravityFeature(harness, 'sonar-secrets-hooks')).toBeDefined();
      },
      { timeout: 30000 },
    );

    it(
      'installs project-level secrets hooks when global hooks.json references a missing script',
      async () => {
        writeOrphanedGlobalHookConfig(harness);

        const result = await harness.run('integrate antigravity --non-interactive');

        expect(result.exitCode).toBe(0);
        expect(result.stdout + result.stderr).toContain('backing script is missing');
        expect(harness.cwd.exists(...PROJECT_HOOK_SCRIPT_PATH)).toBe(true);
        expect(findAntigravityFeature(harness, 'sonar-secrets-hooks')).toBeDefined();
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
