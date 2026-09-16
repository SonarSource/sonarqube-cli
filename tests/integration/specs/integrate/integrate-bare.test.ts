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

  it(
    'runs only the single selected integration, installing globally',
    async () => {
      const server = await harness.newFakeServer().withAuthToken('test-token').start();
      harness.withAuth(server.baseUrl(), 'test-token');

      // Single-select: the cursor starts on Claude (index 0); Enter confirms it.
      // There is no scope prompt anymore — every integration installs globally.
      const session = harness.runInteractive('integrate');
      await session.accept('Select the tool you want to integrate with');
      await session.accept('Install secret scanning hooks?');
      await session.accept('Install MCP server?');
      const result = await session.waitFinish();
      const output = result.stdout + result.stderr;

      expect(result.exitCode).toBe(0);
      expect(output).toContain('SonarQube Integration Setup for Claude Code');
      expect(output.split('Setup complete!').length - 1).toBe(1);

      const feature = findInstalledFeature(harness, 'claude-code', 'sonar-secrets-hooks');
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

  it(
    'warns about hook-execution conflicts when Claude and Cursor are both detected',
    async () => {
      const server = await harness.newFakeServer().withAuthToken('test-token').start();
      harness.withAuth(server.baseUrl(), 'test-token');
      harness.userHome.writeFile('.claude.json', '{}');
      harness.userHome.writeFile('.cursor/marker', '');

      const session = harness.runInteractive('integrate');
      await session.waitText('Select the tool you want to integrate with');
      session.keyCtrlC();
      const result = await session.waitFinish();

      expect(result.stderr).toContain(
        'Both Claude Code and Cursor were detected on this machine. Integrating with both may cause conflicts in hook execution.',
      );
    },
    { timeout: 15000 },
  );

  it(
    'warns about hook-execution conflicts when Claude and Copilot are both detected',
    async () => {
      const server = await harness.newFakeServer().withAuthToken('test-token').start();
      harness.withAuth(server.baseUrl(), 'test-token');
      harness.userHome.writeFile('.claude.json', '{}');
      harness.userHome.writeFile('.copilot/marker', '');

      const session = harness.runInteractive('integrate');
      await session.waitText('Select the tool you want to integrate with');
      session.keyCtrlC();
      const result = await session.waitFinish();

      expect(result.stderr).toContain(
        'Both Claude Code and Copilot were detected on this machine. Integrating with both may cause conflicts in hook execution.',
      );
    },
    { timeout: 15000 },
  );
});
