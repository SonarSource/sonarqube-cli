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

import { version as CURRENT_VERSION } from '../../../../package.json';
import { buildLocalCagBinaryName } from '../../../../src/cli/commands/_common/install/context-augmentation';
import { CONTEXT_AUGMENTATION_BINARY_NAME } from '../../../../src/lib/install-types';
import { detectPlatform } from '../../../../src/lib/platform-detector';
import { SONAR_CONTEXT_AUGMENTATION_VERSION } from '../../../../src/lib/signatures';
import { TestHarness } from '../../harness';
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
    'stops running CAG tools and refreshes registered skills after a CLI upgrade',
    async () => {
      // Skill recorded with an older CAG version — triggers post-update refresh.
      const staleSkillVersion = '0.0.0.1';
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
                version: SONAR_CONTEXT_AUGMENTATION_VERSION,
                // Absolute path the harness writes the CAG stub to.
                path: harness.cliHome.file('bin', buildLocalCagBinaryName(detectPlatform())).path,
                installedAt: new Date().toISOString(),
                installedByCliVersion: '0.5.0',
              },
            ],
          },
          agentExtensions: [
            {
              id: randomUUID(),
              agentId: 'claude-code',
              projectRoot: harness.cwd.path,
              global: false,
              kind: 'skill',
              name: CONTEXT_AUGMENTATION_BINARY_NAME,
              version: staleSkillVersion,
              scaEnabled: false,
              projectKey: 'p',
              orgKey: 'o',
              serverUrl: 'https://sonarcloud.io',
              updatedByCliVersion: '0.5.0',
              updatedAt: new Date().toISOString(),
            },
          ],
        }),
      );
      // Copies the CAG stub into <cliHome>/bin so the stop step can spawn it.
      harness.state().withContextAugmentationBinaryInstalled();

      await harness.run('--version');

      const invocations = readCagInvocations(harness);
      const stopIndex = invocations.findIndex(
        (i) => i.argv[0] === 'tool' && i.argv[1] === 'stop' && i.argv[2] === '--all',
      );
      const skillIndex = invocations.findIndex(
        (i) => i.argv[0] === 'tool' && i.argv[1] === 'install-skill',
      );
      expect(stopIndex).toBeGreaterThanOrEqual(0);
      expect(invocations[skillIndex]?.argv).toEqual([
        'tool',
        'install-skill',
        'claude-code',
        '--invocation-prefix',
        'sonar context',
        '--sca-enabled=false',
      ]);
      // Stop must precede the skill refresh.
      expect(stopIndex).toBeLessThan(skillIndex);
    },
    { timeout: 30000 },
  );
});
