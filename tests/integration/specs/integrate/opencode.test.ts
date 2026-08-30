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
 * Inc., 51 Franklin Street, Fifth Floor, Boston, MA 02110-1301, USA.
 */

import { readFileSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { CONTEXT_AUGMENTATION_FEATURE_ID } from '@/commands/integrate/_common/features/context-augmentation-feature.ts';
import { SQAA_INSTRUCTIONS_SUBFEATURE_ID } from '@/commands/integrate/_common/features/sqaa-instructions-feature.ts';
import {
  VORTEX_FEATURE_ID,
  VORTEX_GLOBAL_SKIP_MESSAGE,
} from '@/commands/integrate/_common/vortex.ts';
import { openCodeIntegration } from '@/commands/integrate/opencode/declaration.ts';

import { TestHarness } from '../../harness';
import { findInstalledFeature, findInstalledSubfeature } from './state-helpers';

const OPENCODE_CONFIG_DIRS = ['opencode.json'];
const GLOBAL_OPENCODE_CONFIG_DIRS = ['.config', 'opencode', 'opencode.json'];
const OPENCODE_CAG_SKILL_PATH = ['.opencode', 'skills', 'sonar-context-augmentation', 'SKILL.md'];
const TEST_ORG = 'test-org';
const TEST_PROJECT = 'test-project';

interface OpenCodeConfig {
  mcp?: Record<string, { type?: string; command?: string[] }>;
  [key: string]: unknown;
}

function mcpCommand(config: OpenCodeConfig): string[] {
  const command = config.mcp?.sonarqube?.command;
  if (!Array.isArray(command)) throw new Error('Expected the SonarQube MCP command');
  return command;
}

describe('integrate opencode', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
    const server = await harness.newFakeServer().withAuthToken('tok').start();
    harness.withAuth(server.baseUrl(), 'tok');
  });

  afterEach(async () => {
    await harness.dispose();
  });

  async function configureEntitledVortex() {
    const server = await harness
      .newFakeServer()
      .withAuthToken('cloud-token')
      .withOrganizations([{ key: TEST_ORG, name: 'Test Org' }])
      .withVortexEntitlement(TEST_ORG, 'test-uuid-1234')
      .withProject(TEST_PROJECT)
      .start();
    const serverUrl = server.baseUrl();
    harness.withAuth(serverUrl, 'cloud-token', TEST_ORG);
    harness.state().withContextAugmentationBinaryInstalled();
    return {
      SONARQUBE_CLI_SONARCLOUD_URL: serverUrl,
      SONARQUBE_CLI_SONARCLOUD_API_URL: serverUrl,
    };
  }

  it('is listed in sonar integrate --help', async () => {
    const result = await harness.run('integrate --help');

    expect(result.stdout).toContain('opencode [options]');
    expect(result.stdout).toContain('Setup SonarQube integration for OpenCode. This will');

    const commandHelp = await harness.run('integrate opencode --help');
    expect(commandHelp.stdout).toContain('Install config globally to ~/.config/opencode instead');
  });

  it(
    'writes the native local MCP server to project opencode.json and records its state',
    async () => {
      const result = await harness.run('integrate opencode --project my-project --non-interactive');

      expect(result.exitCode).toBe(0);
      const config: OpenCodeConfig = harness.cwd.file(...OPENCODE_CONFIG_DIRS).asJson();
      expect(config.mcp?.sonarqube).toMatchObject({ type: 'local' });
      expect(mcpCommand(config)).toContain('run');
      expect(mcpCommand(config)).toContain('mcp');
      expect(mcpCommand(config)).toContain('--project');
      expect(mcpCommand(config)).toContain('my-project');
      expect(findInstalledFeature(harness, 'opencode', 'mcp-server', 'project')).toMatchObject({
        resources: [
          {
            id: 'opencode-mcp-config',
            resourceType: 'json-patch',
            path: harness.cwd.file(...OPENCODE_CONFIG_DIRS).path,
          },
        ],
      });
    },
    { timeout: 30000 },
  );

  it(
    'writes the global config under ~/.config/opencode without project arguments',
    async () => {
      const result = await harness.run('integrate opencode --global --non-interactive');

      expect(result.exitCode).toBe(0);
      expect(harness.cwd.exists(...OPENCODE_CONFIG_DIRS)).toBe(false);
      const config: OpenCodeConfig = harness.userHome.file(...GLOBAL_OPENCODE_CONFIG_DIRS).asJson();
      expect(config.mcp?.sonarqube).toMatchObject({ type: 'local' });
      expect(mcpCommand(config)).toContain('run');
      expect(mcpCommand(config)).toContain('mcp');
      expect(mcpCommand(config)).not.toContain('--project');
      expect(findInstalledFeature(harness, 'opencode', 'mcp-server', 'global')).toMatchObject({
        resources: [
          {
            id: 'opencode-mcp-config',
            resourceType: 'json-patch',
            path: harness.userHome.file(...GLOBAL_OPENCODE_CONFIG_DIRS).path,
          },
        ],
      });
    },
    { timeout: 30000 },
  );

  it(
    'replaces only a stale Sonar entry and preserves unrelated config',
    async () => {
      harness.cwd.writeFile(
        'opencode.json',
        JSON.stringify({
          model: 'custom-model',
          mcp: {
            other: { type: 'remote' },
            sonarqube: { type: 'local', command: ['stale'] },
          },
        }),
      );

      const result = await harness.run('integrate opencode --project my-project --non-interactive');

      expect(result.exitCode).toBe(0);
      const config: OpenCodeConfig = harness.cwd.file(...OPENCODE_CONFIG_DIRS).asJson();
      expect(config.model).toBe('custom-model');
      expect(config.mcp?.other).toEqual({ type: 'remote' });
      expect(mcpCommand(config)).not.toContain('stale');
      expect(mcpCommand(config)).toContain('run');
      expect(mcpCommand(config)).toContain('mcp');
      expect(mcpCommand(config)).toContain('--project');
      expect(mcpCommand(config)).toContain('my-project');
    },
    { timeout: 30000 },
  );

  it(
    'is idempotent',
    async () => {
      await harness.run('integrate opencode --non-interactive');
      const firstBody = harness.cwd.file(...OPENCODE_CONFIG_DIRS).asText();

      const result = await harness.run('integrate opencode --non-interactive');

      expect(result.exitCode).toBe(0);
      expect(harness.cwd.file(...OPENCODE_CONFIG_DIRS).asText()).toBe(firstBody);
    },
    { timeout: 30000 },
  );

  it(
    'replays the Sonar MCP entry after an upgrade while preserving unrelated config',
    async () => {
      await harness.run('integrate opencode --project my-project --non-interactive');
      harness.cwd.writeFile(
        'opencode.json',
        JSON.stringify({
          model: 'custom-model',
          mcp: {
            other: { type: 'remote' },
            sonarqube: { type: 'local', command: ['stale'] },
          },
        }),
      );
      const state = harness.stateJsonFile.asJson();
      state.config.cliVersion = '0.0.1';
      harness.state().withRawState(JSON.stringify(state));

      const result = await harness.run('--version');

      expect(result.exitCode).toBe(0);
      const config: OpenCodeConfig = harness.cwd.file(...OPENCODE_CONFIG_DIRS).asJson();
      expect(config.model).toBe('custom-model');
      expect(config.mcp?.other).toEqual({ type: 'remote' });
      expect(mcpCommand(config)).not.toContain('stale');
      expect(mcpCommand(config)).toContain('run');
      expect(mcpCommand(config)).toContain('--project');
      expect(mcpCommand(config)).toContain('my-project');
    },
    { timeout: 30000 },
  );

  it(
    'removes only the Sonar MCP entry when declined interactively',
    async () => {
      harness.cwd.writeFile(
        'opencode.json',
        JSON.stringify({
          model: 'custom-model',
          mcp: {
            other: { type: 'remote' },
            sonarqube: { type: 'local', command: ['stale'] },
          },
        }),
      );
      harness
        .state()
        .withInstalledIntegrationFeature(
          openCodeIntegration,
          'mcp-server',
          'project',
          harness.cwd.path,
        );

      const result = await harness.run('integrate opencode --project my-project', {
        stdinChunks: ['n', '\r'],
      });

      expect(result.exitCode).toBe(0);
      const config: OpenCodeConfig = harness.cwd.file(...OPENCODE_CONFIG_DIRS).asJson();
      expect(config.model).toBe('custom-model');
      expect(config.mcp?.other).toEqual({ type: 'remote' });
      expect(config.mcp?.sonarqube).toBeUndefined();
      expect(findInstalledFeature(harness, 'opencode', 'mcp-server')).toBeUndefined();
    },
    { timeout: 30000 },
  );

  it(
    'fails safely when opencode.json contains invalid JSON',
    async () => {
      harness.cwd.writeFile('opencode.json', '{ invalid json');

      const result = await harness.run('integrate opencode --non-interactive');

      expect(result.exitCode).toBe(1);
      expect(`${result.stdout}\n${result.stderr}`).toContain('opencode.json contains invalid JSON');
    },
    { timeout: 30000 },
  );

  describe('Vortex instructions and Context Augmentation', () => {
    it(
      'writes managed AGENTS.md instructions and the native skill when entitled',
      async () => {
        const extraEnv = await configureEntitledVortex();
        harness.cwd.writeFile('AGENTS.md', '# Project instructions\n');

        const result = await harness.run(
          `integrate opencode --project ${TEST_PROJECT} --non-interactive`,
          { extraEnv },
        );

        expect(result.exitCode).toBe(0);
        const agents = harness.cwd.file('AGENTS.md').asText();
        expect(agents).toContain('# Project instructions');
        expect(agents).toContain('# Vortex analysis protocol');
        expect(agents).toContain(`sonar analyze agentic --project ${TEST_PROJECT} --depth DEEP`);
        expect(harness.cwd.file(...OPENCODE_CAG_SKILL_PATH).asText()).toContain(
          '# Generated CAG skill',
        );
        expect(
          findInstalledSubfeature(
            harness,
            'opencode',
            VORTEX_FEATURE_ID,
            SQAA_INSTRUCTIONS_SUBFEATURE_ID,
          ),
        ).toBeDefined();
        expect(
          findInstalledSubfeature(
            harness,
            'opencode',
            VORTEX_FEATURE_ID,
            CONTEXT_AUGMENTATION_FEATURE_ID,
          ),
        ).toBeDefined();
      },
      { timeout: 30000 },
    );

    it(
      'skips Vortex when the org is not entitled',
      async () => {
        const result = await harness.run(
          'integrate opencode --project my-project --non-interactive',
        );

        expect(result.exitCode).toBe(0);
        expect(harness.cwd.exists('AGENTS.md')).toBe(false);
        expect(harness.cwd.exists(...OPENCODE_CAG_SKILL_PATH)).toBe(false);
        expect(findInstalledFeature(harness, 'opencode', VORTEX_FEATURE_ID)).toBeUndefined();
      },
      { timeout: 30000 },
    );

    it(
      'skips Vortex globally when entitled',
      async () => {
        const extraEnv = await configureEntitledVortex();

        const result = await harness.run('integrate opencode --global --non-interactive', {
          extraEnv,
        });

        expect(result.exitCode).toBe(0);
        expect(harness.userHome.exists('AGENTS.md')).toBe(false);
        expect(harness.userHome.exists(...OPENCODE_CAG_SKILL_PATH)).toBe(false);
        expect(
          findInstalledFeature(harness, 'opencode', VORTEX_FEATURE_ID, 'global'),
        ).toBeUndefined();
        expect(`${result.stdout}\n${result.stderr}`).toContain(VORTEX_GLOBAL_SKIP_MESSAGE);
      },
      { timeout: 30000 },
    );

    it(
      'skips Vortex without a project key when entitled',
      async () => {
        const extraEnv = await configureEntitledVortex();

        const result = await harness.run('integrate opencode --non-interactive', { extraEnv });

        expect(result.exitCode).toBe(0);
        expect(harness.cwd.exists('AGENTS.md')).toBe(false);
        expect(harness.cwd.exists(...OPENCODE_CAG_SKILL_PATH)).toBe(false);
        expect(findInstalledFeature(harness, 'opencode', VORTEX_FEATURE_ID)).toBeUndefined();
      },
      { timeout: 30000 },
    );

    it(
      'is idempotent and removes only CLI-owned OpenCode artifacts on reset',
      async () => {
        const extraEnv = await configureEntitledVortex();
        harness.cwd.writeFile('AGENTS.md', '# Project instructions\n');
        harness.cwd.writeFile(
          'opencode.json',
          JSON.stringify({ model: 'custom-model', mcp: { other: { type: 'remote' } } }),
        );
        const command = `integrate opencode --project ${TEST_PROJECT} --non-interactive`;

        await harness.run(command, { extraEnv });
        const firstAgents = harness.cwd.file('AGENTS.md').asText();
        const second = await harness.run(command, { extraEnv });

        expect(second.exitCode).toBe(0);
        expect(harness.cwd.file('AGENTS.md').asText()).toBe(firstAgents);
        expect(firstAgents.match(/# Vortex analysis protocol/g)?.length).toBe(1);
        const stateAfterIntegrate = readFileSync(harness.stateJsonFile.path, 'utf-8');
        harness.state().withRawState(stateAfterIntegrate);

        const reset = await harness.run('system reset --force');

        expect(reset.exitCode).toBe(0);
        expect(harness.cwd.file('AGENTS.md').asText()).toBe('# Project instructions\n');
        expect(harness.cwd.exists(...OPENCODE_CAG_SKILL_PATH)).toBe(false);
        const config: OpenCodeConfig = harness.cwd.file(...OPENCODE_CONFIG_DIRS).asJson();
        expect(config).toEqual({ model: 'custom-model', mcp: { other: { type: 'remote' } } });
      },
      { timeout: 60000 },
    );
  });
});
