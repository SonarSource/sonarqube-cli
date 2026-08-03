/*
 * SonarQube CLI
 * Copyright (C) 2026 SonarSource Sàrl
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

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { claudeIntegration } from '@/commands/integrate/claude/declaration.ts';
import type { CliState } from '@/core/state/state.ts';

import { hookScriptName, TestHarness } from '../../harness';
import { findInstalledFeature } from './state-helpers';

function findClaudeFeature(harness: TestHarness, featureId: string) {
  return findInstalledFeature(harness, 'claude-code', featureId);
}

function loadState(harness: TestHarness): CliState {
  return harness.stateJsonFile.asJson() as CliState;
}

interface ClaudeHookEntry {
  matcher?: string;
  hooks?: Array<{ command?: string }>;
}

interface ClaudeSettings {
  hooks?: {
    PreToolUse?: ClaudeHookEntry[];
    UserPromptSubmit?: ClaudeHookEntry[];
    PostToolUse?: ClaudeHookEntry[];
    PostToolUseFailure?: ClaudeHookEntry[];
  };
}

function readClaudeSettings(harness: TestHarness): ClaudeSettings {
  return harness.cwd.file('.claude', 'settings.json').asJson() as ClaudeSettings;
}

function entriesOwnedBy(entries: ClaudeHookEntry[] | undefined, marker: string): ClaudeHookEntry[] {
  return (entries ?? []).filter((entry) =>
    entry.hooks?.some((hook) => hook.command?.includes(marker)),
  );
}

describe('integrate claude — CLI-900 CAG hook migration', () => {
  let harness: TestHarness;
  const ORG_KEY = 'my-org';
  const ORG_UUID = `${ORG_KEY}-uuid-v4`;
  const LEGACY_CAG_SCRIPT_PATH = '.claude/hooks/sonar-context-augmentation/build-scripts';

  beforeEach(async () => {
    harness = await TestHarness.create();
    harness.cwd.writeFile('.git/HEAD', 'ref: refs/heads/main\n');
    await harness.newFakeBinariesServer().start();
    harness.state().withSecretsBinaryInstalled();
    harness.state().withContextAugmentationBinaryInstalled();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it(
    'moves the pre-CLI-900 independent CAG hook onto the shared containers and cleans up the old resource',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('tok')
        .withProject('proj')
        .withVortexEntitlement(ORG_KEY, ORG_UUID)
        .withScaEnabled(true)
        .start();
      harness.withAuth(server.baseUrl(), 'tok', ORG_KEY);
      harness.cwd.writeFile(
        'sonar-project.properties',
        [
          `sonar.host.url=${server.baseUrl()}`,
          'sonar.projectKey=proj',
          `sonar.organization=${ORG_KEY}`,
        ].join('\n'),
      );

      const legacyEntry = {
        matcher: 'Bash|PowerShell|Monitor|Read',
        hooks: [
          {
            type: 'command',
            command: `${LEGACY_CAG_SCRIPT_PATH}/${hookScriptName('context-augmentation-hook')}`,
            timeout: 60,
          },
        ],
      };
      harness.cwd.writeFile(
        '.claude/settings.json',
        JSON.stringify({
          hooks: {
            PostToolUse: [legacyEntry],
            PostToolUseFailure: [legacyEntry],
          },
        }),
      );
      harness.cwd.writeFile(
        `${LEGACY_CAG_SCRIPT_PATH}/${hookScriptName('context-augmentation-hook')}`,
        '#!/bin/bash\nsonar context __hook Claude\n',
      );
      harness
        .state()
        .withInstalledIntegrationFeature(
          claudeIntegration,
          'context-augmentation',
          'project',
          harness.cwd.path,
        );

      const result = await harness.run('integrate claude --non-interactive', {
        extraEnv: {
          SONARQUBE_CLI_SONARCLOUD_URL: server.baseUrl(),
          SONARQUBE_CLI_SONARCLOUD_API_URL: server.baseUrl(),
        },
      });
      expect(result.exitCode).toBe(0);

      const settings = readClaudeSettings(harness);

      expect(
        entriesOwnedBy(settings.hooks?.PostToolUse, 'sonar-context-augmentation'),
      ).toHaveLength(0);
      expect(
        entriesOwnedBy(settings.hooks?.PostToolUseFailure, 'sonar-context-augmentation'),
      ).toHaveLength(0);
      expect(
        harness.cwd.exists(
          '.claude',
          'hooks',
          'sonar-context-augmentation',
          'build-scripts',
          hookScriptName('context-augmentation-hook'),
        ),
      ).toBe(false);

      const postToolEntries = entriesOwnedBy(settings.hooks?.PostToolUse, 'sonar-sqaa');
      expect(postToolEntries).toHaveLength(1);
      const postToolTokens = postToolEntries[0]?.matcher?.split('|') ?? [];
      for (const tool of ['Bash', 'PowerShell', 'Monitor', 'Read']) {
        expect(postToolTokens).toContain(tool);
      }

      expect(
        entriesOwnedBy(settings.hooks?.PostToolUseFailure, 'sonar-posttoolusefailure'),
      ).toHaveLength(1);
      expect(
        harness.cwd.exists(
          '.claude',
          'hooks',
          'sonar-posttoolusefailure',
          'build-scripts',
          hookScriptName('posttoolusefailure'),
        ),
      ).toBe(true);

      expect(findClaudeFeature(harness, 'sonar-sqaa-hook')).toBeDefined();
      const claude = loadState(harness).integrations.installed.find(
        (integration) => integration.integrationId === 'claude-code',
      );
      const cagFeature = claude?.features.find(
        (feature) => feature.featureId === 'context-augmentation',
      );
      expect(cagFeature).toBeDefined();
      const resourceIds = (cagFeature?.resources ?? []).map((r) => r.id);
      expect(resourceIds).toContain('posttoolusefailure-script');
      expect(resourceIds).toContain('claude-settings-posttoolusefailure-hook');
    },
    { timeout: 30000 },
  );
});
