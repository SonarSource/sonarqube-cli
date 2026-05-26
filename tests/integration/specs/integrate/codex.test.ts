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

// Integration tests for `sonar integrate codex`.
// The codex-prompt-submit hook handler is exhaustively covered by
// hook-agent-prompt-submit.test.ts; this spec only exercises the integrate
// command — script + hooks.json layout, scope semantics, and idempotency.

import { isAbsolute } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { hookScriptName, hookScriptPath, normalizePath, TestHarness } from '../../harness';

const PROMPT_SCRIPT_DIRS = ['.codex', 'hooks', 'sonar-secrets', 'build-scripts'];
const HOOKS_JSON_DIRS = ['.codex', 'hooks.json'];
const AGENTS_MD_DIRS = ['.codex', 'AGENTS.md'];
const SECRETS_HEADING = '# SonarQube secrets scanning for files protocol';
const SQAA_HEADING = '# SonarQube Agentic Analysis protocol';

interface CodexHooksFile {
  hooks?: {
    UserPromptSubmit?: Array<{
      matcher?: string;
      hooks?: Array<{ type?: string; command?: string; timeout?: number }>;
    }>;
  };
}

describe('integrate codex', () => {
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
      'writes an executable prompt-submit script and a hooks.json entry under .codex/',
      async () => {
        const result = await harness.run('integrate codex');

        expect(result.exitCode).toBe(0);

        const scriptFile = harness.cwd.file(
          ...PROMPT_SCRIPT_DIRS,
          hookScriptName('prompt-secrets'),
        );
        expect(scriptFile.exists()).toBe(true);
        expect(scriptFile.isExecutable).toBe(true);

        const hooks: CodexHooksFile = harness.cwd.file(...HOOKS_JSON_DIRS).asJson();
        const entry = hooks.hooks?.UserPromptSubmit?.[0];
        expect(entry?.matcher).toBe('*');
        expect(entry?.hooks?.[0]?.type).toBe('command');
        expect(entry?.hooks?.[0]?.command).toContain('sonar-secrets');
      },
      { timeout: 30000 },
    );

    it(
      'uses a project-relative command path so the config is portable',
      async () => {
        await harness.run('integrate codex');

        const hooks: CodexHooksFile = harness.cwd.file(...HOOKS_JSON_DIRS).asJson();
        const command = hookScriptPath(
          String(hooks.hooks?.UserPromptSubmit?.[0]?.hooks?.[0]?.command),
        );
        expect(isAbsolute(command)).toBe(false);
        expect(command.startsWith('.codex/')).toBe(true);
      },
      { timeout: 30000 },
    );

    it(
      're-running does not duplicate the UserPromptSubmit entry',
      async () => {
        await harness.run('integrate codex');
        const result = await harness.run('integrate codex');

        expect(result.exitCode).toBe(0);
        const hooks: CodexHooksFile = harness.cwd.file(...HOOKS_JSON_DIRS).asJson();
        expect(hooks.hooks?.UserPromptSubmit).toHaveLength(1);
      },
      { timeout: 30000 },
    );

    it(
      'preserves pre-existing non-Sonar entries in hooks.json across re-install',
      async () => {
        harness.cwd.writeFile(
          '.codex/hooks.json',
          JSON.stringify({
            hooks: {
              UserPromptSubmit: [
                {
                  matcher: '*',
                  hooks: [
                    { type: 'command', command: '.codex/hooks/other-tool/run.sh', timeout: 30 },
                  ],
                },
              ],
            },
          }),
        );

        const result = await harness.run('integrate codex');

        expect(result.exitCode).toBe(0);
        const hooks: CodexHooksFile = harness.cwd.file(...HOOKS_JSON_DIRS).asJson();
        const commands = hooks.hooks?.UserPromptSubmit?.flatMap(
          (entry) => entry.hooks?.map((hook) => hook.command) ?? [],
        );
        expect(commands?.some((command) => command?.includes('other-tool'))).toBe(true);
        expect(commands?.some((command) => command?.includes('sonar-secrets'))).toBe(true);
      },
      { timeout: 30000 },
    );
  });

  describe('global install (-g)', () => {
    it(
      'writes script + hooks.json under $HOME/.codex/ with an absolute command path',
      async () => {
        const result = await harness.run('integrate codex -g');

        expect(result.exitCode).toBe(0);
        expect(harness.cwd.exists('.codex')).toBe(false);

        expect(
          harness.userHome.exists(...PROMPT_SCRIPT_DIRS, hookScriptName('prompt-secrets')),
        ).toBe(true);

        const hooks: CodexHooksFile = harness.userHome.file(...HOOKS_JSON_DIRS).asJson();
        const command = hookScriptPath(
          String(hooks.hooks?.UserPromptSubmit?.[0]?.hooks?.[0]?.command),
        );
        expect(isAbsolute(command)).toBe(true);
        expect(command.startsWith(normalizePath(harness.userHome.path))).toBe(true);
      },
      { timeout: 30000 },
    );
  });

  describe('option validation', () => {
    it('rejects --global combined with --project', async () => {
      const result = await harness.run('integrate codex -g -p some-project');

      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain('mutually exclusive');
    });
  });

  describe('AGENTS.md instructions', () => {
    const TEST_ORG = 'my-org';
    const TEST_PROJECT = 'my-project';

    it(
      'writes the secrets-on-read section to <repo>/.codex/AGENTS.md at project scope (no SQAA without entitlement)',
      async () => {
        const result = await harness.run('integrate codex');

        expect(result.exitCode).toBe(0);
        const body = harness.cwd.file(...AGENTS_MD_DIRS).asText();

        expect(body).toContain('<!-- sonar:begin:codex-secrets-on-read -->');
        expect(body).toContain('<!-- sonar:end:codex-secrets-on-read -->');
        expect(body).toContain(SECRETS_HEADING);
        expect(body).toContain('sonar analyze secrets');
      },
      { timeout: 30000 },
    );

    it(
      'appends the SQAA section with the project key baked in when the org is entitled',
      async () => {
        const server = await harness
          .newFakeServer()
          .withAuthToken('cloud-token')
          .withOrganizations([{ key: TEST_ORG, name: 'My Org' }])
          .withSqaaEntitlement(TEST_ORG, 'test-uuid-1234')
          .withProject(TEST_PROJECT)
          .start();
        const serverUrl = server.baseUrl();
        harness.withAuth(serverUrl, 'cloud-token', TEST_ORG);

        const result = await harness.run(`integrate codex --project ${TEST_PROJECT}`, {
          extraEnv: {
            SONARQUBE_CLI_SONARCLOUD_URL: serverUrl,
            SONARQUBE_CLI_SONARCLOUD_API_URL: serverUrl,
          },
        });

        expect(result.exitCode).toBe(0);
        const body = harness.cwd.file(...AGENTS_MD_DIRS).asText();
        expect(body).toContain('<!-- sonar:begin:codex-secrets-on-read -->');
        expect(body).toContain('<!-- sonar:end:codex-secrets-on-read -->');
        expect(body).toContain(SECRETS_HEADING);
        expect(body).toContain('<!-- sonar:begin:sqaa-protocol -->');
        expect(body).toContain('<!-- sonar:end:sqaa-protocol -->');
        expect(body).toContain(SQAA_HEADING);
        expect(body).toContain(`sonar analyze agentic --project ${TEST_PROJECT} --file`);
      },
      { timeout: 30000 },
    );

    it(
      'writes ~/.codex/AGENTS.md (and nothing project-side) at global scope without SQAA entitlement, and does NOT warn about SQAA',
      async () => {
        const result = await harness.run('integrate codex -g');

        expect(result.exitCode).toBe(0);
        expect(harness.cwd.exists(...AGENTS_MD_DIRS)).toBe(false);
        const body = harness.userHome.file(...AGENTS_MD_DIRS).asText();
        expect(body).toContain(SECRETS_HEADING);
        expect(body).not.toContain(SQAA_HEADING);
        const output = `${result.stdout}\n${result.stderr}`;
        expect(output).not.toContain('sonar integrate codex --project');
      },
      { timeout: 30000 },
    );

    it(
      'on global install, does not write SQAA project-side but warns to run per-project when the org is entitled',
      async () => {
        const server = await harness
          .newFakeServer()
          .withAuthToken('cloud-token')
          .withOrganizations([{ key: TEST_ORG, name: 'My Org' }])
          .withSqaaEntitlement(TEST_ORG, 'test-uuid-1234')
          .withProject(TEST_PROJECT)
          .start();
        const serverUrl = server.baseUrl();
        harness.withAuth(serverUrl, 'cloud-token', TEST_ORG);
        harness.cwd.writeFile('sonar-project.properties', `sonar.projectKey=${TEST_PROJECT}\n`);

        const result = await harness.run('integrate codex -g', {
          extraEnv: {
            SONARQUBE_CLI_SONARCLOUD_URL: serverUrl,
            SONARQUBE_CLI_SONARCLOUD_API_URL: serverUrl,
          },
        });

        expect(result.exitCode).toBe(0);
        expect(harness.cwd.exists(...AGENTS_MD_DIRS)).toBe(false);

        const globalBody = harness.userHome.file(...AGENTS_MD_DIRS).asText();
        expect(globalBody).toContain(SECRETS_HEADING);
        expect(globalBody).not.toContain(SQAA_HEADING);

        const output = `${result.stdout}\n${result.stderr}`;
        expect(output).toContain('SonarQube Agentic Analysis');
        expect(output).toContain('sonar integrate codex --project');
      },
      { timeout: 30000 },
    );
  });
});
