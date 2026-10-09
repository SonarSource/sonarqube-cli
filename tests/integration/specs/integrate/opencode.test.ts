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

// Integration tests for `sonar integrate opencode`'s MCP server feature.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import {
  CONTEXT_AUGMENTATION_FEATURE_ID,
  CONTEXT_AUGMENTATION_INSTRUCTIONS_BODY,
} from '@/commands/integrate/_common/features/context-augmentation-feature.ts';
import {
  SQAA_HOOK_FEATURE_ID,
  SQAA_INSTRUCTIONS_SUBFEATURE_ID,
} from '@/commands/integrate/_common/features/sqaa-instructions-feature.ts';
import { VORTEX_FEATURE_ID } from '@/commands/integrate/_common/vortex.ts';
import { openCodeIntegration } from '@/commands/integrate/opencode/declaration.ts';
import type { CliState } from '@/core/state/state.ts';

import { type CliResult, TestHarness } from '../../harness';
import { readCagInvocations } from '../../harness/cag-helpers';
import { findInstalledFeature, findInstalledSubfeature } from './state-helpers';

const TEST_ORG = 'my-org';
const TEST_PROJECT = 'my-project';

function findOpenCodeFeature(harness: TestHarness, featureId: string, scope?: string) {
  return findInstalledFeature(harness, 'opencode', featureId, scope);
}

interface OpenCodeMcpEntry {
  type?: string;
  command?: string[];
  environment?: Record<string, string>;
  enabled?: boolean;
}

interface OpenCodeConfig {
  $schema?: string;
  mcp?: Record<string, OpenCodeMcpEntry>;
  [key: string]: unknown;
}

function readOpenCodeConfig(harness: TestHarness): OpenCodeConfig {
  return harness.userHome.file('.config', 'opencode', 'opencode.json').asJson() as OpenCodeConfig;
}

describe('integrate opencode — MCP server configuration', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
    harness.state().withSecretsBinaryInstalled();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it(
    'writes the sonarqube MCP server entry to $HOME/.config/opencode/opencode.json (global scope)',
    async () => {
      const server = await harness.newFakeServer().withAuthToken('tok').withProject('proj').start();
      harness.withAuth(server.baseUrl(), 'tok');
      harness.cwd.writeFile(
        'sonar-project.properties',
        [`sonar.host.url=${server.baseUrl()}`, 'sonar.projectKey=proj'].join('\n'),
      );

      const result = await harness.run('integrate opencode --non-interactive');

      expect(result.exitCode).toBe(0);
      expect(harness.userHome.exists('.config', 'opencode', 'opencode.json')).toBe(true);

      const config = readOpenCodeConfig(harness);
      expect(config.mcp?.sonarqube).toMatchObject({
        type: 'local',
        command: ['sonar', 'run', 'mcp'],
        enabled: true,
      });
      // mcpServers (the generic key) must never be used for OpenCode.
      expect((config as { mcpServers?: unknown }).mcpServers).toBeUndefined();

      // Project directory must not receive the MCP config on a global install.
      expect(harness.cwd.exists('opencode.json')).toBe(false);

      expect(findOpenCodeFeature(harness, 'mcp-server', 'global')).toBeDefined();
    },
    { timeout: 30000 },
  );

  it(
    'preserves existing opencode.json keys and other MCP entries when installing',
    async () => {
      const server = await harness.newFakeServer().withAuthToken('tok').withProject('proj').start();
      harness.withAuth(server.baseUrl(), 'tok');
      harness.cwd.writeFile(
        'sonar-project.properties',
        [`sonar.host.url=${server.baseUrl()}`, 'sonar.projectKey=proj'].join('\n'),
      );
      harness.userHome.writeFile(
        '.config/opencode/opencode.json',
        JSON.stringify({
          $schema: 'https://opencode.ai/config.json',
          theme: 'dark',
          mcp: { other: { type: 'local', command: ['other-mcp'], enabled: true } },
        }),
      );

      const result = await harness.run('integrate opencode --non-interactive');

      expect(result.exitCode).toBe(0);
      const config = readOpenCodeConfig(harness);
      expect(config.$schema).toBe('https://opencode.ai/config.json');
      expect(config.theme).toBe('dark');
      expect(config.mcp?.other).toMatchObject({ type: 'local', command: ['other-mcp'] });
      expect(config.mcp?.sonarqube).toMatchObject({ type: 'local', enabled: true });
    },
    { timeout: 30000 },
  );

  it(
    'leaves an existing opencode.jsonc untouched',
    async () => {
      const server = await harness.newFakeServer().withAuthToken('tok').withProject('proj').start();
      harness.withAuth(server.baseUrl(), 'tok');
      harness.cwd.writeFile(
        'sonar-project.properties',
        [`sonar.host.url=${server.baseUrl()}`, 'sonar.projectKey=proj'].join('\n'),
      );
      const jsoncContent = '{\n  // user comment\n  "theme": "dark",\n}\n';
      harness.userHome.writeFile('.config/opencode/opencode.jsonc', jsoncContent);

      const result = await harness.run('integrate opencode --non-interactive');

      expect(result.exitCode).toBe(0);
      expect(harness.userHome.file('.config', 'opencode', 'opencode.jsonc').asText()).toBe(
        jsoncContent,
      );
      expect(harness.userHome.exists('.config', 'opencode', 'opencode.json')).toBe(true);
    },
    { timeout: 30000 },
  );

  it(
    'records the mcp-server feature with a single json-patch resource in state',
    async () => {
      const server = await harness.newFakeServer().withAuthToken('tok').withProject('proj').start();
      harness.withAuth(server.baseUrl(), 'tok');
      harness.cwd.writeFile(
        'sonar-project.properties',
        [`sonar.host.url=${server.baseUrl()}`, 'sonar.projectKey=proj'].join('\n'),
      );

      const result = await harness.run('integrate opencode --non-interactive');

      expect(result.exitCode).toBe(0);
      const mcpFeature = findOpenCodeFeature(harness, 'mcp-server', 'global');
      expect(mcpFeature).toMatchObject({
        resources: [
          {
            id: 'mcp-config',
            resourceType: 'json-patch',
            path: harness.userHome.file('.config', 'opencode', 'opencode.json').path,
          },
        ],
        operations: [],
      });
    },
    { timeout: 30000 },
  );
});

