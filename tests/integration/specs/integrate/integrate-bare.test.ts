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
      const result = await session.finish();

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('No integration selected');
    },
    { timeout: 15000 },
  );

  it(
    'rejects conflicting --project and --global before prompting',
    async () => {
      const server = await harness.newFakeServer().withAuthToken('test-token').start();
      harness.withAuth(server.baseUrl(), 'test-token');

      const result = await harness.run('integrate --project foo --global');

      expect(result.exitCode).toBe(2);
      const output = result.stdout + result.stderr;
      expect(output).toContain('--global and --project are mutually exclusive');
      // The conflict is caught up front, before the tool-selection prompt renders.
      expect(output).not.toContain('Select the tool you want to integrate with');
    },
    { timeout: 15000 },
  );

  it(
    'runs only the single selected integration',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('test-token')
        .withProject('my-project')
        .start();
      harness.withAuth(server.baseUrl(), 'test-token');
      harness.cwd.writeFile(
        'sonar-project.properties',
        [`sonar.host.url=${server.baseUrl()}`, 'sonar.projectKey=my-project'].join('\n'),
      );

      // Single-select: the cursor starts on Claude (index 0); Enter confirms it.
      const session = harness.runInteractive('integrate');
      await session.waitText('Select the tool you want to integrate with');
      session.keyEnter();
      await session.waitText('Where should SonarQube be integrated?');
      session.keyEnter();
      await session.waitText('Install secret scanning hooks?');
      session.keyEnter();
      await session.waitText('Install MCP server?');
      session.keyEnter();
      const result = await session.finish();
      const output = result.stdout + result.stderr;

      expect(result.exitCode).toBe(0);
      expect(output).toContain('SonarQube Integration Setup for Claude Code');
      expect(output.split('Setup complete!').length - 1).toBe(1);

      expect(harness.cwd.exists('.claude', 'settings.json')).toBe(true);
      expect(
        harness.cwd.exists(
          '.claude',
          'hooks',
          'sonar-secrets',
          'build-scripts',
          hookScriptName('pretool-secrets'),
        ),
      ).toBe(true);
      expect(harness.cwd.exists('.mcp.json')).toBe(true);
    },
    { timeout: 30000 },
  );

  it(
    'forwards --global to the selected integration',
    async () => {
      const server = await harness.newFakeServer().withAuthToken('test-token').start();
      harness.withAuth(server.baseUrl(), 'test-token');

      // --global is passed through to the integration: scope prompt is skipped and
      // the integration installs at global scope.
      const session = harness.runInteractive('integrate --global');
      await session.waitText('Select the tool you want to integrate with');
      session.keyEnter();
      await session.waitText('Install secret scanning hooks?');
      session.keyEnter();
      await session.waitText('Install MCP server?');
      session.keyEnter();
      const result = await session.finish();

      expect(result.exitCode).toBe(0);
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
    'forwards --project to the selected integration',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('test-token')
        .withProject('my-project')
        .start();
      harness.withAuth(server.baseUrl(), 'test-token');

      // -p is passed through to the integration: scope prompt is skipped (explicit
      // project key implies project scope) and the key is baked into the install.
      const session = harness.runInteractive('integrate --project my-project');
      await session.waitText('Select the tool you want to integrate with');
      session.keyEnter();
      await session.waitText('Install secret scanning hooks?');
      session.keyEnter();
      await session.waitText('Install MCP server?');
      session.keyEnter();
      const result = await session.finish();

      expect(result.exitCode).toBe(0);
      const feature = findInstalledFeature(harness, 'claude-code', 'sonar-secrets-hooks');
      expect(feature?.scope).toBe('project');
      expect(feature?.attrs).toMatchObject({ projectKey: 'my-project' });
      expect(harness.cwd.exists('.claude', 'settings.json')).toBe(true);
      expect(
        harness.cwd.exists(
          '.claude',
          'hooks',
          'sonar-secrets',
          'build-scripts',
          hookScriptName('pretool-secrets'),
        ),
      ).toBe(true);
    },
    { timeout: 30000 },
  );
});
