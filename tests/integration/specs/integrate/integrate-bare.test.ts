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

// Integration tests for `sonar integrate` (bare command)

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { EXIT_CODE_SECRETS_FOUND } from '@/core/config-constants.ts';

import { hookScriptName, TestHarness } from '../../harness';
import { readSecretsScanArgvs } from '../../harness/recording-stub.ts';
import { chooseCustomize } from './integrate-test-helpers';
import { findInstalledFeature } from './state-helpers';

describe('integrate (bare command)', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
    harness.state().withSecretsBinaryInstalled();
    await harness.newFakeBinariesServer().start();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  function hasActiveClaudeHook(): boolean {
    const settings = harness.userHome.file('.claude', 'settings.json');
    return settings.exists() && /sonar-secrets|sonar-vortex/.test(settings.asText());
  }

  it(
    'exits with code 1 and reports error when user cancels the selection',
    async () => {
      const server = await harness.newFakeServer().withAuthToken('test-token').start();
      harness.withAuth(server.baseUrl(), 'test-token');

      const session = harness.runInteractive('integrate');
      await session.waitText('Select the tool you want to integrate with');
      session.keyCtrlC();
      const result = await session.waitFinish();

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('No integration selected');
    },
    { timeout: 15000 },
  );

  it(
    'requires an explicit agent in non-interactive mode',
    async () => {
      const server = await harness.newFakeServer().withAuthToken('test-token').start();
      harness.withAuth(server.baseUrl(), 'test-token');

      const result = await harness.run('integrate --non-interactive');

      expect(result.exitCode).toBe(2);
      const output = result.stdout + result.stderr;
      expect(output).toContain('--non-interactive requires an explicit agent');
      expect(output).not.toContain('Select the tool you want to integrate with');
    },
    { timeout: 15000 },
  );

  it('succeeds when bulk setup finds no coding agents', async () => {
    const server = await harness.newFakeServer().withAuthToken('test-token').start();
    harness.withAuth(server.baseUrl(), 'test-token');

    const result = await harness.run('integrate --all --non-interactive');

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('No supported coding agents detected.');
  });

  it.each([
    ['integrate --all', 'Use --non-interactive for unattended setup.'],
    ['integrate --server https://sonar.example.test', '--server and --org require --all.'],
    [
      'integrate --all --non-interactive --server invalid',
      '--server requires a valid HTTP(S) URL.',
    ],
    [
      'integrate --all --non-interactive --server https://sonar.example.test --org team',
      '--org requires a nonempty SonarQube Cloud organization key.',
    ],
  ])('rejects invalid or unattended bulk setup: %s', async (command, message) => {
    const result = await harness.run(command);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain(message);
  });

  it('requires authentication for unattended setup without --all', async () => {
    const result = await harness.run('integrate --non-interactive');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Not authenticated.');
  });

  it('rejects --all with an explicit tool', async () => {
    const server = await harness.newFakeServer().withAuthToken('test-token').start();
    harness.withAuth(server.baseUrl(), 'test-token');

    const result = await harness.run('integrate --all claude');

    expect(result.stderr).toContain('Bulk setup options cannot be combined with an explicit tool.');
    expect(result.exitCode).not.toBe(0);
  });

  it(
    'configures new agents and protects unrecorded Sonar settings',
    async () => {
      const server = await harness.newFakeServer().withAuthToken('test-token').start();
      harness.withAuth(server.baseUrl(), 'test-token');
      const existing = '{"mcpServers":{"sonarqube":{"command":"custom-sonar"}}}';
      harness.userHome.writeFile('.claude.json', existing);
      harness.userHome.writeFile('.codex/config.toml', '');

      const result = await harness.run('integrate --all --non-interactive');

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Claude Code: Needs review');
      expect(result.stdout).toContain('Codex: Configured');
      expect(harness.userHome.file('.claude.json').asText()).toBe(existing);
      expect(harness.userHome.exists('.codex', 'hooks.json')).toBe(true);
    },
    { timeout: 30000 },
  );

  it('protects escaped MCP names and the Copilot global hook configuration', async () => {
    const server = await harness.newFakeServer().withAuthToken('test-token').start();
    harness.withAuth(server.baseUrl(), 'test-token');
    const mcp = '{"mcpServers":{"\\u0073onarqube":{"command":"custom-sonar"}}}';
    const copilot = '{"hooks":{"sessionStart":[{"bash":"sonar-vortex/custom-hook"}]}}';
    harness.userHome.writeFile('.claude.json', mcp);
    harness.userHome.writeFile('.copilot/hooks/hooks.json', copilot);

    const result = await harness.run('integrate --all --non-interactive');

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Claude Code: Needs review');
    expect(result.stdout).toContain('Copilot: Needs review');
    expect(harness.userHome.file('.claude.json').asText()).toBe(mcp);
    expect(harness.userHome.file('.copilot', 'hooks', 'hooks.json').asText()).toBe(copilot);
  });

  it('recognizes a custom Codex MCP table with whitespace in the key', async () => {
    const server = await harness.newFakeServer().withAuthToken('test-token').start();
    harness.withAuth(server.baseUrl(), 'test-token');
    const config = '[mcp_servers . sonarqube]\ncommand = "custom-sonar"\n';
    harness.userHome.writeFile('.codex/config.toml', config);

    const setup = await harness.run('integrate --all --non-interactive');

    expect(setup.exitCode).toBe(0);
    expect(setup.stdout).toContain('Codex: Needs review');
    expect(harness.userHome.file('.codex', 'config.toml').asText()).toBe(config);
  });

  it(
    'continues past a partial install and finishes it on retry',
    async () => {
      const server = await harness.newFakeServer().withAuthToken('test-token').start();
      harness.withAuth(server.baseUrl(), 'test-token');
      harness.userHome.writeFile('.codex/config.toml', 'invalid TOML');
      harness.userHome.writeFile('.claude.json', '{}');

      const first = await harness.run('integrate --all --non-interactive');

      expect(first.exitCode).toBe(1);
      expect(first.stderr + first.stdout).toContain('Codex: Retry setup');
      expect(first.stdout).toContain('Claude Code: Configured');
      expect(harness.userHome.exists('.codex', 'hooks.json')).toBe(true);

      harness.state().withRawState(JSON.stringify(harness.stateJsonFile.asJson()));
      const status = await harness.run('system status');
      expect(status.stdout).toContain('codex: Retry setup');

      harness.userHome.writeFile('.codex/config.toml', '');
      const retry = await harness.run('integrate --all --non-interactive');
      expect(retry.exitCode).toBe(0);
      expect(retry.stdout).toContain('Codex: Configured');
      expect(retry.stdout).toContain('Claude Code: Already configured');
    },
    { timeout: 30000 },
  );

  it(
    'retries untargeted setup after switching to a different server',
    async () => {
      const firstServer = await harness.newFakeServer().withAuthToken('first-token').start();
      const secondServer = await harness.newFakeServer().withAuthToken('second-token').start();
      harness.withAuth(firstServer.baseUrl(), 'first-token');
      harness.userHome.writeFile('.codex/config.toml', 'invalid TOML');

      const failed = await harness.run('integrate --all --non-interactive');
      expect(failed.exitCode).toBe(1);
      const integrations = harness.stateJsonFile.asJson().integrations;
      expect(integrations.onboarding.codex).toEqual({ status: 'retry_setup' });

      harness.userHome.writeFile('.codex/config.toml', '');
      harness.withAuth(secondServer.baseUrl(), 'second-token');
      const state = harness.state().build();
      state.integrations = integrations;
      harness.state().withRawState(JSON.stringify(state));

      const retry = await harness.run('integrate --all --non-interactive');
      expect(retry.exitCode).toBe(0);
      expect(retry.stdout).toContain('Codex: Configured');
      expect(harness.stateJsonFile.asJson().integrations.onboarding.codex).toBeUndefined();
    },
    { timeout: 30000 },
  );

  it(
    'prepares signed-out agents and leaves token login non-interactive',
    async () => {
      const server = await harness.newFakeServer().withAuthToken('test-token').start();
      harness.userHome.writeFile('.claude.json', '{}');
      const bulk = 'integrate --all --non-interactive';

      const prepared = await harness.run(bulk + ' --server ' + server.baseUrl());
      expect(prepared.exitCode).toBe(0);
      expect(prepared.stdout).toContain('Claude Code: Waiting for sign-in');
      expect(harness.userHome.file('.claude', 'settings.json').asText()).toContain(
        'sonar-agent-onboarding',
      );
      expect(hasActiveClaudeHook()).toBe(false);
      harness.state().withRawState(JSON.stringify(harness.stateJsonFile.asJson()));

      const status = await harness.run('system status --format json');
      expect(JSON.parse(status.stdout).pendingIntegrations).toEqual([
        { agent: 'claude', status: 'waiting_for_sign_in', server: server.baseUrl() },
      ]);
      const textStatus = await harness.run('system status');
      expect(textStatus.stdout).toContain('claude: Waiting for sign-in');

      const login = await harness.runWithStdin(
        'auth login --with-token --server ' + server.baseUrl(),
        'test-token\n',
      );
      expect(login.exitCode).toBe(0);
      expect(login.stderr).toContain(bulk);
      expect(hasActiveClaudeHook()).toBe(false);
      harness.state().withRawState(JSON.stringify(harness.stateJsonFile.asJson()));

      const activated = await harness.run(bulk);
      expect(activated.exitCode).toBe(0);
      expect(activated.stdout).toContain('Claude Code: Configured');
      expect(harness.userHome.file('.claude', 'settings.json').asText()).not.toContain(
        'sonar-agent-onboarding',
      );
      expect(harness.userHome.exists('.claude', 'settings.json')).toBe(true);
    },
    { timeout: 30000 },
  );

  it.each([false, true])(
    'activates prepared agents after browser login and preserves failed setup for retry (invalid config: %s)',
    async (invalidConfig) => {
      const server = await harness.newFakeServer().withAuthToken('test-token').start();
      harness.userHome.writeFile('.claude.json', '{}');
      harness.userHome.writeFile('.codex/config.toml', '');

      const prepared = await harness.run(
        'integrate --all --non-interactive --server ' + server.baseUrl(),
      );
      expect(prepared.exitCode).toBe(0);
      expect(prepared.stdout).toContain('Codex: Waiting for sign-in');
      expect(prepared.stdout).toContain('Claude Code: Waiting for sign-in');
      expect(hasActiveClaudeHook()).toBe(false);
      harness.state().withRawState(JSON.stringify(harness.stateJsonFile.asJson()));
      if (invalidConfig) harness.userHome.writeFile('.codex/config.toml', 'invalid TOML');

      const session = harness.runInteractive('auth login --server ' + server.baseUrl(), {
        browserToken: 'test-token',
        extraEnv: { SONARQUBE_CLI_MOCK_TTY: '1' },
      });
      await session.waitText('Connect to:');
      session.write('y');
      const login = await session.waitFinish();

      expect(login.exitCode).toBe(0);
      expect(login.stdout).toContain('Authentication successful');
      expect(login.stdout).toContain('Claude Code: Configured');
      expect(hasActiveClaudeHook()).toBe(true);
      const pending = harness.stateJsonFile.asJson().integrations.onboarding;
      expect(pending['claude-code']).toBeUndefined();
      if (invalidConfig) {
        expect(login.stderr).toContain('Sign-in succeeded. Retry pending setup');
        expect(pending.codex).toMatchObject({
          server: server.baseUrl(),
          status: 'retry_setup',
        });
      } else {
        expect(login.stdout).toContain('Codex: Configured');
        expect(pending.codex).toBeUndefined();
      }
    },
    { timeout: 30000 },
  );

  it('keeps a prepared integration pending on a different connection', async () => {
    const server = await harness.newFakeServer().withAuthToken('test-token').start();
    harness.withAuth(server.baseUrl(), 'test-token');
    harness.userHome.writeFile('.claude.json', '{}');

    const result = await harness.run(
      'integrate --all --non-interactive --server https://sonar.example.test',
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Claude Code: Waiting for sign-in');
    expect(hasActiveClaudeHook()).toBe(false);
  });

  it('rejects a conflicting explicit target without activating the pending target', async () => {
    const server = await harness.newFakeServer().withAuthToken('test-token').start();
    harness.userHome.writeFile('.claude.json', '{}');
    const bulk = 'integrate --all --non-interactive --server ';
    expect((await harness.run(bulk + server.baseUrl())).exitCode).toBe(0);

    harness.state().withAuth(server.baseUrl(), 'test-token');
    const state = harness.state().build();
    state.integrations.onboarding = {
      'claude-code': { status: 'waiting_for_sign_in', server: server.baseUrl() },
    };
    harness.state().withRawState(JSON.stringify(state));
    const conflicting = await harness.run(bulk + 'https://sonar.example.test');
    expect(conflicting.exitCode).toBe(1);
    expect(conflicting.stderr).toContain('Pending setup targets a different SonarQube connection.');
    expect(hasActiveClaudeHook()).toBe(false);
  });

  it('can defer sign-in from the existing agent picker', async () => {
    harness.userHome.writeFile('.claude.json', '{}');
    const session = harness.runInteractive('integrate', {
      extraEnv: { SONARQUBE_CLI_MOCK_TTY: '1' },
    });
    await session.accept('Select the tool you want to integrate with');
    await session.waitText('Set up the new coding agents listed above?');
    session.write('y');
    await session.waitText('When would you like to sign in?');
    session.keyDown();
    session.keyEnter();

    const result = await session.waitFinish();
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Claude Code: Waiting for sign-in');
    expect(hasActiveClaudeHook()).toBe(false);
  });

  it('can sign in and finish bulk setup from the same command', async () => {
    const server = await harness.newFakeServer().withAuthToken('test-token').start();
    harness.userHome.writeFile('.claude.json', '{}');
    const session = harness.runInteractive('integrate --all --server ' + server.baseUrl(), {
      browserToken: 'test-token',
      extraEnv: { SONARQUBE_CLI_MOCK_TTY: '1' },
    });
    await session.waitText('Set up the new coding agents listed above?');
    session.write('y');
    await session.accept('When would you like to sign in?');
    await session.waitText('Connect to:');
    session.write('y');
    const result = await session.waitFinish();

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Claude Code: Waiting for sign-in');
    expect(result.stdout).toContain('Claude Code: Configured');
    expect(hasActiveClaudeHook()).toBe(true);
    expect(harness.stateJsonFile.asJson().integrations.onboarding['claude-code']).toBeUndefined();
  });

  it.each(['MDM', 'direct install'] as const)(
    'activates Claude and Cursor together after one sign-in through %s',
    async (mode) => {
      const server = await harness.newFakeServer().withAuthToken('test-token').start();
      const target = server.baseUrl();
      const cwd = harness.cwd.path;
      harness.userHome.writeFile('.claude.json', '{}');
      harness.userHome.writeFile('.cursor/marker', '');
      harness.cwd.writeFile(
        'sonar-project.properties',
        `sonar.host.url=${target}\nsonar.projectKey=sample\n`,
      );
      harness
        .state()
        .withSecretsBinaryResponding({ exitCode: EXIT_CODE_SECRETS_FOUND, stdout: '{}' });

      const cursorEnv = { CURSOR_VERSION: '1.7.2', CURSOR_PROJECT_DIR: cwd };
      const claudeStart = JSON.stringify({
        cwd,
        session_id: 'session',
        hook_event_name: 'SessionStart',
      });
      const cursorStart = JSON.stringify({ workspace_roots: [cwd], conversation_id: 'session' });
      const cursorInvitation = () =>
        harness.runWithStdin('hook agent-onboarding --agent cursor', cursorStart);
      const signInOptions = {
        browserToken: 'test-token',
        extraEnv: { SONARQUBE_CLI_MOCK_TTY: '1' },
      };
      let login;
      if (mode === 'MDM') {
        const prepared = await harness.run(`integrate --all --non-interactive --server ${target}`);
        expect(prepared.exitCode).toBe(0);
        expect(prepared.stdout).toContain('Cursor: Waiting for sign-in');
        expect(prepared.stdout).toContain('Claude Code: Waiting for sign-in');
        harness.state().withRawState(JSON.stringify(harness.stateJsonFile.asJson()));

        const inherited = await harness.runWithStdin(
          'hook agent-onboarding --agent claude',
          claudeStart,
          { extraEnv: cursorEnv },
        );
        expect(inherited.stdout).toBe('');
        expect((await cursorInvitation()).stdout).toContain('Sign in to SonarQube');
        harness.state().withRawState(JSON.stringify(harness.stateJsonFile.asJson()));
        expect((await cursorInvitation()).stdout).toBe('');
        login = harness.runInteractive(`auth login --server ${target}`, signInOptions);
      } else {
        login = harness.runInteractive('integrate', signInOptions);
        await login.waitText('Select the tool you want to integrate with');
        login.keyUp();
        login.keyEnter();
        await login.waitText('Set up the new coding agents listed above?');
        login.write('y');
        await login.accept('When would you like to sign in?');
      }
      await login.waitText('Connect to:');
      login.write('y');
      const result = await login.waitFinish();
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Cursor: Configured');
      expect(result.stdout).toContain('Claude Code: Configured');
      expect(result.stdout + result.stderr).not.toContain('may conflict at the hook level');
      harness.state().withRawState(JSON.stringify(harness.stateJsonFile.asJson()));
      expect((await cursorInvitation()).stdout).toBe('');

      const prompt = JSON.stringify({ prompt: 'fixture prompt' });
      const inherited = await harness.runWithStdin('hook claude-prompt-submit', prompt, {
        extraEnv: cursorEnv,
      });
      const cursor = await harness.runWithStdin('hook cursor-prompt-submit', prompt);
      const claude = await harness.runWithStdin('hook claude-prompt-submit', prompt);
      expect(inherited.stdout).toBe('');
      expect(cursor.stdout).toContain('"continue":false');
      expect(claude.stdout).toContain('"decision":"block"');
      expect(readSecretsScanArgvs(harness)).toHaveLength(2);
    },
    { timeout: 30000 },
  );

  it(
    'preserves an existing Claude setup when Cursor is added and removed',
    async () => {
      const server = await harness.newFakeServer().withAuthToken('test-token').start();
      harness.withAuth(server.baseUrl(), 'test-token');
      harness
        .state()
        .withSecretsBinaryResponding({ exitCode: EXIT_CODE_SECRETS_FOUND, stdout: '{}' });
      expect((await harness.run('integrate claude --non-interactive')).exitCode).toBe(0);
      harness.state().withRawState(JSON.stringify(harness.stateJsonFile.asJson()));
      const claudeSettings = harness.userHome.file('.claude', 'settings.json');
      const original = claudeSettings.asText();

      harness.userHome.writeFile('.cursor/marker', '');
      const setup = await harness.run('integrate --all --non-interactive');
      expect(setup.exitCode).toBe(0);
      expect(setup.stdout).toContain('Claude Code: Already configured');
      expect(setup.stdout).toContain('Cursor: Configured');
      expect(claudeSettings.asText()).toBe(original);
      harness.state().withRawState(JSON.stringify(harness.stateJsonFile.asJson()));

      const removal = harness.runInteractive('integrate cursor');
      await chooseCustomize(removal);
      for (const feature of ['secrets detection', 'MCP server']) {
        await removal.decline(`${feature} (currently installed)  Keep?`);
        await removal.accept('Proceed with removal?');
      }
      expect((await removal.waitFinish()).exitCode).toBe(0);
      expect(claudeSettings.asText()).toBe(original);
      expect(harness.userHome.exists('.cursor', 'hooks.json')).toBe(false);

      harness.state().withRawState(JSON.stringify(harness.stateJsonFile.asJson()));
      const inherited = await harness.runWithStdin(
        'hook claude-prompt-submit',
        JSON.stringify({ prompt: 'fixture prompt' }),
        { extraEnv: { CURSOR_VERSION: '1.7.2', CURSOR_PROJECT_DIR: harness.cwd.path } },
      );
      expect(inherited.stdout).toContain('"decision":"block"');
      expect(readSecretsScanArgvs(harness)).toHaveLength(1);
    },
    { timeout: 30000 },
  );

  it(
    'signs in without activating prepared agents when setup is disabled',
    async () => {
      const server = await harness.newFakeServer().withAuthToken('test-token').start();
      harness.userHome.writeFile('.claude.json', '{}');
      await harness.run('integrate --all --non-interactive --server ' + server.baseUrl());
      harness.state().withRawState(JSON.stringify(harness.stateJsonFile.asJson()));

      const session = harness.runInteractive(
        'auth login --no-agent-setup --server ' + server.baseUrl(),
        { browserToken: 'test-token', extraEnv: { SONARQUBE_CLI_MOCK_TTY: '1' } },
      );
      await session.waitText('Connect to:');
      session.write('y');
      const login = await session.waitFinish();

      expect(login.exitCode).toBe(0);
      expect(login.stdout).toContain('Authentication successful');
      expect(login.stdout).not.toContain('Claude Code: Configured');
      expect(harness.stateJsonFile.asJson().integrations.onboarding['claude-code']).toMatchObject({
        status: 'waiting_for_sign_in',
      });
    },
    { timeout: 30000 },
  );

  it('omits setup guidance from a JSON token login when setup is disabled', async () => {
    const server = await harness.newFakeServer().withAuthToken('test-token').start();
    harness.userHome.writeFile('.claude.json', '{}');
    const login = await harness.runWithStdin(
      'auth login --no-agent-setup --with-token --format json --server ' + server.baseUrl(),
      'test-token\n',
    );
    expect(login.exitCode).toBe(0);
    expect(JSON.parse(login.stdout)).toEqual({ status: 'connected', server: server.baseUrl() });
  });

  it('requires token login for JSON output', async () => {
    const login = await harness.run('auth login --format json');
    expect(login.exitCode).toBe(2);
    expect(login.stderr).toContain('--format json requires --with-token.');
  });

  it('reports machine-readable setup guidance after a token login', async () => {
    const server = await harness.newFakeServer().withAuthToken('test-token').start();
    harness.userHome.writeFile('.claude.json', '{}');

    await harness.run('integrate --all --non-interactive');
    harness.state().withRawState(JSON.stringify(harness.stateJsonFile.asJson()));

    const login = await harness.runWithStdin(
      'auth login --with-token --format json --server ' + server.baseUrl(),
      'test-token\n',
    );

    expect(login.exitCode).toBe(0);
    expect(JSON.parse(login.stdout)).toEqual({
      status: 'connected',
      server: server.baseUrl(),
      nextCommand: 'sonar integrate --all --non-interactive',
    });
  });

  it.each(['', '--format json'])(
    'guides a fresh token login %s to a detected agent',
    async (format) => {
      const server = await harness.newFakeServer().withAuthToken('test-token').start();
      harness.userHome.writeFile('.claude.json', '{}');
      const login = await harness.runWithStdin(
        'auth login --with-token --server ' + server.baseUrl() + ' ' + format,
        'test-token\n',
      );
      expect(login.exitCode).toBe(0);
      const command = 'sonar integrate claude --non-interactive';
      if (format) expect(JSON.parse(login.stdout).nextCommand).toBe(command);
      else expect(login.stderr).toContain(command);
      expect(harness.userHome.exists('.claude', 'settings.json')).toBe(false);
    },
  );

  it('does not suggest retrying prepared setup after sign-in to another target', async () => {
    const server = await harness.newFakeServer().withAuthToken('test-token').start();
    harness.userHome.writeFile('.claude.json', '{}');
    await harness.run('integrate --all --non-interactive --server https://another.example.test');
    harness.state().withRawState(JSON.stringify(harness.stateJsonFile.asJson()));
    const login = await harness.runWithStdin(
      'auth login --with-token --format json --server ' + server.baseUrl(),
      'test-token\n',
    );
    expect(login.exitCode).toBe(0);
    expect(JSON.parse(login.stdout).nextCommand).toBeUndefined();
  });

  it.each([false, true])(
    'offers setup after an entitled interactive login (accepted: %s)',
    async (acceptSetup) => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('test-token')
        .withVortexEntitlement('server', '00000000-0000-0000-0000-000000000000')
        .start();
      harness.withAuth(server.baseUrl(), 'test-token');
      harness.userHome.writeFile('.claude.json', '{}');
      const session = harness.runInteractive('auth login --server ' + server.baseUrl(), {
        extraEnv: { SONARQUBE_CLI_MOCK_TTY: '1' },
      });

      await session.waitText('Connect to:');
      session.write('y');
      await session.waitText('Set up SonarQube for your detected coding agents now?');
      session.write(acceptSetup ? 'y' : 'n');
      const result = await session.waitFinish();

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(
        acceptSetup ? 'Claude Code: Configured' : 'You can set up your coding agents later',
      );
      expect(hasActiveClaudeHook()).toBe(acceptSetup);
    },
    { timeout: 30000 },
  );

  it(
    'honors --non-interactive placed before the agent name',
    async () => {
      const server = await harness.newFakeServer().withAuthToken('test-token').start();
      harness.withAuth(server.baseUrl(), 'test-token');

      // Commander parses a flag before the subcommand name onto the parent command; the
      // preSubcommand hook must forward it, or this silently falls back to interactive mode
      // (and hangs waiting for input instead of failing loudly).
      const result = await harness.run('integrate --non-interactive claude');

      expect(result.exitCode).toBe(0);
      expect(harness.userHome.exists('.claude', 'settings.json')).toBe(true);
    },
    { timeout: 30000 },
  );

  it(
    'runs only the single selected integration, installing globally',
    async () => {
      const server = await harness.newFakeServer().withAuthToken('test-token').start();
      harness.withAuth(server.baseUrl(), 'test-token');

      // Single-select: the cursor starts on Claude (index 0); Enter confirms it.
      // There is no scope prompt anymore — every integration installs globally.
      const session = harness.runInteractive('integrate');
      await session.accept('Select the tool you want to integrate with');
      await chooseCustomize(session);
      await session.accept('Install secrets detection?');
      await session.accept('Install MCP server?');
      const result = await session.waitFinish();
      const output = result.stdout + result.stderr;

      expect(result.exitCode).toBe(0);
      expect(output).toContain('SonarQube Integration Setup for Claude Code');
      expect(output.split('Setup complete!').length - 1).toBe(1);

      const feature = findInstalledFeature(harness, 'claude-code', 'secrets-detection');
      expect(feature?.scope).toBe('global');
      expect(harness.userHome.exists('.claude', 'settings.json')).toBe(true);
      expect(
        harness.userHome.exists(
          '.claude',
          'hooks',
          'sonar-secrets',
          'build-scripts',
          hookScriptName('pretool-secrets'),
        ),
      ).toBe(true);
      expect(harness.cwd.exists('.claude')).toBe(false);
    },
    { timeout: 30000 },
  );

  it(
    'offers OpenCode in the selection prompt',
    async () => {
      const server = await harness.newFakeServer().withAuthToken('test-token').start();
      harness.withAuth(server.baseUrl(), 'test-token');

      const session = harness.runInteractive('integrate');
      await session.waitText('Select the tool you want to integrate with');
      for (let i = 0; i < 5; i++) session.keyDown();
      session.keyEnter();
      await session.waitText('SonarQube Integration Setup for OpenCode');
      session.keyCtrlC();
      const result = await session.waitFinish();

      expect(result.stdout + result.stderr).toContain('SonarQube Integration Setup for OpenCode');
    },
    { timeout: 15000 },
  );

  it(
    'offers Pi in the selection prompt',
    async () => {
      const server = await harness.newFakeServer().withAuthToken('test-token').start();
      harness.withAuth(server.baseUrl(), 'test-token');

      const session = harness.runInteractive('integrate');
      await session.waitText('Select the tool you want to integrate with');
      for (let i = 0; i < 7; i++) session.keyDown();
      session.keyEnter();
      await session.waitText('SonarQube Integration Setup for Pi');
      session.keyCtrlC();
      const result = await session.waitFinish();

      expect(result.stdout + result.stderr).toContain('SonarQube Integration Setup for Pi');
    },
    { timeout: 15000 },
  );

  it(
    'mentions detected installed agents before the selection prompt',
    async () => {
      const server = await harness.newFakeServer().withAuthToken('test-token').start();
      harness.withAuth(server.baseUrl(), 'test-token');
      // Marks Claude Code as installed on this machine for detection purposes.
      harness.userHome.writeFile('.claude.json', '{}');

      const session = harness.runInteractive('integrate');
      await session.waitText('Detected agents on your machine: Claude Code');
      session.keyCtrlC();
      const result = await session.waitFinish();

      expect(result.stdout).toContain('Detected agents on your machine: Claude Code');
    },
    { timeout: 15000 },
  );

  it(
    'mentions already-integrated tools before the selection prompt',
    async () => {
      const server = await harness.newFakeServer().withAuthToken('test-token').start();
      harness.withAuth(server.baseUrl(), 'test-token');

      const setup = await harness.run('integrate claude --non-interactive');
      expect(setup.exitCode).toBe(0);
      // harness.state() re-seeds state.json from the builder on every spawn; re-feed it
      // the state the CLI actually wrote so the next invocation sees it (see vortex.test.ts).
      harness.state().withRawState(JSON.stringify(harness.stateJsonFile.asJson()));

      const session = harness.runInteractive('integrate');
      await session.waitText('Already integrated: Claude Code');
      session.keyCtrlC();
      await session.waitFinish();
    },
    { timeout: 30000 },
  );

  async function runBareIntegrateWithAgents(markers: string[]) {
    const server = await harness.newFakeServer().withAuthToken('test-token').start();
    harness.withAuth(server.baseUrl(), 'test-token');
    for (const marker of markers) {
      harness.userHome.writeFile(marker, '{}');
    }

    const session = harness.runInteractive('integrate');
    await session.waitText('Select the tool you want to integrate with');
    session.keyCtrlC();
    return session.waitFinish();
  }

  it(
    'lists detected agents without a speculative hook warning',
    async () => {
      const result = await runBareIntegrateWithAgents([
        '.claude.json',
        '.cursor/marker',
        '.copilot/marker',
      ]);

      expect(result.stdout).toContain(
        'Detected agents on your machine: Cursor, Claude Code, Copilot',
      );
      expect(result.stdout + result.stderr).not.toContain('may conflict at the hook level');
    },
    { timeout: 15000 },
  );
});
