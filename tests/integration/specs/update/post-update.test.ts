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

// Integration tests for post-update migration (runPostUpdateActions)

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { CONTEXT_AUGMENTATION_FEATURE_ID } from '@/commands/integrate/_common/features/context-augmentation-feature.ts';
import { MCP_CONFIG_RESOURCE_ID } from '@/commands/integrate/_common/features/mcp-server-feature.ts';
import {
  SQAA_HOOK_FEATURE_ID,
  SQAA_INSTRUCTIONS_SUBFEATURE_ID,
} from '@/commands/integrate/_common/features/sqaa-instructions-feature.ts';
import { VORTEX_FEATURE_ID } from '@/commands/integrate/_common/vortex.ts';
import {
  CLAUDE_INTEGRATION_ID,
  CONTEXT_AUGMENTATION_HOOK_FEATURE_ID,
} from '@/commands/integrate/claude/declaration.ts';
import { CODEX_INTEGRATION_ID } from '@/commands/integrate/codex/declaration.ts';
import { COPILOT_INTEGRATION_ID } from '@/commands/integrate/copilot/declaration.ts';
import { CURSOR_INTEGRATION_ID } from '@/commands/integrate/cursor/declaration.ts';
import { detectPlatform } from '@/core/host/environment/platform-detector.ts';
import { buildLocalCagBinaryName } from '@/core/host/install/context-augmentation.ts';
import { CONTEXT_AUGMENTATION_BINARY_NAME } from '@/core/host/install/install-types.ts';
import { SONAR_CONTEXT_AUGMENTATION_VERSION } from '@/core/host/install/signatures.ts';
import type { CliState, InstalledIntegrationFeature } from '@/core/state/state.ts';

import { version as CURRENT_VERSION } from '../../../../package.json';
import { POST_UPDATE_TRIGGER_COMMAND } from '../../../_common/isolated-cli-env.js';
import { hookScriptName, IS_WINDOWS, TestHarness } from '../../harness';
import { expectVortexHookInstalled, readCagInvocations } from '../../harness/cag-helpers';
import {
  CLAUDE_SKILL_RELATIVE_PATH,
  expectSessionStartHookRefreshed,
  findRecordedCagDependency,
  findRecordedCagFeature,
  findRecordedCagSkillResource,
  findRecordedSessionStartScriptResource,
  seedLegacySkillFile,
  seedState,
  sessionStartScriptPath,
  STALE_CLI_VERSION,
  STALE_SKILL_VERSION,
} from '../../harness/cag-state.ts';

const CAG_HOOK_ALLOWED_ORG_KEY = 'denis-troller-sonar';

