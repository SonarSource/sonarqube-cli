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

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { buildLocalCagBinaryName } from '@/commands/_common/install/context-augmentation.ts';
import { CONTEXT_AUGMENTATION_FEATURE_ID } from '@/commands/integrate/_common/features/context-augmentation-feature.ts';
import { CONTEXT_AUGMENTATION_BINARY_NAME } from '@/core/host/install-types.ts';
import { detectPlatform } from '@/core/host/platform-detector.ts';

import { version as CURRENT_VERSION } from '../../../../package.json';
import { hookScriptName, IS_WINDOWS, TestHarness } from '../../harness';
import { readCagInvocations } from '../../harness/cag-invocations';

describe('post-update migration', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it(
    'quits quietly when state cannot be read',
    async () => {
      // runPostUpdateActions() runs on every invocation and reads
      // state via tryLoadState(). A corrupt file must make it a silent no-op
      // rather than crash the CLI or overwrite the file.
      harness.state().withRawState('not-valid-json');

      const result = await harness.run('--version');

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

      // Any command triggers runPostUpdateActions() before execution
      await harness.run('--version');

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
    'stops running CAG tools and refreshes declaratively tracked skills after a CLI upgrade',
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
          tools: {
            installed: [
              {
                name: CONTEXT_AUGMENTATION_BINARY_NAME,
                version: staleCagVersion,
                path: installedBinaryPath,
                installedAt: new Date().toISOString(),
                installedByCliVersion: '0.5.0',
              },
            ],
          },
          dependencies: {
            installed: [
              {
                id: CONTEXT_AUGMENTATION_BINARY_NAME,
                dependencyType: 'context-augmentation-binary',
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

      await harness.run('--version');

      const invocations = readCagInvocations(harness);
      const stopIndex = invocations.findIndex(
        (i) => i.argv[0] === 'tool' && i.argv[1] === 'stop' && i.argv[2] === '--all',
      );
      const printSkillIndex = invocations.findIndex(
        (i) => i.argv[0] === 'tool' && i.argv[1] === 'print-skill',
      );
      expect(stopIndex).toBeGreaterThanOrEqual(0);
      expect(invocations[printSkillIndex]?.argv).toEqual([
        'tool',
        'print-skill',
        '--invocation-prefix',
        'sonar context',
        '--sca-enabled=false',
      ]);
      // Stop must precede the skill refresh.
      expect(stopIndex).toBeLessThan(printSkillIndex);
      expect(
        harness.cwd.file('.claude', 'skills', 'sonar-context-augmentation', 'SKILL.md').asText(),
      ).toContain('# Generated CAG skill');
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
      // The path is shell-quoted so it survives spaces/metacharacters:
      // double-quoted on Windows, single-quoted on Unix.
      const expectedPretoolCommand = IS_WINDOWS
        ? `powershell -NoProfile -ExecutionPolicy Bypass -File "${pretoolScriptRel}"`
        : `'${pretoolScriptRel}'`;
      const expectedPromptCommand = IS_WINDOWS
        ? `powershell -NoProfile -ExecutionPolicy Bypass -File "${promptScriptRel}"`
        : `'${promptScriptRel}'`;

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

      const result = await harness.run('--version');

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
});