describe('integrate opencode — Vortex SQAA feature', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
    harness.state().withSecretsBinaryInstalled();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it(
    'writes the SQAA plugin and the AGENTS.md protocol when Vortex is entitled',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('cloud-token')
        .withOrganizations([{ key: TEST_ORG, name: 'My Org' }])
        .withVortexEntitlement(TEST_ORG, 'test-uuid-1234')
        .withProject(TEST_PROJECT)
        .start();
      const serverUrl = server.baseUrl();
      harness.withAuth(serverUrl, 'cloud-token', TEST_ORG);

      const result = await harness.run('integrate opencode --non-interactive', {
        extraEnv: {
          SONARQUBE_CLI_SONARCLOUD_URL: serverUrl,
          SONARQUBE_CLI_SONARCLOUD_API_URL: serverUrl,
        },
      });

      expect(result.exitCode).toBe(0);
      const plugin = harness.userHome.file('.config', 'opencode', 'plugins', 'sonar-sqaa.ts');
      expect(plugin.exists()).toBe(true);
      expect(plugin.asText()).toContain('opencode-post-tool-use');
      const agentsMd = harness.userHome.file('.config', 'opencode', 'AGENTS.md').asText();
      expect(agentsMd).toContain('<!-- sonar:begin:sonarqube-agentic-analysis-protocol -->');
      expect(agentsMd).toContain('# Vortex analysis protocol');
      expect(agentsMd).toContain('sonar analyze agentic --depth DEEP');
      expect(
        findInstalledSubfeature(harness, 'opencode', VORTEX_FEATURE_ID, SQAA_HOOK_FEATURE_ID),
      ).toBeDefined();
      expect(
        findInstalledSubfeature(
          harness,
          'opencode',
          VORTEX_FEATURE_ID,
          SQAA_INSTRUCTIONS_SUBFEATURE_ID,
        ),
      ).toBeDefined();
    },
    { timeout: 30000 },
  );

  it(
    'does not install Vortex when the organization is not entitled',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('cloud-token')
        .withOrganizations([{ key: TEST_ORG, name: 'My Org' }])
        .withProject(TEST_PROJECT)
        .start();
      const serverUrl = server.baseUrl();
      harness.withAuth(serverUrl, 'cloud-token', TEST_ORG);

      const result = await harness.run('integrate opencode --non-interactive', {
        extraEnv: {
          SONARQUBE_CLI_SONARCLOUD_URL: serverUrl,
          SONARQUBE_CLI_SONARCLOUD_API_URL: serverUrl,
        },
      });

      expect(result.exitCode).toBe(0);
      expect(harness.userHome.exists('.config', 'opencode', 'plugins', 'sonar-sqaa.ts')).toBe(
        false,
      );
      expect(findOpenCodeFeature(harness, VORTEX_FEATURE_ID)).toBeUndefined();
    },
    { timeout: 30000 },
  );
});