describe('post-update migration', () => {
  let harness: TestHarness;

  function seedPreUnificationFeatures(
    integrationId: string,
    featureIds: string[],
    orgKey = 'o',
  ): void {
    const now = new Date().toISOString();
    const legacyFeature = (featureId: string) => ({
      featureId,
      scope: 'project',
      targetRoot: harness.cwd.path,
      installedByCliVersion: '0.5.0',
      installedAt: now,
      updatedByCliVersion: '0.5.0',
      updatedAt: now,
      dependencies: [],
      resources: [],
      operations: [],
      attrs: {
        orgKey,
        projectKey: 'p',
        serverUrl: 'https://sonarcloud.io',
        scaEnabled: false,
      },
    });

    harness.state().withRawState(
      JSON.stringify({
        version: '1.0',
        lastUpdated: now,
        auth: { isAuthenticated: false, connections: [] },
        agents: {},
        config: { cliVersion: '0.5.0' },
        telemetry: { enabled: false, firstUseDate: now, events: [] },
        agentExtensions: [],
        integrations: {
          installed: [
            {
              id: randomUUID(),
              integrationId,
              installedByCliVersion: '0.5.0',
              installedAt: now,
              updatedByCliVersion: '0.5.0',
              updatedAt: now,
              features: featureIds.map(legacyFeature),
            },
          ],
        },
      }),
    );
  }

  function expectFullClaudeVortexMigration(): InstalledIntegrationFeature | undefined {
    const state = harness.stateJsonFile.asJson() as CliState;
    const claude = state.integrations.installed.find(
      (integration) => integration.integrationId === 'claude-code',
    );
    expect(claude?.features.map((feature) => feature.featureId)).toEqual([
      SQAA_HOOK_FEATURE_ID,
      VORTEX_FEATURE_ID,
    ]);
    const postToolUseContainer = claude?.features.find(
      (feature) => feature.featureId === SQAA_HOOK_FEATURE_ID,
    );
    expect(postToolUseContainer?.subfeatures?.map((subfeature) => subfeature.featureId)).toEqual([
      'sqaa-posttooluse',
      'cag-posttooluse',
    ]);
    const vortex = claude?.features.find((feature) => feature.featureId === VORTEX_FEATURE_ID);
    expect(vortex?.subfeatures?.map((subfeature) => subfeature.featureId)).toEqual([
      SQAA_INSTRUCTIONS_SUBFEATURE_ID,
      CONTEXT_AUGMENTATION_FEATURE_ID,
      CONTEXT_AUGMENTATION_HOOK_FEATURE_ID,
    ]);
    expect(harness.cwd.file('.claude', 'settings.json').asJson().hooks?.PostToolUse).toBeDefined();
    expect(harness.cwd.file('CLAUDE.md').asText()).toContain('# Vortex analysis protocol');
    expectVortexHookInstalled(harness.cwd, 'claude');
    return vortex;
  }

  beforeEach(async () => {
    harness = await TestHarness.create();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it(
    're-records resources whose declared id changed, preserving the config file',
    async () => {
      // Older installs recorded `<agent>-mcp-config`; the framework now declares a single
      // `mcp-config` id. Reconciliation must re-record it under the new id without
      // disturbing unrelated entries in the agent's config file.
      const now = new Date().toISOString();
      const mcpJson = harness.cwd.file('.mcp.json');
      const codexToml = harness.cwd.file('.codex', 'config.toml');
      harness.cwd.writeFile(
        '.mcp.json',
        JSON.stringify({
          mcpServers: {
            other: { command: 'other-mcp', args: [] },
            sonarqube: { command: 'sonar', args: ['run', 'mcp'] },
          },
        }),
      );
      harness.cwd.writeFile(
        '.codex/config.toml',
        'model = "gpt-5"\n\n[mcp_servers.sonarqube]\ncommand = "sonar"\nargs = ["run", "mcp"]\n',
      );

      const legacyMcpFeature = (resourceId: string, resourceType: string, path: string) => ({
        featureId: 'mcp-server',
        scope: 'project',
        targetRoot: harness.cwd.path,
        installedByCliVersion: '0.5.0',
        installedAt: now,
        updatedByCliVersion: '0.5.0',
        updatedAt: now,
        dependencies: [],
        operations: [],
        resources: [
          {
            id: resourceId,
            resourceType,
            path,
            updatedByCliVersion: '0.5.0',
            updatedAt: now,
          },
        ],
      });

      harness.state().withRawState(
        JSON.stringify({
          version: '1.0',
          lastUpdated: now,
          auth: { isAuthenticated: false, connections: [] },
          agents: {},
          config: { cliVersion: '0.5.0' },
          telemetry: { enabled: false, firstUseDate: now, events: [] },
          agentExtensions: [],
          integrations: {
            installed: [
              {
                id: randomUUID(),
                integrationId: 'claude-code',
                installedByCliVersion: '0.5.0',
                installedAt: now,
                updatedByCliVersion: '0.5.0',
                updatedAt: now,
                features: [legacyMcpFeature('claude-mcp-config', 'json-patch', mcpJson.path)],
              },
              {
                id: randomUUID(),
                integrationId: 'codex',
                installedByCliVersion: '0.5.0',
                installedAt: now,
                updatedByCliVersion: '0.5.0',
                updatedAt: now,
                features: [legacyMcpFeature('codex-mcp-config', 'toml-patch', codexToml.path)],
              },
            ],
          },
        }),
      );

      const result = await harness.run(POST_UPDATE_TRIGGER_COMMAND);

      expect(result.exitCode).toBe(0);
      const state = harness.stateJsonFile.asJson() as CliState;
      const recordedResources = (integrationId: string) =>
        state.integrations.installed
          .find((integration) => integration.integrationId === integrationId)
          ?.features.find((feature) => feature.featureId === 'mcp-server')?.resources;

      expect(recordedResources('claude-code')).toEqual([
        expect.objectContaining({
          id: MCP_CONFIG_RESOURCE_ID,
          resourceType: 'json-patch',
          path: mcpJson.path,
        }),
      ]);
      expect(recordedResources('codex')).toEqual([
        expect.objectContaining({
          id: MCP_CONFIG_RESOURCE_ID,
          resourceType: 'toml-patch',
          path: codexToml.path,
        }),
      ]);

      // Unrelated settings survive the re-applied patch.
      expect(mcpJson.asJson().mcpServers.other).toEqual({ command: 'other-mcp', args: [] });
      expect(mcpJson.asJson().mcpServers.sonarqube.command).toBe('sonar');
      expect(codexToml.asText()).toContain('model = "gpt-5"');
      expect(codexToml.asText()).toContain('[mcp_servers.sonarqube]');
    },
    { timeout: 30000 },
  );

  it(
    'quits quietly when state cannot be read',
    async () => {
      // A corrupt state file must make post-update a silent no-op rather than
      // crash the CLI or overwrite the file.
      harness.state().withRawState('not-valid-json');

      const result = await harness.run(POST_UPDATE_TRIGGER_COMMAND);

      expect(result.exitCode).toBe(0);
      expect(harness.stateJsonFile.asText()).toBe('not-valid-json');
    },
    { timeout: 15000 },
  );

  it(
    'removes sonar-a3s entries from state.json on CLI upgrade',
    async () => {
      const staleState = {
        version: '1.0',
        lastUpdated: new Date().toISOString(),
        auth: { isAuthenticated: false, connections: [] },
        agents: {
          'claude-code': {
            configured: true,
            configuredByCliVersion: '0.5.0',
            hooks: {
              installed: [
                { name: 'sonar-a3s', type: 'PostToolUse', installedAt: new Date().toISOString() },
                {
                  name: 'sonar-secrets',
                  type: 'PreToolUse',
                  installedAt: new Date().toISOString(),
                },
              ],
            },
            skills: { installed: [] },
          },
        },
        config: { cliVersion: '0.5.0' },
        telemetry: { enabled: false, firstUseDate: new Date().toISOString(), events: [] },
        agentExtensions: [
          {
            id: randomUUID(),
            agentId: 'claude-code',
            projectRoot: harness.cwd.path,
            global: false,
            kind: 'hook',
            name: 'sonar-a3s',
            hookType: 'PostToolUse',
            updatedByCliVersion: '0.5.0',
            updatedAt: new Date().toISOString(),
          },
          {
            id: randomUUID(),
            agentId: 'claude-code',
            projectRoot: harness.cwd.path,
            global: false,
            kind: 'hook',
            name: 'sonar-secrets',
            hookType: 'PreToolUse',
            updatedByCliVersion: '0.5.0',
            updatedAt: new Date().toISOString(),
          },
        ],
      };

      harness.state().withRawState(JSON.stringify(staleState));

      await harness.run(POST_UPDATE_TRIGGER_COMMAND);

      const state = harness.stateJsonFile.asJson();
      const extensions = state.agentExtensions as Array<{ name: string }>;
      const hooks = (state.agents?.['claude-code']?.hooks?.installed ?? []) as Array<{
        name: string;
      }>;

      expect(extensions.some((e) => e.name === 'sonar-a3s')).toBe(false);
      expect(hooks.some((h) => h.name === 'sonar-a3s')).toBe(false);
      // sonar-secrets survives
      expect(extensions.some((e) => e.name === 'sonar-secrets')).toBe(true);
      // cliVersion bumped
      expect((state.config as { cliVersion: string }).cliVersion).toBe(CURRENT_VERSION);
    },
    { timeout: 15000 },
  );

  it(
    'stops running CAG tools and refreshes the Vortex session-start hook after a CLI upgrade',
    async () => {
      const staleCagVersion = '0.0.0.1';
      const installedBinaryPath = harness.cliHome.file(
        'bin',
        buildLocalCagBinaryName(detectPlatform()),
      ).path;
      harness.state().withRawState(
        JSON.stringify({
          version: '1.0',
          lastUpdated: new Date().toISOString(),
          auth: { isAuthenticated: false, connections: [] },
          agents: {
            'claude-code': {
              configured: true,
              configuredByCliVersion: '0.5.0',
              hooks: { installed: [] },
              skills: { installed: [] },
            },
          },
          config: { cliVersion: '0.5.0' },
          telemetry: { enabled: false, firstUseDate: new Date().toISOString(), events: [] },
          dependencies: {
            installed: [
              {
                id: CONTEXT_AUGMENTATION_BINARY_NAME,
                version: staleCagVersion,
                path: installedBinaryPath,
                updatedByCliVersion: '0.5.0',
                updatedAt: new Date().toISOString(),
              },
            ],
          },
          integrations: {
            installed: [
              {
                id: randomUUID(),
                integrationId: 'claude-code',
                installedByCliVersion: '0.5.0',
                installedAt: new Date().toISOString(),
                updatedByCliVersion: '0.5.0',
                updatedAt: new Date().toISOString(),
                features: [
                  {
                    featureId: CONTEXT_AUGMENTATION_FEATURE_ID,
                    scope: 'project',
                    targetRoot: harness.cwd.path,
                    installedByCliVersion: '0.5.0',
                    installedAt: new Date().toISOString(),
                    updatedByCliVersion: '0.5.0',
                    updatedAt: new Date().toISOString(),
                    dependencies: [{ id: CONTEXT_AUGMENTATION_BINARY_NAME }],
                    resources: [],
                    operations: [],
                    attrs: {
                      orgKey: 'o',
                      projectKey: 'p',
                      serverUrl: 'https://sonarcloud.io',
                      scaEnabled: false,
                    },
                  },
                ],
              },
            ],
          },
          agentExtensions: [],
        }),
      );
      // Copies the current-version CAG stub into <cliHome>/bin so the stop step can spawn it.
      harness.state().withContextAugmentationBinaryInstalled();

      await harness.run(POST_UPDATE_TRIGGER_COMMAND);

      const invocations = readCagInvocations(harness);
      expect(
        invocations.some(
          (i) => i.argv[0] === 'tool' && i.argv[1] === 'stop' && i.argv[2] === '--all',
        ),
      ).toBe(true);
      expectVortexHookInstalled(harness.cwd, 'claude');
    },
    { timeout: 30000 },
  );

  it(
    'migrates pre-unification Claude SQAA and CAG features into the Vortex container',
    async () => {
      seedPreUnificationFeatures(
        'claude-code',
        [SQAA_HOOK_FEATURE_ID, SQAA_INSTRUCTIONS_SUBFEATURE_ID, CONTEXT_AUGMENTATION_FEATURE_ID],
        CAG_HOOK_ALLOWED_ORG_KEY,
      );
      harness.state().withContextAugmentationBinaryInstalled();

      const result = await harness.run(POST_UPDATE_TRIGGER_COMMAND);

      expect(result.exitCode).toBe(0);
      const vortex = expectFullClaudeVortexMigration();
      expect(vortex?.scope).toBe('project');
      expect(vortex?.targetRoot).toBe(harness.cwd.path);
      expect(vortex?.attrs).toMatchObject({
        orgKey: CAG_HOOK_ALLOWED_ORG_KEY,
        projectKey: 'p',
        serverUrl: 'https://sonarcloud.io',
        scaEnabled: false,
      });
    },
    { timeout: 30000 },
  );

  it(
    'excludes the CAG PostToolUse and PostToolUseFailure hooks when migrating for a non-allowlisted org',
    async () => {
      seedPreUnificationFeatures('claude-code', [
        SQAA_HOOK_FEATURE_ID,
        SQAA_INSTRUCTIONS_SUBFEATURE_ID,
        CONTEXT_AUGMENTATION_FEATURE_ID,
      ]);
      harness.state().withContextAugmentationBinaryInstalled();

      const result = await harness.run(POST_UPDATE_TRIGGER_COMMAND);

      expect(result.exitCode).toBe(0);
      const state = harness.stateJsonFile.asJson() as CliState;
      const claude = state.integrations.installed.find(
        (integration) => integration.integrationId === 'claude-code',
      );
      const postToolUseContainer = claude?.features.find(
        (feature) => feature.featureId === SQAA_HOOK_FEATURE_ID,
      );
      expect(postToolUseContainer?.subfeatures?.map((subfeature) => subfeature.featureId)).toEqual([
        'sqaa-posttooluse',
      ]);
      const vortex = claude?.features.find((feature) => feature.featureId === VORTEX_FEATURE_ID);
      expect(vortex?.subfeatures?.map((subfeature) => subfeature.featureId)).toEqual([
        SQAA_INSTRUCTIONS_SUBFEATURE_ID,
        CONTEXT_AUGMENTATION_FEATURE_ID,
      ]);
    },
    { timeout: 30000 },
  );

  it(
    'installs every Vortex subfeature when migrating a partial pre-unification install',
    async () => {
      seedPreUnificationFeatures(
        'claude-code',
        [SQAA_INSTRUCTIONS_SUBFEATURE_ID],
        CAG_HOOK_ALLOWED_ORG_KEY,
      );
      harness.state().withContextAugmentationBinaryInstalled();

      const result = await harness.run(POST_UPDATE_TRIGGER_COMMAND);

      expect(result.exitCode).toBe(0);
      const state = harness.stateJsonFile.asJson() as CliState;
      const claude = state.integrations.installed.find(
        (integration) => integration.integrationId === 'claude-code',
      );
      const vortex = claude?.features.find((feature) => feature.featureId === VORTEX_FEATURE_ID);
      expect(vortex?.subfeatures?.map((subfeature) => subfeature.featureId)).toEqual([
        SQAA_INSTRUCTIONS_SUBFEATURE_ID,
        CONTEXT_AUGMENTATION_FEATURE_ID,
        CONTEXT_AUGMENTATION_HOOK_FEATURE_ID,
      ]);
    },
    { timeout: 30000 },
  );

  it(
    'installs every subfeature of the PostToolUse hook container when migrating a bare pre-unification SQAA hook',
    async () => {
      seedPreUnificationFeatures('claude-code', [SQAA_HOOK_FEATURE_ID], CAG_HOOK_ALLOWED_ORG_KEY);
      harness.state().withContextAugmentationBinaryInstalled();

      const result = await harness.run(POST_UPDATE_TRIGGER_COMMAND);

      expect(result.exitCode).toBe(0);
      const state = harness.stateJsonFile.asJson() as CliState;
      const claude = state.integrations.installed.find(
        (integration) => integration.integrationId === 'claude-code',
      );
      const postToolUseContainer = claude?.features.find(
        (feature) => feature.featureId === SQAA_HOOK_FEATURE_ID,
      );
      expect(postToolUseContainer?.subfeatures?.map((subfeature) => subfeature.featureId)).toEqual([
        'sqaa-posttooluse',
        'cag-posttooluse',
      ]);
    },
    { timeout: 30000 },
  );

  it(
    'migrates pre-unification Copilot SQAA and Context Augmentation records into one Vortex container',
    async () => {
      seedPreUnificationFeatures('copilot-cli', [
        SQAA_INSTRUCTIONS_SUBFEATURE_ID,
        CONTEXT_AUGMENTATION_FEATURE_ID,
      ]);
      harness.state().withContextAugmentationBinaryInstalled();

      const result = await harness.run(POST_UPDATE_TRIGGER_COMMAND);

      expect(result.exitCode).toBe(0);
      const state = harness.stateJsonFile.asJson() as CliState;
      const copilot = state.integrations.installed.find(
        (integration) => integration.integrationId === 'copilot-cli',
      );
      expect(copilot?.features.map((feature) => feature.featureId)).toEqual([VORTEX_FEATURE_ID]);
      expect(copilot?.features[0].subfeatures?.map((subfeature) => subfeature.featureId)).toEqual([
        SQAA_INSTRUCTIONS_SUBFEATURE_ID,
        CONTEXT_AUGMENTATION_FEATURE_ID,
      ]);
      expect(
        harness.cwd.file('.github', 'instructions', 'sonarqube.instructions.md').asText(),
      ).toContain('# Vortex analysis protocol');
      expectVortexHookInstalled(harness.cwd, 'copilot');
    },
    { timeout: 30000 },
  );

  it(
    'migrates pre-unification Cursor SQAA and Context Augmentation records into one Vortex container',
    async () => {
      seedPreUnificationFeatures('cursor', [
        SQAA_INSTRUCTIONS_SUBFEATURE_ID,
        CONTEXT_AUGMENTATION_FEATURE_ID,
      ]);
      harness.state().withContextAugmentationBinaryInstalled();

      const result = await harness.run(POST_UPDATE_TRIGGER_COMMAND);

      expect(result.exitCode).toBe(0);
      const state = harness.stateJsonFile.asJson() as CliState;
      const cursor = state.integrations.installed.find(
        (integration) => integration.integrationId === 'cursor',
      );
      expect(cursor?.features.map((feature) => feature.featureId)).toEqual([VORTEX_FEATURE_ID]);
      expect(cursor?.features[0].subfeatures?.map((subfeature) => subfeature.featureId)).toEqual([
        SQAA_INSTRUCTIONS_SUBFEATURE_ID,
        CONTEXT_AUGMENTATION_FEATURE_ID,
      ]);
      expect(harness.cwd.file('.cursor', 'rules', 'sonar-agentic-analysis.mdc').asText()).toContain(
        '# Vortex analysis protocol',
      );
      expectVortexHookInstalled(harness.cwd, 'cursor');
    },
    { timeout: 30000 },
  );

  it(
    'migrates pre-unification Antigravity SQAA and Context Augmentation records into one Vortex container',
    async () => {
      seedPreUnificationFeatures('antigravity', [
        SQAA_INSTRUCTIONS_SUBFEATURE_ID,
        CONTEXT_AUGMENTATION_FEATURE_ID,
      ]);
      harness.state().withContextAugmentationBinaryInstalled();

      const result = await harness.run(POST_UPDATE_TRIGGER_COMMAND);

      expect(result.exitCode).toBe(0);
      const state = harness.stateJsonFile.asJson() as CliState;
      const antigravity = state.integrations.installed.find(
        (integration) => integration.integrationId === 'antigravity',
      );
      expect(antigravity?.features.map((feature) => feature.featureId)).toEqual([
        VORTEX_FEATURE_ID,
      ]);
      // Antigravity has no session start event, so its container carries no Vortex Context.
      expect(
        antigravity?.features[0].subfeatures?.map((subfeature) => subfeature.featureId),
      ).toEqual([SQAA_INSTRUCTIONS_SUBFEATURE_ID]);
      expect(harness.cwd.file('.agents', 'rules', 'sonar-agentic-analysis.md').asText()).toContain(
        '# Vortex analysis protocol',
      );
      expect(
        harness.cwd.file('.agents', 'skills', 'sonar-context-augmentation', 'SKILL.md').exists(),
      ).toBe(false);
    },
    { timeout: 30000 },
  );

  it(
    'migrates pre-unification Codex SQAA and Context Augmentation records into one Vortex container',
    async () => {
      seedPreUnificationFeatures('codex', [SQAA_HOOK_FEATURE_ID, CONTEXT_AUGMENTATION_FEATURE_ID]);
      harness.state().withContextAugmentationBinaryInstalled();

      const result = await harness.run(POST_UPDATE_TRIGGER_COMMAND);

      expect(result.exitCode).toBe(0);
      const state = harness.stateJsonFile.asJson() as CliState;
      const codex = state.integrations.installed.find(
        (integration) => integration.integrationId === 'codex',
      );
      expect(codex?.features.map((feature) => feature.featureId)).toEqual([VORTEX_FEATURE_ID]);
      expect(codex?.features[0].subfeatures?.map((subfeature) => subfeature.featureId)).toEqual([
        SQAA_HOOK_FEATURE_ID,
        SQAA_INSTRUCTIONS_SUBFEATURE_ID,
        CONTEXT_AUGMENTATION_FEATURE_ID,
      ]);
      expect(harness.cwd.file('.codex', 'hooks.json').asJson().hooks?.PostToolUse).toBeDefined();
      expect(harness.cwd.file('AGENTS.md').asText()).toContain(
        '<!-- sonar:begin:sonarqube-agentic-analysis-protocol -->',
      );
      expectVortexHookInstalled(harness.cwd, 'codex');
    },
    { timeout: 30000 },
  );

  it(
    'restores deprecated feature records when their Vortex successor fails to apply',
    async () => {
      const deprecatedFeatureIds = [
        SQAA_HOOK_FEATURE_ID,
        SQAA_INSTRUCTIONS_SUBFEATURE_ID,
        CONTEXT_AUGMENTATION_FEATURE_ID,
      ];
      seedPreUnificationFeatures('claude-code', deprecatedFeatureIds);
      harness.state().withContextAugmentationBinaryInstalled();
      harness.cwd.writeFile('.claude/settings.json', '{ not json');

      const result = await harness.run(POST_UPDATE_TRIGGER_COMMAND);

      expect(result.exitCode).toBe(0);
      const state = harness.stateJsonFile.asJson() as CliState;
      const claudeFeatures =
        state.integrations.installed.find(
          (integration) => integration.integrationId === 'claude-code',
        )?.features ?? [];
      expect(claudeFeatures.map((feature) => feature.featureId).sort()).toEqual(
        [...deprecatedFeatureIds].sort(),
      );
      expect(claudeFeatures.some((feature) => feature.featureId === VORTEX_FEATURE_ID)).toBe(false);
    },
    { timeout: 30000 },
  );

  it(
    'refreshes declarative Claude hook resources on CLI upgrade',
    async () => {
      const now = new Date().toISOString();
      const pretoolScriptRel = `.claude/hooks/sonar-secrets/build-scripts/${hookScriptName('pretool-secrets')}`;
      const promptScriptRel = `.claude/hooks/sonar-secrets/build-scripts/${hookScriptName('prompt-secrets')}`;
      const settingsRel = '.claude/settings.json';
      // Project scope anchors the path to Claude Code's ${CLAUDE_PROJECT_DIR} placeholder
      // (cwd-independent) and shell-quotes it so it survives spaces/metacharacters. Double-quoted
      // on both platforms — single-quoting on Unix would suppress the shell's `${var}` expansion
      // and leave the placeholder unexpanded.
      const pretoolCommandPath = '${CLAUDE_PROJECT_DIR}/' + pretoolScriptRel;
      const promptCommandPath = '${CLAUDE_PROJECT_DIR}/' + promptScriptRel;
      const expectedPretoolCommand = IS_WINDOWS
        ? `powershell -NoProfile -ExecutionPolicy Bypass -File "${pretoolCommandPath}"`
        : `"${pretoolCommandPath}"`;
      const expectedPromptCommand = IS_WINDOWS
        ? `powershell -NoProfile -ExecutionPolicy Bypass -File "${promptCommandPath}"`
        : `"${promptCommandPath}"`;

      harness.cwd.writeFile(
        pretoolScriptRel,
        IS_WINDOWS
          ? '$output = sonar analyze --file $file_path 2>$null\n'
          : '#!/bin/bash\noutput=$(sonar analyze --file "$file_path" 2>/dev/null)\n',
      );
      harness.cwd.writeFile(
        promptScriptRel,
        IS_WINDOWS
          ? '$output = sonar analyze --file $file_path 2>$null\n'
          : '#!/bin/bash\noutput=$(sonar analyze --file "$file_path" 2>/dev/null)\n',
      );
      harness.cwd.writeFile(
        settingsRel,
        JSON.stringify(
          {
            hooks: {
              PreToolUse: [
                {
                  matcher: 'Read',
                  hooks: [
                    {
                      type: 'command',
                      command: '.claude/hooks/sonar-secrets/build-scripts/old-pretool.sh',
                      timeout: 60,
                    },
                  ],
                },
              ],
              UserPromptSubmit: [
                {
                  matcher: '*',
                  hooks: [
                    {
                      type: 'command',
                      command: '.claude/hooks/sonar-secrets/build-scripts/old-prompt.sh',
                      timeout: 60,
                    },
                  ],
                },
              ],
            },
          },
          null,
          2,
        ),
      );

      harness.state().withRawState(
        JSON.stringify({
          version: '1.0',
          lastUpdated: now,
          auth: { isAuthenticated: false, connections: [] },
          agents: {
            'claude-code': {
              configured: true,
              configuredByCliVersion: '0.5.0',
              hooks: { installed: [] },
              skills: { installed: [] },
            },
          },
          config: { cliVersion: '0.5.0' },
          telemetry: { enabled: false, firstUseDate: now, events: [] },
          agentExtensions: [],
          integrations: {
            installed: [
              {
                id: randomUUID(),
                integrationId: 'claude-code',
                installedByCliVersion: '0.5.0',
                installedAt: now,
                updatedByCliVersion: '0.5.0',
                updatedAt: now,
                features: [
                  {
                    featureId: 'sonar-secrets-hooks',
                    scope: 'project',
                    targetRoot: harness.cwd.path,
                    installedByCliVersion: '0.5.0',
                    installedAt: now,
                    updatedByCliVersion: '0.5.0',
                    updatedAt: now,
                    resources: [],
                    operations: [],
                  },
                ],
              },
            ],
          },
        }),
      );

      const result = await harness.run(POST_UPDATE_TRIGGER_COMMAND);

      expect(result.exitCode).toBe(0);
      expect(harness.cwd.file(pretoolScriptRel).asText()).toContain(
        'sonar hook claude-pre-tool-use',
      );
      expect(harness.cwd.file(promptScriptRel).asText()).toContain(
        'sonar hook claude-prompt-submit',
      );

      const settings = harness.cwd.file(settingsRel).asJson();
      expect(settings.hooks?.PreToolUse?.[0]).toEqual({
        matcher: 'Read',
        hooks: [{ type: 'command', command: expectedPretoolCommand, timeout: 60 }],
      });
      expect(settings.hooks?.UserPromptSubmit?.[0]).toEqual({
        matcher: '*',
        hooks: [{ type: 'command', command: expectedPromptCommand, timeout: 60 }],
      });
    },
    { timeout: 15000 },
  );

  describe('CAG declarative refresh', () => {
    const CAG_SKILL_AGENTS = [
      ['claude', CLAUDE_INTEGRATION_ID],
      ['copilot', COPILOT_INTEGRATION_ID],
      ['codex', CODEX_INTEGRATION_ID],
      ['cursor', CURSOR_INTEGRATION_ID],
    ] as const;

    beforeEach(async () => {
      mkdirSync(harness.cwd.path, { recursive: true });
      await harness.newFakeBinariesServer().start();
    });

    it.each(CAG_SKILL_AGENTS)(
      'migrates a recorded %s CAG skill to the session-start hook',
      async (agentId, integrationId) => {
        seedState(harness, {
          installCagStub: true,
          skills: [{ agentId, projectRoot: harness.cwd.path }],
        });
        const skillPath = seedLegacySkillFile(harness.cwd.path, agentId, '# stale skill\n');

        const result = await harness.run(POST_UPDATE_TRIGGER_COMMAND);
        expect(result.exitCode, result.stderr).toBe(0);

        expect(existsSync(skillPath)).toBe(false);
        expectSessionStartHookRefreshed(harness.cwd.path, agentId);

        const state = harness.stateJsonFile.asJson() as CliState;
        expect(state.config.cliVersion).not.toBe(STALE_CLI_VERSION);
        const feature = findRecordedCagFeature(
          state,
          ({ integrationId: recordedId, feature: installedFeature }) =>
            recordedId === integrationId && installedFeature.targetRoot === harness.cwd.path,
        );
        expect(feature).toBeDefined();
        if (!feature) {
          throw new Error(`Expected a recorded declarative ${agentId} CAG feature`);
        }
        expect(findRecordedSessionStartScriptResource(feature)?.path).toBe(
          sessionStartScriptPath(harness.cwd.path, agentId),
        );
        expect(findRecordedCagSkillResource(feature)).toBeUndefined();
      },
      { timeout: 30000 },
    );

    it(
      'skips the refresh when the recorded project root no longer exists',
      async () => {
        const missingRoot = join(harness.cwd.path, 'has-been-deleted');
        seedState(harness, {
          skills: [{ agentId: 'claude', projectRoot: missingRoot }],
        });

        const result = await harness.run(POST_UPDATE_TRIGGER_COMMAND);
        expect(result.exitCode, result.stderr).toBe(0);

        const cagBinaryPath = join(
          harness.cliHome.path,
          'bin',
          buildLocalCagBinaryName(detectPlatform()),
        );
        expect(existsSync(cagBinaryPath)).toBe(false);
        expect(existsSync(join(missingRoot, CLAUDE_SKILL_RELATIVE_PATH))).toBe(false);
        expect(existsSync(sessionStartScriptPath(missingRoot, 'claude'))).toBe(false);

        const state = harness.stateJsonFile.asJson() as CliState;
        expect(state.config.cliVersion).not.toBe(STALE_CLI_VERSION);
        expect(findRecordedCagDependency(state)).toBeUndefined();
        const feature = findRecordedCagFeature(
          state,
          ({ integrationId, feature: installedFeature }) =>
            integrationId === CLAUDE_INTEGRATION_ID && installedFeature.targetRoot === missingRoot,
        );
        expect(feature).toBeDefined();
        if (!feature) {
          throw new Error('Expected the deleted-root declarative CAG feature to remain recorded');
        }
        const resource = findRecordedCagSkillResource(feature);
        expect(resource).toBeDefined();
        expect(resource?.version).toBe(STALE_SKILL_VERSION);
      },
      { timeout: 30000 },
    );

    it(
      'refreshes every recorded install across multiple project roots in one post-update',
      async () => {
        const projectA = join(harness.userHome.path, 'project-a');
        const projectB = join(harness.userHome.path, 'project-b');
        mkdirSync(projectA, { recursive: true });
        mkdirSync(projectB, { recursive: true });

        seedState(harness, {
          installCagStub: true,
          skills: [
            { agentId: 'claude', projectRoot: projectA },
            { agentId: 'claude', projectRoot: projectB },
          ],
        });
        const skillPathA = seedLegacySkillFile(projectA, 'claude', '# stale skill A\n');
        const skillPathB = seedLegacySkillFile(projectB, 'claude', '# stale skill B\n');

        const result = await harness.run(POST_UPDATE_TRIGGER_COMMAND);
        expect(result.exitCode, result.stderr).toBe(0);

        expect(existsSync(skillPathA)).toBe(false);
        expect(existsSync(skillPathB)).toBe(false);
        expectSessionStartHookRefreshed(projectA, 'claude');
        expectSessionStartHookRefreshed(projectB, 'claude');

        const state = harness.stateJsonFile.asJson() as CliState;
        const featureA = findRecordedCagFeature(
          state,
          ({ integrationId, feature }) =>
            integrationId === CLAUDE_INTEGRATION_ID && feature.targetRoot === projectA,
        );
        const featureB = findRecordedCagFeature(
          state,
          ({ integrationId, feature }) =>
            integrationId === CLAUDE_INTEGRATION_ID && feature.targetRoot === projectB,
        );
        expect(featureA).toBeDefined();
        expect(featureB).toBeDefined();
        if (!featureA || !featureB) {
          throw new Error('Expected both declarative Claude CAG features to remain recorded');
        }
        expect(findRecordedSessionStartScriptResource(featureA)?.path).toBe(
          sessionStartScriptPath(projectA, 'claude'),
        );
        expect(findRecordedSessionStartScriptResource(featureB)?.path).toBe(
          sessionStartScriptPath(projectB, 'claude'),
        );
      },
      { timeout: 30000 },
    );

    it(
      'is a no-op when state.config.cliVersion already matches the current CLI version',
      async () => {
        seedState(harness, {
          cliVersion: CURRENT_VERSION,
          skills: [{ agentId: 'claude', projectRoot: harness.cwd.path }],
        });

        const result = await harness.run(POST_UPDATE_TRIGGER_COMMAND);
        expect(result.exitCode, result.stderr).toBe(0);

        const cagBinaryPath = join(
          harness.cliHome.path,
          'bin',
          buildLocalCagBinaryName(detectPlatform()),
        );
        expect(existsSync(cagBinaryPath)).toBe(false);
        expect(existsSync(sessionStartScriptPath(harness.cwd.path, 'claude'))).toBe(false);

        const state = harness.stateJsonFile.asJson() as CliState;
        expect(state.config.cliVersion).toBe(CURRENT_VERSION);
        expect(findRecordedCagDependency(state)).toBeUndefined();
        const feature = findRecordedCagFeature(
          state,
          ({ integrationId, feature: installedFeature }) =>
            integrationId === CLAUDE_INTEGRATION_ID &&
            installedFeature.targetRoot === harness.cwd.path,
        );
        expect(feature).toBeDefined();
        if (!feature) {
          throw new Error('Expected the no-op declarative CAG feature to remain recorded');
        }
        const resource = findRecordedCagSkillResource(feature);
        expect(resource).toBeDefined();
        expect(resource?.version).toBe(STALE_SKILL_VERSION);
      },
      { timeout: 30000 },
    );

    it(
      'removes stale-version binaries left in the bin directory after a refresh',
      async () => {
        const binDir = join(harness.cliHome.path, 'bin');
        mkdirSync(binDir, { recursive: true });
        const oldBinaryName = `${CONTEXT_AUGMENTATION_BINARY_NAME}-0.5.0.0-${detectPlatform().os}-${detectPlatform().arch}`;
        const oldBinaryPath = join(binDir, oldBinaryName);
        writeFileSync(oldBinaryPath, 'stale binary contents', 'utf-8');

        seedState(harness, {
          skills: [{ agentId: 'claude', projectRoot: harness.cwd.path }],
        });

        const result = await harness.run(POST_UPDATE_TRIGGER_COMMAND);
        expect(result.exitCode, result.stderr).toBe(0);

        const cagBinaryPath = join(binDir, buildLocalCagBinaryName(detectPlatform()));
        expect(existsSync(cagBinaryPath)).toBe(true);
        expect(existsSync(oldBinaryPath)).toBe(false);

        const lingeringCagBinaries = readdirSync(binDir).filter((file) =>
          file.startsWith(`${CONTEXT_AUGMENTATION_BINARY_NAME}-`),
        );
        expect(lingeringCagBinaries).toEqual([buildLocalCagBinaryName(detectPlatform())]);
        expect(findRecordedCagDependency(harness.stateJsonFile.asJson() as CliState)?.version).toBe(
          SONAR_CONTEXT_AUGMENTATION_VERSION,
        );
      },
      { timeout: 30000 },
    );

    it(
      'reinstalls the session-start hook after a subsequent CLI upgrade',
      async () => {
        seedState(harness, {
          installCagStub: true,
          skills: [{ agentId: 'claude', projectRoot: harness.cwd.path }],
        });

        const first = await harness.run(POST_UPDATE_TRIGGER_COMMAND);
        expect(first.exitCode, first.stderr).toBe(0);

        const scriptPath = sessionStartScriptPath(harness.cwd.path, 'claude');
        const preMutationContent = readFileSync(scriptPath, 'utf-8');
        const state = harness.stateJsonFile.asJson() as CliState;
        state.config.cliVersion = STALE_CLI_VERSION;
        harness.state().withRawState(JSON.stringify(state, null, 2));
        rmSync(scriptPath);

        const second = await harness.run(POST_UPDATE_TRIGGER_COMMAND);
        expect(second.exitCode, second.stderr).toBe(0);
        expect(existsSync(scriptPath)).toBe(true);
        expect(readFileSync(scriptPath, 'utf-8')).toEqual(preMutationContent);
        expect((harness.stateJsonFile.asJson() as CliState).config.cliVersion).not.toBe(
          STALE_CLI_VERSION,
        );
      },
      { timeout: 30000 },
    );
  });

  describe('trigger', () => {
    const STALE_CLI_VERSION = '0.5.0';

    function seedStaleCliVersion(): void {
      const now = new Date().toISOString();
      harness.state().withRawState(
        JSON.stringify({
          version: '1.0',
          lastUpdated: now,
          auth: { isAuthenticated: false, connections: [] },
          agents: {
            'claude-code': {
              configured: false,
              configuredByCliVersion: STALE_CLI_VERSION,
              hooks: { installed: [] },
              skills: { installed: [] },
            },
          },
          config: { cliVersion: STALE_CLI_VERSION },
          telemetry: { enabled: false, firstUseDate: now, events: [] },
          agentExtensions: [],
          integrations: { installed: [] },
        }),
      );
    }

    function persistedCliVersion(): string {
      return (harness.stateJsonFile.asJson() as CliState).config.cliVersion;
    }

    // --version and --help exit before the root preAction hook migrations run from.
    for (const flag of ['--version', '--help']) {
      it(
        `leaves the persisted CLI version stale for ${flag}`,
        async () => {
          seedStaleCliVersion();

          const result = await harness.run(flag);

          expect(result.exitCode).toBe(0);
          expect(persistedCliVersion()).toBe(STALE_CLI_VERSION);
        },
        { timeout: 15000 },
      );
    }

    // An unknown command exits 1 but still reaches the root action, so it migrates.
    const migratingInvocations = [
      { label: 'a bare invocation', command: '', exitCode: 0 },
      { label: 'an unknown command', command: 'not-a-real-command', exitCode: 1 },
      { label: 'a nested subcommand', command: 'config telemetry', exitCode: 0 },
    ];
    for (const { label, command, exitCode } of migratingInvocations) {
      it(
        `migrates on ${label}`,
        async () => {
          seedStaleCliVersion();

          const result = await harness.run(command);

          expect(result.exitCode).toBe(exitCode);
          expect(persistedCliVersion()).toBe(CURRENT_VERSION);
        },
        { timeout: 15000 },
      );
    }
  });
});
