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

// Integration tests for the global-integrations migration

import { realpathSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { antigravityIntegration } from '@/commands/integrate/antigravity/declaration.ts';
import { claudeIntegration } from '@/commands/integrate/claude/declaration.ts';
import { codexIntegration } from '@/commands/integrate/codex/declaration.ts';
import { copilotIntegration } from '@/commands/integrate/copilot/declaration.ts';
import { cursorIntegration } from '@/commands/integrate/cursor/declaration.ts';
import { nativeGitIntegration } from '@/commands/integrate/git/tools/native';
import type { IntegrationDeclaration } from '@/core/framework/features';
import type { CliState, InstalledIntegrationFeature } from '@/core/state/state.ts';

import { version as CURRENT_CLI_VERSION } from '../../../../package.json';
import { POST_UPDATE_TRIGGER_COMMAND } from '../../../_common/isolated-cli-env.js';
import { type CliResult, TestHarness } from '../../harness';

const TEST_TIMEOUT = 60000;
const STALE_CLI_VERSION = '0.5.0';

describe('global-integrations migration', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
    harness.state().withSecretsBinaryInstalled();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  async function authenticateAgainstFakeServer(): Promise<void> {
    const server = await harness.newFakeServer().withAuthToken('tok').withProject('proj').start();
    harness.withAuth(server.baseUrl(), 'tok');
    harness.cwd.writeFile(
      'sonar-project.properties',
      [`sonar.host.url=${server.baseUrl()}`, 'sonar.projectKey=proj'].join('\n'),
    );
  }

  function seedProjectScopedInstall<TOptions>(
    integration: IntegrationDeclaration<TOptions>,
    featureId = 'sonar-secrets-hooks',
    targetRoot: string = realpathSync(harness.cwd.path),
  ): void {
    harness.state().withInstalledIntegrationFeature(integration, featureId, 'project', targetRoot);
  }

  function runAsUpgrade(): Promise<CliResult> {
    const builder = harness.state();
    const state = builder.build(join(harness.cliHome.path, 'bin'));
    state.config.cliVersion = STALE_CLI_VERSION;
    builder.withRawState(JSON.stringify(state, null, 2));
    return harness.run(POST_UPDATE_TRIGGER_COMMAND);
  }

  function recordedFeatures(integrationId: string): InstalledIntegrationFeature[] {
    const state = harness.stateJsonFile.asJson() as CliState;
    return (
      state.integrations.installed.find(
        (integration) => integration.integrationId === integrationId,
      )?.features ?? []
    );
  }

  function recordedScopes(integrationId: string): string[] {
    return recordedFeatures(integrationId).map((feature) => feature.scope);
  }

  it(
    'reinstalls every project-scoped agent globally, drops its project records, and reports each one',
    async () => {
      await authenticateAgainstFakeServer();
      seedProjectScopedInstall(claudeIntegration);
      seedProjectScopedInstall(codexIntegration);

      const result = await runAsUpgrade();

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(
        'Removing your project-level agent integrations and reinstalling them globally...',
      );
      expect(result.stdout).toContain('Migrating the Claude Code integration to global scope...');
      expect(result.stdout).toContain('Migrated the Claude Code integration to global scope.');
      expect(result.stdout).toContain('Migrating the Codex integration to global scope...');
      expect(result.stdout).toContain('Migrated the Codex integration to global scope.');
      expect(result.stdout).toContain(
        "Done — your integrations are now global. Run 'sonar integrate' anytime to add or remove one.",
      );
      expect(recordedScopes('claude-code')).not.toContain('project');
      expect(recordedScopes('claude-code')).toContain('global');
      expect(recordedScopes('codex')).not.toContain('project');
      expect(recordedScopes('codex')).toContain('global');
      expect(harness.userHome.exists('.claude', 'settings.json')).toBe(true);
    },
    { timeout: TEST_TIMEOUT },
  );

  it(
    'removes a project artifact whose feature was never recorded',
    async () => {
      // The teardown iterates declared features, not recorded ids, so an artifact left by
      // a feature that is absent from state is still cleaned up. The Cursor rule file is a
      // `wholeFile` resource with no managed marker, so removal does not depend on content.
      await authenticateAgainstFakeServer();
      seedProjectScopedInstall(cursorIntegration);
      harness.cwd.writeFile('.cursor/rules/sonar-agentic-analysis.mdc', '# stale instructions\n');

      const result = await runAsUpgrade();

      expect(result.exitCode).toBe(0);
      expect(harness.cwd.exists('.cursor', 'rules', 'sonar-agentic-analysis.mdc')).toBe(false);
    },
    { timeout: TEST_TIMEOUT },
  );

  it(
    'leaves git integrations at project scope',
    async () => {
      // Claude is seeded alongside git so the migration actually runs.
      await authenticateAgainstFakeServer();
      seedProjectScopedInstall(claudeIntegration);
      seedProjectScopedInstall(nativeGitIntegration, 'pre-commit-hook');

      const result = await runAsUpgrade();

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Migrated the Claude Code integration to global scope.');
      expect(result.stdout).not.toContain('Native Git integration to global scope');
      expect(recordedScopes('claude-code')).not.toContain('project');
      expect(recordedScopes('native-git')).toEqual(['project']);
    },
    { timeout: TEST_TIMEOUT },
  );

  it(
    'does not run again once an agent has only global records',
    async () => {
      // Authenticated on purpose: credentials must not be the reason nothing happens.
      await authenticateAgainstFakeServer();
      harness
        .state()
        .withInstalledIntegrationFeature(
          claudeIntegration,
          'sonar-secrets-hooks',
          'global',
          harness.userHome.path,
        );

      const result = await runAsUpgrade();

      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain('Removing your project-level agent integrations');
      expect(recordedScopes('claude-code')).toEqual(['global']);
      expect(recordedFeatures('claude-code')).toHaveLength(1);
    },
    { timeout: TEST_TIMEOUT },
  );

  it(
    'migrates an agent whose project was moved or deleted',
    async () => {
      await authenticateAgainstFakeServer();
      seedProjectScopedInstall(
        claudeIntegration,
        'sonar-secrets-hooks',
        join(harness.cwd.path, 'deleted-repo'),
      );

      const result = await runAsUpgrade();

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Migrated the Claude Code integration to global scope.');
      expect(recordedScopes('claude-code')).not.toContain('project');
      expect(recordedScopes('claude-code')).toContain('global');
    },
    { timeout: TEST_TIMEOUT },
  );

  it(
    'tears down every project an agent was integrated into',
    async () => {
      await authenticateAgainstFakeServer();
      harness.cwd.writeFile('second-repo/.cursor/rules/sonar-agentic-analysis.mdc', '# stale\n');
      harness.cwd.writeFile('.cursor/rules/sonar-agentic-analysis.mdc', '# stale\n');
      const secondRepo = realpathSync(join(harness.cwd.path, 'second-repo'));
      seedProjectScopedInstall(cursorIntegration);
      seedProjectScopedInstall(cursorIntegration, 'sonar-secrets-hooks', secondRepo);

      const result = await runAsUpgrade();

      expect(result.exitCode).toBe(0);
      expect(harness.cwd.exists('.cursor', 'rules', 'sonar-agentic-analysis.mdc')).toBe(false);
      expect(
        harness.cwd.exists('second-repo', '.cursor', 'rules', 'sonar-agentic-analysis.mdc'),
      ).toBe(false);
      expect(recordedScopes('cursor')).not.toContain('project');
    },
    { timeout: TEST_TIMEOUT },
  );

  it(
    'migrates the remaining agents when one fails, and keeps the failed one for a retry',
    async () => {
      await authenticateAgainstFakeServer();
      // A regular file where Claude's global config directory belongs: every write below it
      // fails, so the Claude install throws while Codex is untouched.
      harness.userHome.writeFile('.claude', 'not a directory\n');
      seedProjectScopedInstall(claudeIntegration);
      seedProjectScopedInstall(codexIntegration);

      const result = await runAsUpgrade();

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain(
        'Could not migrate the Claude Code integration to global scope',
      );
      expect(recordedScopes('claude-code')).toContain('project');
      expect(recordedScopes('codex')).not.toContain('project');
      expect(recordedScopes('codex')).toContain('global');
      // The version gate has already been spent, so the user is told how to retry.
      expect(result.stderr).toContain(
        "Some integrations were left at project scope. Run 'sonar update' to retry.",
      );
    },
    { timeout: TEST_TIMEOUT },
  );

  it(
    'keeps the Antigravity MCP server the install just wrote',
    async () => {
      // Antigravity's MCP config resolves to the same user-level file at both scopes, so a
      // teardown running after the install would delete what it wrote.
      await authenticateAgainstFakeServer();
      seedProjectScopedInstall(antigravityIntegration, 'mcp-server');

      const result = await runAsUpgrade();

      expect(result.exitCode).toBe(0);
      const mcp = harness.userHome.file('.gemini', 'config', 'mcp_config.json').asJson() as {
        mcpServers?: Record<string, { command?: string }>;
      };
      expect(mcp.mcpServers?.sonarqube?.command).toBe('sonar');
    },
    { timeout: TEST_TIMEOUT },
  );

  it(
    'keeps an already-global record while dropping the project ones',
    async () => {
      await authenticateAgainstFakeServer();
      harness
        .state()
        .withInstalledIntegrationFeature(
          claudeIntegration,
          'sonar-secrets-hooks',
          'global',
          harness.userHome.path,
        );
      seedProjectScopedInstall(claudeIntegration, 'mcp-server');

      const result = await runAsUpgrade();

      expect(result.exitCode).toBe(0);
      expect(recordedScopes('claude-code')).not.toContain('project');
      expect(recordedFeatures('claude-code').map((feature) => feature.featureId)).toEqual([
        'sonar-secrets-hooks',
      ]);
    },
    { timeout: TEST_TIMEOUT },
  );

  it(
    'installs only Claude globally when Cursor and Copilot are migrated alongside it',
    async () => {
      await authenticateAgainstFakeServer();
      seedProjectScopedInstall(claudeIntegration);
      seedProjectScopedInstall(cursorIntegration);
      seedProjectScopedInstall(copilotIntegration, 'pre-tool-use-hook');
      harness.cwd.writeFile('.cursor/rules/sonar-agentic-analysis.mdc', '# stale\n');

      const result = await runAsUpgrade();

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Migrated the Claude Code integration to global scope.');
      expect(result.stderr).toContain('Skipped the global Cursor integration');
      expect(result.stderr).toContain('Skipped the global Copilot integration');
      // Both give way, project records and artifacts included; only Claude reaches global scope.
      expect(harness.cwd.exists('.cursor', 'rules', 'sonar-agentic-analysis.mdc')).toBe(false);
      expect(recordedScopes('cursor')).toEqual([]);
      expect(recordedScopes('copilot-cli')).toEqual([]);
      expect(harness.userHome.exists('.copilot')).toBe(false);
      expect(recordedScopes('claude-code')).toContain('global');
    },
    { timeout: TEST_TIMEOUT },
  );

  it(
    'keeps the project records when credentials are unavailable, and says how to retry',
    async () => {
      // No fake server and no auth: `harness.cwd` is never created, so pass its path
      // unresolved — `realpathSync` would throw on the missing directory.
      harness.state().clearAuth();
      seedProjectScopedInstall(claudeIntegration, 'sonar-secrets-hooks', harness.cwd.path);

      const result = await runAsUpgrade();

      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain('Removing your project-level agent integrations');
      expect(result.stderr).toContain('you are not logged in');
      expect(result.stderr).toContain("Run 'sonar auth login', then 'sonar update'");
      expect(recordedScopes('claude-code')).toEqual(['project']);
    },
    { timeout: TEST_TIMEOUT },
  );

  it(
    'retries from sonar update once the version gate has been spent',
    async () => {
      // Already on the latest version, so the update installs nothing and no version bump can
      // re-arm the post-update gate: the retry can only have come from this command's own hook.
      await harness.newFakeBinariesServer().withStableVersion(CURRENT_CLI_VERSION).start();
      await authenticateAgainstFakeServer();
      seedProjectScopedInstall(claudeIntegration);

      const result = await harness.run('update');

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Already up to date');
      expect(result.stdout).toContain('Migrated the Claude Code integration to global scope.');
      expect(recordedScopes('claude-code')).not.toContain('project');
      expect(recordedScopes('claude-code')).toContain('global');
    },
    { timeout: TEST_TIMEOUT },
  );

  it(
    'does not migrate during sonar update --status',
    async () => {
      // --status only reports a version; it must not rewrite integrations.
      await harness.newFakeBinariesServer().withStableVersion(CURRENT_CLI_VERSION).start();
      await authenticateAgainstFakeServer();
      seedProjectScopedInstall(claudeIntegration);

      const result = await harness.run('update --status');

      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain('Removing your project-level agent integrations');
      expect(recordedScopes('claude-code')).toEqual(['project']);
    },
    { timeout: TEST_TIMEOUT },
  );

  it(
    'does not migrate during sonar update status',
    async () => {
      // The `update status` subcommand only reports a version; it must not rewrite integrations.
      await harness.newFakeBinariesServer().withStableVersion(CURRENT_CLI_VERSION).start();
      await authenticateAgainstFakeServer();
      seedProjectScopedInstall(claudeIntegration);

      const result = await harness.run('update status');

      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain('Removing your project-level agent integrations');
      expect(recordedScopes('claude-code')).toEqual(['project']);
    },
    { timeout: TEST_TIMEOUT },
  );
});