describe('integrate opencode — Vortex Context feature', () => {
  let harness: TestHarness;
  const skillRelativePath = ['.config', 'opencode', 'skills', 'sonar-context-augmentation'];
  const runEnv = (serverUrl: string) => ({
    SONARQUBE_CLI_SONARCLOUD_URL: serverUrl,
    SONARQUBE_CLI_SONARCLOUD_API_URL: serverUrl,
  });

  async function startEntitledServer() {
    const server = await harness
      .newFakeServer()
      .withAuthToken('cloud-token')
      .withOrganizations([{ key: TEST_ORG, name: 'My Org' }])
      .withVortexEntitlement(TEST_ORG, 'test-uuid-1234')
      .withProject(TEST_PROJECT)
      .withScaEnabled(true)
      .start();
    harness.withAuth(server.baseUrl(), 'cloud-token', TEST_ORG);
    return server.baseUrl();
  }

  beforeEach(async () => {
    harness = await TestHarness.create();
    harness.state().withSecretsBinaryInstalled();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it(
    'writes the skill and the AGENTS.md instructions rendered by the Context binary',
    async () => {
      harness.state().withContextAugmentationBinaryInstalled();
      const serverUrl = await startEntitledServer();

      const result = await harness.run('integrate opencode --non-interactive', {
        extraEnv: runEnv(serverUrl),
      });

      expect(result.exitCode).toBe(0);
      const skill = harness.userHome.file(...skillRelativePath, 'SKILL.md');
      expect(skill.asText()).toContain('# Generated CAG skill');
      expect(skill.asText()).toContain('--sca-enabled=true');
      const printSkill = readCagInvocations(harness).find(
        (invocation) => invocation.argv[1] === 'print-skill',
      );
      expect(printSkill?.argv).toContain('sonar context');
      const agentsMd = harness.userHome.file('.config', 'opencode', 'AGENTS.md').asText();
      expect(agentsMd).toContain('<!-- sonar:begin:sonar-context-augmentation-protocol -->');
      expect(agentsMd).toContain(CONTEXT_AUGMENTATION_INSTRUCTIONS_BODY.trim());
      expect(agentsMd).toContain('<!-- sonar:begin:sonarqube-agentic-analysis-protocol -->');
      expect(
        findInstalledSubfeature(
          harness,
          'opencode',
          VORTEX_FEATURE_ID,
          CONTEXT_AUGMENTATION_FEATURE_ID,
        ),
      ).toBeDefined();
      expect(harness.userHome.exists('.config', 'opencode', 'plugins', 'sonar-cag.ts')).toBe(false);
    },
    { timeout: 30000 },
  );

  it(
    'fails and writes no skill when the Context binary renders an empty skill',
    async () => {
      harness.state().withContextAugmentationBinaryInstalled({ printSkillEmpty: true });
      const serverUrl = await startEntitledServer();

      const result = await harness.run('integrate opencode --non-interactive', {
        extraEnv: runEnv(serverUrl),
      });

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain(
        'sonar-context-augmentation tool print-skill produced empty output',
      );
      expect(result.stderr).toContain('Vortex Context skill generation failed.');
      expect(harness.userHome.exists(...skillRelativePath, 'SKILL.md')).toBe(false);
    },
    { timeout: 30000 },
  );

  it(
    'reports the Context binary output when print-skill fails',
    async () => {
      harness.state().withContextAugmentationBinaryInstalled({ printSkillExitCode: 1 });
      const serverUrl = await startEntitledServer();

      const result = await harness.run('integrate opencode --non-interactive', {
        extraEnv: runEnv(serverUrl),
      });

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('stub print-skill failure');
      expect(result.stderr).toContain('Vortex Context skill generation failed.');
      expect(harness.userHome.exists(...skillRelativePath, 'SKILL.md')).toBe(false);
    },
    { timeout: 30000 },
  );

  it(
    'removes the skill and only its own AGENTS.md lines when entitlement is lost',
    async () => {
      harness.state().withContextAugmentationBinaryInstalled();
      const serverUrl = await startEntitledServer();
      harness.userHome.writeFile('.config/opencode/AGENTS.md', '# My own rules\n');
      const installed = await harness.run('integrate opencode --non-interactive', {
        extraEnv: runEnv(serverUrl),
      });
      expect(installed.exitCode).toBe(0);
      expect(harness.userHome.exists(...skillRelativePath, 'SKILL.md')).toBe(true);

      const persistedState = harness.stateJsonFile.asJson() as CliState;
      const unentitledServer = await harness
        .newFakeServer()
        .withAuthToken('cloud-token')
        .withOrganizations([{ key: TEST_ORG, name: 'My Org' }])
        .withVortexEntitlement(TEST_ORG, 'test-uuid-1234', {
          allowed: false,
          hasEntitlement: false,
        })
        .withProject(TEST_PROJECT)
        .start();
      harness.withAuth(unentitledServer.baseUrl(), 'cloud-token', TEST_ORG);
      const activeConnection = persistedState.auth.connections.find(
        (connection) => connection.id === persistedState.auth.activeConnectionId,
      );
      if (activeConnection) activeConnection.serverUrl = unentitledServer.baseUrl();
      harness.state().withRawState(JSON.stringify(persistedState));
      harness.state().withContextAugmentationBinaryInstalled();
      const removed = await harness.run('integrate opencode --non-interactive', {
        extraEnv: runEnv(unentitledServer.baseUrl()),
      });

      expect(removed.exitCode).toBe(0);
      expect(harness.userHome.exists(...skillRelativePath, 'SKILL.md')).toBe(false);
      const agentsMd = harness.userHome.file('.config', 'opencode', 'AGENTS.md').asText();
      expect(agentsMd).toContain('# My own rules');
      expect(agentsMd).not.toContain('sonar-context-augmentation-protocol');
      expect(findOpenCodeFeature(harness, VORTEX_FEATURE_ID)).toBeUndefined();
    },
    { timeout: 30000 },
  );
});

// ─── Keep / remove the MCP server feature on re-run ────────────────────────────

describe('integrate opencode — keep/remove the mcp-server feature', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
    harness.state().withSecretsBinaryInstalled();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  function seedInstalledFeatures(): void {
    harness
      .state()
      .withInstalledIntegrationFeature(
        openCodeIntegration,
        'sonar-secrets-hooks',
        'global',
        harness.userHome.path,
      )
      .withInstalledIntegrationFeature(
        openCodeIntegration,
        'mcp-server',
        'global',
        harness.userHome.path,
      );
    harness.userHome.writeFile(
      '.config/opencode/opencode.json',
      JSON.stringify({
        theme: 'dark',
        mcp: {
          other: { type: 'local', command: ['other-mcp'], enabled: true },
          sonarqube: { type: 'local', command: ['sonar', 'run', 'mcp'], enabled: true },
        },
      }),
    );
  }

  it(
    'removes only the sonarqube MCP entry when the user declines to keep it, preserving other keys',
    async () => {
      const server = await harness.newFakeServer().withAuthToken('tok').withProject('proj').start();
      harness.withAuth(server.baseUrl(), 'tok');
      seedInstalledFeatures();
      harness.cwd.writeFile(
        'sonar-project.properties',
        [`sonar.host.url=${server.baseUrl()}`, 'sonar.projectKey=proj'].join('\n'),
      );

      const session = harness.runInteractive('integrate opencode');
      await session.accept('secret scanning hooks (currently installed)  Keep?');
      await session.decline('MCP server (currently installed)  Keep?');
      await session.accept('Proceed with removal?');
      const result: CliResult = await session.waitFinish();

      expect(result.exitCode).toBe(0);
      const output = `${result.stdout}\n${result.stderr}`;
      expect(output).toContain('Removed');

      expect(findOpenCodeFeature(harness, 'mcp-server')).toBeUndefined();
      expect(findOpenCodeFeature(harness, 'sonar-secrets-hooks')).toBeDefined();

      const config = readOpenCodeConfig(harness);
      expect(config.mcp?.sonarqube).toBeUndefined();
      expect(config.mcp?.other).toMatchObject({ type: 'local', command: ['other-mcp'] });
      expect(config.theme).toBe('dark');
    },
    { timeout: 30000 },
  );

  it(
    'keeps installed features without prompting or removing in non-interactive mode',
    async () => {
      const server = await harness.newFakeServer().withAuthToken('tok').withProject('proj').start();
      harness.withAuth(server.baseUrl(), 'tok');
      seedInstalledFeatures();
      harness.cwd.writeFile(
        'sonar-project.properties',
        [`sonar.host.url=${server.baseUrl()}`, 'sonar.projectKey=proj'].join('\n'),
      );

      const result = await harness.run('integrate opencode --non-interactive');

      expect(result.exitCode).toBe(0);
      const output = `${result.stdout}\n${result.stderr}`;
      expect(output).not.toContain('Keep?');
      expect(output).not.toContain('Removing');

      expect(findOpenCodeFeature(harness, 'mcp-server')).toBeDefined();
      const config = readOpenCodeConfig(harness);
      expect(config.mcp?.sonarqube).toBeDefined();
    },
    { timeout: 30000 },
  );
});
