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

import { TestHarness } from '../../harness';
import { readCagInvocations } from '../../harness/cag-helpers';
import { runPiExtension } from '../../harness/pi-extension-host';
import { commitFile, initGitRepo } from '../hook/git-test-helpers';

const TOKEN = 'cloud-token';
const TEST_ORG = 'my-org';
const TEST_PROJECT = 'my-project';
const CAG_CONTEXT = 'CONDENSED VORTEX SKILL';
const ANNOUNCE_TYPE = 'sonar-cag-announce';
const EXTENSION_PATH = ['.pi', 'agent', 'extensions', 'sonar-cag.ts'];
const PROJECT_PROPERTIES = `sonar.projectKey=${TEST_PROJECT}\n`;

const SESSION_START = {
  event: 'session_start',
  payload: { type: 'session_start', reason: 'startup' },
};

describe('integrate pi: Vortex Context extension, run against the real CLI', () => {
  let harness: TestHarness;
  let extensionPath: string;

  async function setUp(options: { linked?: boolean } = {}): Promise<void> {
    harness
      .state()
      .withSecretsBinaryInstalled()
      .withContextAugmentationBinaryInstalled({ sessionContextStdout: CAG_CONTEXT });
    harness.withCliInPath();
    initGitRepo(harness.cwd.path);
    commitFile(harness.cwd.path, 'README.md', 'baseline');
    if (options.linked !== false) {
      commitFile(harness.cwd.path, 'sonar-project.properties', PROJECT_PROPERTIES);
    }
    const server = await harness
      .newFakeServer()
      .withAuthToken(TOKEN)
      .withOrganizations([{ key: TEST_ORG, name: 'My Org' }])
      .withVortexEntitlement(TEST_ORG, 'test-uuid-1234')
      .withProject(TEST_PROJECT)
      .start();
    harness.withAuth(server.baseUrl(), TOKEN, TEST_ORG);

    const install = await harness.run('integrate pi --non-interactive', {
      extraEnv: {
        SONARQUBE_CLI_SONARCLOUD_URL: server.baseUrl(),
        SONARQUBE_CLI_SONARCLOUD_API_URL: server.baseUrl(),
      },
    });
    expect(install.exitCode).toBe(0);
    extensionPath = harness.userHome.file(...EXTENSION_PATH).path;
  }

  function sessionContextCalls(): number {
    return readCagInvocations(harness).filter(
      (invocation) => invocation.argv[1] === 'print-session-start-context',
    ).length;
  }

  beforeEach(async () => {
    harness = await TestHarness.create();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it(
    'announces the Context tools to the agent at session start, without showing them in the terminal',
    async () => {
      await setUp();

      const run = await runPiExtension(harness, extensionPath, [SESSION_START]);

      expect(run.registered).toEqual(['session_start']);
      expect(run.sentMessages).toEqual([
        {
          customType: ANNOUNCE_TYPE,
          content: [{ type: 'text', text: `${CAG_CONTEXT}\n` }],
          display: false,
        },
      ]);
      expect(sessionContextCalls()).toBe(1);
    },
    { timeout: 60000 },
  );

  it(
    'does not announce again when the session already holds the announcement',
    async () => {
      await setUp();

      const run = await runPiExtension(harness, extensionPath, [SESSION_START], {
        entries: [
          { type: 'message', message: { role: 'user' } },
          { type: 'custom_message', customType: ANNOUNCE_TYPE, display: false },
        ],
      });

      expect(run.sentMessages).toEqual([]);
      expect(sessionContextCalls()).toBe(0);
    },
    { timeout: 60000 },
  );

  it(
    'announces nothing until the project is linked to Sonar',
    async () => {
      await setUp({ linked: false });

      const unlinked = await runPiExtension(harness, extensionPath, [SESSION_START]);

      expect(unlinked.sentMessages).toEqual([]);
      expect(sessionContextCalls()).toBe(0);

      harness.cwd.writeFile('sonar-project.properties', PROJECT_PROPERTIES);

      const linked = await runPiExtension(harness, extensionPath, [SESSION_START]);

      expect(linked.sentMessages).toHaveLength(1);
      expect(sessionContextCalls()).toBe(1);
    },
    { timeout: 60000 },
  );
  it(
    'shows a failure without recording a successful announcement and retries after recovery',
    async () => {
      await setUp();
      harness.state().withContextAugmentationBinaryInstalled({ sessionContextStdout: '' });
      const failed = await runPiExtension(harness, extensionPath, [SESSION_START, SESSION_START]);
      expect(failed.sentMessages).toEqual([
        {
          customType: 'sonar-cag-warning',
          content: [
            {
              type: 'text',
              text: "Vortex context was not loaded. The context command returned no context. Run 'sonar system status' and check the CLI debug logs.",
            },
          ],
          display: true,
        },
      ]);
      harness.state().withContextAugmentationBinaryInstalled({ sessionContextStdout: CAG_CONTEXT });
      const recovered = await runPiExtension(harness, extensionPath, [SESSION_START], {
        entries: [{ type: 'custom_message', customType: 'sonar-cag-warning', display: true }],
      });
      expect(recovered.sentMessages).toEqual([
        {
          customType: ANNOUNCE_TYPE,
          content: [{ type: 'text', text: `${CAG_CONTEXT}\n` }],
          display: false,
        },
      ]);
    },
    { timeout: 60000 },
  );
});
