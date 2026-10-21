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

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { OPENCODE_PLUGIN_MANAGED_MARKER } from '@/commands/integrate/opencode/secrets-plugin-content.ts';

import { TestHarness } from '../../harness';
import type { SqaaResponseConfig } from '../../harness/fake-sonarqube-server';
import {
  completedEvent,
  type OpenCodePluginStepResult,
  runOpenCodePlugin,
} from '../../harness/opencode-plugin-host';
import { commitFile, initGitRepo } from '../hook/git-test-helpers';

const TOKEN = 'cloud-token';
const TEST_ORG = 'my-org';
const TEST_PROJECT = 'my-project';
const PLUGIN_PATH = ['.config', 'opencode', 'plugins', 'sonar-sqaa.ts'];
const SQAA_PATHS = new Set(['/a3s-analysis/analyses', '/api/v2/a3s/analyses']);
const PROJECT_PROPERTIES = `sonar.projectKey=${TEST_PROJECT}\n`;

interface SetUpOptions {
  linked?: boolean;
  sqaa?: SqaaResponseConfig;
  sqaaStatusCode?: number;
}

function chunksOf(result: OpenCodePluginStepResult): { type: string; text: string }[] {
  return (result.event.result as { content: { type: string; text: string }[] }).content;
}

describe('integrate opencode: Vortex SQAA plugin, run against the real CLI', () => {
  let harness: TestHarness;
  let sqaaCalls: () => number;
  let pluginPath: string;

  async function setUp(options: SetUpOptions = {}): Promise<void> {
    harness.state().withSecretsBinaryInstalled().withContextAugmentationBinaryInstalled();
    harness.withCliInPath();
    initGitRepo(harness.cwd.path);
    commitFile(harness.cwd.path, 'README.md', 'baseline');
    if (options.linked !== false) {
      commitFile(harness.cwd.path, 'sonar-project.properties', PROJECT_PROPERTIES);
    }
    const base = harness
      .newFakeServer()
      .withAuthToken(TOKEN)
      .withOrganizations([{ key: TEST_ORG, name: 'My Org' }])
      .withVortexEntitlement(TEST_ORG, 'test-uuid-1234')
      .withProject(TEST_PROJECT);
    const configured =
      options.sqaaStatusCode === undefined
        ? base.withSqaaResponse(options.sqaa ?? { issues: [] })
        : base.withSqaaStatusCode(options.sqaaStatusCode);
    const server = await configured.start();
    harness.withAuth(server.baseUrl(), TOKEN, TEST_ORG);
    sqaaCalls = () =>
      server.getRecordedRequests().filter((request) => SQAA_PATHS.has(request.path)).length;

    const install = await harness.run('integrate opencode --non-interactive', {
      extraEnv: {
        SONARQUBE_CLI_SONARCLOUD_URL: server.baseUrl(),
        SONARQUBE_CLI_SONARCLOUD_API_URL: server.baseUrl(),
      },
    });
    expect(install.exitCode).toBe(0);
    pluginPath = harness.userHome.file(...PLUGIN_PATH).path;
  }

  beforeEach(async () => {
    harness = await TestHarness.create();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it(
    'adds the analysis result after each completed edit and write',
    async () => {
      await setUp();
      harness.cwd.writeFile('a.ts', 'const a = 1;');
      harness.cwd.writeFile('b.ts', 'const b = 1;');
      const stepContent = [{ type: 'text', text: 'Edit applied' }];

      const run = await runOpenCodePlugin(harness, pluginPath, [
        completedEvent('edit', { path: 'a.ts' }, stepContent),
        completedEvent('write', { path: 'b.ts' }, stepContent),
      ]);

      expect(harness.userHome.file(...PLUGIN_PATH).asText()).toContain(
        OPENCODE_PLUGIN_MANAGED_MARKER,
      );
      expect(run.id).toBe('sonar-sqaa');
      expect(run.registered).toEqual(['tool.execute.after']);
      const chunks = chunksOf(run.results[0]);
      expect(chunks).toHaveLength(2);
      expect(chunks[0].text).toBe('Edit applied');
      expect(chunks[1].text).toStartWith('<system-reminder>\n');
      expect(chunks[1].text).toContain('No issues found');
      expect(chunks[1].text).toContain('a.ts');
      expect(chunks[1].text).toContain('say it comes from the Sonar Vortex analysis');
      expect(chunks[1].text).toEndWith('\n</system-reminder>');
      expect(chunksOf(run.results[1])[1].text).toContain('b.ts');
      expect(sqaaCalls()).toBe(2);
    },
    { timeout: 60000 },
  );

  it(
    'shows the issues found by the analysis',
    async () => {
      await setUp({
        sqaa: {
          issues: [
            { rule: 'typescript:S1481', message: 'Remove the unused variable', startLine: 1 },
          ],
        },
      });
      harness.cwd.writeFile('a.ts', 'const unused = 1;');

      const run = await runOpenCodePlugin(harness, pluginPath, [
        completedEvent('edit', { path: 'a.ts' }, [{ type: 'text', text: 'Edit applied' }]),
      ]);

      expect(chunksOf(run.results[0])[1].text).toContain('Remove the unused variable');
      expect(chunksOf(run.results[0])[1].text).toContain('typescript:S1481');
    },
    { timeout: 60000 },
  );

  it(
    'keeps a text result and adds the analysis after it',
    async () => {
      await setUp();
      harness.cwd.writeFile('a.ts', 'const a = 1;');

      const run = await runOpenCodePlugin(harness, pluginPath, [
        completedEvent('edit', { path: 'a.ts' }, 'Edit applied'),
      ]);

      const chunks = chunksOf(run.results[0]);
      expect(chunks[0]).toEqual({ type: 'text', text: 'Edit applied' });
      expect(chunks[1].text).toContain('No issues found');
    },
    { timeout: 60000 },
  );

  it(
    'ignores other tools and failed tool calls',
    async () => {
      await setUp();
      harness.cwd.writeFile('a.ts', 'const a = 1;');
      const stepContent = [{ type: 'text', text: 'done' }];

      const run = await runOpenCodePlugin(harness, pluginPath, [
        completedEvent('read', { path: 'a.ts' }, stepContent),
        {
          hook: 'tool.execute.after',
          event: {
            tool: 'edit',
            sessionID: 'ses_test',
            input: { path: 'a.ts' },
            status: 'error',
            error: { message: 'failed' },
          },
        },
      ]);

      expect(chunksOf(run.results[0])).toEqual(stepContent);
      expect(run.results[1].event.result).toBeUndefined();
      expect(sqaaCalls()).toBe(0);
    },
    { timeout: 60000 },
  );

  it(
    'adds nothing until the project is linked to Sonar',
    async () => {
      await setUp({ linked: false });
      harness.cwd.writeFile('a.ts', 'const a = 1;');
      const step = completedEvent('edit', { path: 'a.ts' }, [
        { type: 'text', text: 'Edit applied' },
      ]);

      const run = await runOpenCodePlugin(harness, pluginPath, [step]);

      expect(chunksOf(run.results[0])).toHaveLength(1);
      expect(sqaaCalls()).toBe(0);
    },
    { timeout: 60000 },
  );

  it(
    'stays silent when the analysis server fails',
    async () => {
      await setUp({ sqaaStatusCode: 500 });
      harness.cwd.writeFile('a.ts', 'const a = 1;');

      const run = await runOpenCodePlugin(harness, pluginPath, [
        completedEvent('edit', { path: 'a.ts' }, [{ type: 'text', text: 'Edit applied' }]),
      ]);

      expect(run.results[0].error).toBeNull();
      expect(chunksOf(run.results[0])).toHaveLength(1);
      expect(sqaaCalls()).toBe(1);
    },
    { timeout: 60000 },
  );

  it(
    'analyzes the edit even when OpenCode runs the plugin from another directory',
    async () => {
      await setUp();
      harness.cwd.writeFile('a.ts', 'const a = 1;');

      const run = await runOpenCodePlugin(
        harness,
        pluginPath,
        [completedEvent('edit', { path: 'a.ts' }, [{ type: 'text', text: 'Edit applied' }])],
        { processCwd: harness.userHome.path },
      );

      expect(chunksOf(run.results[0])).toHaveLength(2);
      expect(chunksOf(run.results[0])[1].text).toContain('No issues found');
      expect(sqaaCalls()).toBe(1);
    },
    { timeout: 60000 },
  );
});
