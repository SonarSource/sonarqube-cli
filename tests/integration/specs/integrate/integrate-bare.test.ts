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

import { hookScriptName, TestHarness } from '../../harness';
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

      harness.userHome.writeFile('.codex/config.toml', '');
      harness.state().withRawState(JSON.stringify(harness.stateJsonFile.asJson()));
      const retry = await harness.run('integrate --all --non-interactive');
      expect(retry.exitCode).toBe(0);
      expect(retry.stdout).toContain('Codex: Configured');
      expect(retry.stdout).toContain('Claude Code: Already configured');
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

  it(
    'activates prepared agents after browser authentication without a second setup command',
    async () => {
      const server = await harness.newFakeServer().withAuthToken('test-token').start();
      harness.userHome.writeFile('.claude.json', '{}');
      const prepared = await harness.run(
        'integrate --all --non-interactive --server ' + server.baseUrl(),
      );
      expect(prepared.exitCode).toBe(0);
      expect(hasActiveClaudeHook()).toBe(false);
      harness.state().withRawState(JSON.stringify(harness.stateJsonFile.asJson()));

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
      expect(harness.stateJsonFile.asJson().integrations.onboarding['claude-code']).toBeUndefined();
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

  it(
    'offers one setup prompt after an entitled interactive login',
    async () => {
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
      session.write('n');
      const result = await session.waitFinish();

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('You can set up your coding agents later');
      expect(hasActiveClaudeHook()).toBe(false);
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

  const CONFLICT_HINT =
    "→ Run 'sonar integrate' again anytime to add, customize or remove an agent.";

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
    'prints one conflict line listing all three agents when Claude, Cursor and Copilot are detected',
    async () => {
      const result = await runBareIntegrateWithAgents([
        '.claude.json',
        '.cursor/marker',
        '.copilot/marker',
      ]);

      expect(result.stdout).toContain(
        'Cursor, Claude Code and Copilot may conflict at the hook level.',
      );
      expect(result.stdout).toContain(CONFLICT_HINT);
      expect(result.stdout.match(/may conflict at the hook level/g)).toHaveLength(1);
      expect(result.stderr).not.toContain('conflict');
    },
    { timeout: 15000 },
  );

  it(
    'prints the conflict line for two agents when Claude and Cursor are detected',
    async () => {
      const result = await runBareIntegrateWithAgents(['.claude.json', '.cursor/marker']);

      expect(result.stdout).toContain('Cursor and Claude Code may conflict at the hook level.');
      expect(result.stdout).toContain(CONFLICT_HINT);
    },
    { timeout: 15000 },
  );

  it(
    'prints the conflict line for two agents when Claude and Copilot are detected',
    async () => {
      const result = await runBareIntegrateWithAgents(['.claude.json', '.copilot/marker']);

      expect(result.stdout).toContain('Claude Code and Copilot may conflict at the hook level.');
      expect(result.stdout).toContain(CONFLICT_HINT);
    },
    { timeout: 15000 },
  );

  it(
    'prints no conflict line when only Cursor and Copilot are detected',
    async () => {
      const result = await runBareIntegrateWithAgents(['.cursor/marker', '.copilot/marker']);

      expect(result.stdout).toContain('Detected agents on your machine:');
      expect(result.stdout).not.toContain('may conflict at the hook level');
      expect(result.stdout).not.toContain(CONFLICT_HINT);
    },
    { timeout: 15000 },
  );
});
