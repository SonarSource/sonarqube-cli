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

import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { TestHarness } from '../../harness';
import type { SqaaResponseConfig } from '../../harness/fake-sonarqube-server';
import { runPiExtension } from '../../harness/pi-extension-host';
import { commitFile, initGitRepo } from '../hook/git-test-helpers';

const TOKEN = 'cloud-token';
const TEST_ORG = 'my-org';
const TEST_PROJECT = 'my-project';
const EXTENSION_PATH = ['.pi', 'agent', 'extensions', 'sonar-sqaa.ts'];
const SQAA_PATHS = new Set(['/a3s-analysis/analyses', '/api/v2/a3s/analyses']);
const PROJECT_PROPERTIES = `sonar.projectKey=${TEST_PROJECT}\n`;

type ToolResultAnswer = { content: { type: string; text: string }[] } | null;
type SettleAnswer = {
  continue: boolean;
  entries: { type: string; customType: string; display: boolean; content: { text: string }[] }[];
} | null;

interface SetUpOptions {
  linked?: boolean;
  sqaa?: SqaaResponseConfig;
  sqaaStatusCode?: number;
}

function toolResult(path: string | undefined, toolName = 'edit', isError = false) {
  return {
    event: 'tool_result',
    payload: {
      type: 'tool_result',
      toolName,
      input: path === undefined ? {} : { path },
      content: [{ type: 'text', text: `Edited ${path}` }],
      isError,
    },
  };
}

function settle(overrides: Record<string, unknown> = {}) {
  return {
    event: 'agent_before_settle',
    payload: {
      type: 'agent_before_settle',
      outcome: 'completed',
      entries: [],
      continue: false,
      ...overrides,
    },
  };
}

function reminderOf(result: unknown): string {
  return (result as ToolResultAnswer)?.content[1]?.text ?? '';
}

function completionFeedbackOf(result: unknown): string {
  return (result as SettleAnswer)?.entries.at(-1)?.content[0].text ?? '';
}

describe('integrate pi: Vortex SQAA extension, run against the real CLI', () => {
  let harness: TestHarness;
  let sqaaCalls: () => number;
  let extensionPath: string;

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

    const install = await harness.run('integrate pi --non-interactive', {
      extraEnv: {
        SONARQUBE_CLI_SONARCLOUD_URL: server.baseUrl(),
        SONARQUBE_CLI_SONARCLOUD_API_URL: server.baseUrl(),
      },
    });
    expect(install.exitCode).toBe(0);
    extensionPath = harness.userHome.file(...EXTENSION_PATH).path;
  }

  beforeEach(async () => {
    harness = await TestHarness.create();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it('keeps per-edit analysis and runs DEEP once for an unchanged Git change set', async () => {
    await setUp();
    harness.cwd.writeFile('a.ts', 'const a = 1;');
    harness.cwd.writeFile('b.ts', 'const b = 1;');
    const run = await runPiExtension(harness, extensionPath, [
      toolResult('a.ts'),
      toolResult('b.ts', 'write'),
      settle(),
      settle(),
    ]);
    expect([...run.registered].sort()).toEqual(['agent_before_settle', 'tool_result']);
    const afterEdit = run.results[0] as ToolResultAnswer;
    expect(afterEdit?.content).toHaveLength(2);
    expect(afterEdit?.content[0].text).toBe('Edited a.ts');
    expect(reminderOf(afterEdit)).toContain('No issues found');
    expect(reminderOf(afterEdit)).toContain('Sonar Vortex analysis');
    expect(run.results.slice(2)).toEqual([null, null]);
    expect(sqaaCalls()).toBe(3);
  }, 60000);

  it('analyzes Git changes without requiring an edit tool event and preserves other entries', async () => {
    await setUp({
      sqaa: {
        issues: [{ rule: 'typescript:S1481', message: 'Remove the unused variable', startLine: 1 }],
      },
    });
    harness.cwd.writeFile('a.ts', 'const unused = 1;');
    const existing = { type: 'custom', customType: 'other-extension', data: 1 };
    const run = await runPiExtension(harness, extensionPath, [
      settle({ entries: [existing], canContinue: false }),
      settle(),
    ]);
    const atEnd = run.results[0] as SettleAnswer;
    expect(atEnd?.continue).toBe(true);
    expect(atEnd?.entries).toHaveLength(2);
    expect(atEnd?.entries[0]).toEqual(existing as never);
    expect(atEnd?.entries[1]).toMatchObject({
      type: 'custom_message',
      customType: 'sonar-completion-analysis',
      display: false,
    });
    expect(completionFeedbackOf(atEnd)).toContain('Vortex analysis');
    expect(completionFeedbackOf(atEnd)).toContain('Remove the unused variable');
    expect(completionFeedbackOf(atEnd)).not.toContain('sonar analyze');
    expect(run.results[1]).toBeNull();
    expect(sqaaCalls()).toBe(1);
  }, 60000);

  it('uses the shared retry limit across extension reloads and resets after stopping', async () => {
    await setUp({
      sqaa: {
        issues: [{ rule: 'typescript:S1481', message: 'Remove the unused variable', startLine: 1 }],
      },
    });
    for (let attempt = 1; attempt <= 4; attempt++) {
      harness.cwd.writeFile('a.ts', `const unused = ${attempt};`);
      const run = await runPiExtension(harness, extensionPath, [settle()]);
      if (attempt <= 3) {
        expect((run.results[0] as SettleAnswer)?.continue).toBe(true);
      } else {
        expect(run.results[0]).toBeNull();
      }
    }
    expect(sqaaCalls()).toBe(3);
    const nextTurn = await runPiExtension(harness, extensionPath, [settle()]);
    expect((nextTurn.results[0] as SettleAnswer)?.continue).toBe(true);
    expect(sqaaCalls()).toBe(4);
  }, 60000);

  it('skips headless completions while preserving their per-edit analysis', async () => {
    await setUp({
      sqaa: {
        issues: [{ rule: 'typescript:S1481', message: 'Remove the unused variable', startLine: 1 }],
      },
    });
    harness.cwd.writeFile('a.ts', 'const unused = 1;');
    const run = await runPiExtension(harness, extensionPath, [toolResult('a.ts'), settle()], {
      hasUI: false,
    });
    expect(reminderOf(run.results[0])).toContain('Remove the unused variable');
    expect(run.results[1]).toBeNull();
    expect(sqaaCalls()).toBe(1);
    const main = await runPiExtension(harness, extensionPath, [settle()]);
    expect((main.results[0] as SettleAnswer)?.continue).toBe(true);
    expect(sqaaCalls()).toBe(2);
  }, 60000);

  it.each(['error', 'aborted', undefined])(
    'skips a non-completed outcome: %s',
    async (outcome) => {
      await setUp();
      harness.cwd.writeFile('a.ts', 'const a = 1;');
      const run = await runPiExtension(harness, extensionPath, [settle({ outcome })]);
      expect(run.results).toEqual([null]);
      expect(sqaaCalls()).toBe(0);
      const completed = await runPiExtension(harness, extensionPath, [settle()]);
      expect(completed.results).toEqual([null]);
      expect(sqaaCalls()).toBe(1);
    },
    60000,
  );

  it('skips unlinked projects and starts analysis once linked', async () => {
    await setUp({ linked: false });
    harness.cwd.writeFile('a.ts', 'const a = 1;');
    const unlinked = await runPiExtension(harness, extensionPath, [toolResult('a.ts'), settle()]);
    expect(unlinked.results).toEqual([null, null]);
    expect(sqaaCalls()).toBe(0);
    harness.cwd.writeFile('sonar-project.properties', PROJECT_PROPERTIES);
    const linked = await runPiExtension(harness, extensionPath, [settle()]);
    expect(linked.results).toEqual([null]);
    expect(sqaaCalls()).toBe(1);
  }, 60000);

  it('allows stopping on server failures and retries the unchanged change set', async () => {
    await setUp({ sqaaStatusCode: 500 });
    harness.cwd.writeFile('a.ts', 'const a = 1;');
    const run = await runPiExtension(harness, extensionPath, [settle(), settle()]);
    expect(run.results).toEqual([null, null]);
    expect(sqaaCalls()).toBe(2);
  }, 60000);

  it('runs analysis in Pi working directory rather than the process directory', async () => {
    await setUp({
      sqaa: {
        issues: [{ rule: 'typescript:S1481', message: 'Remove the unused variable', startLine: 1 }],
      },
    });
    harness.cwd.writeFile('a.ts', 'const unused = 1;');
    const run = await runPiExtension(harness, extensionPath, [settle()], {
      processCwd: harness.userHome.path,
    });
    expect(completionFeedbackOf(run.results[0])).toContain('Remove the unused variable');
    expect(sqaaCalls()).toBe(1);
  }, 60000);

  it('allows stopping when the session identity is unavailable', async () => {
    await setUp();
    harness.cwd.writeFile('a.ts', 'const a = 1;');
    const run = await runPiExtension(harness, extensionPath, [toolResult('a.ts'), settle()], {
      sessionIdThrows: true,
    });
    expect(run.results).toEqual([null, null]);
    expect(sqaaCalls()).toBe(0);
  }, 60000);
  it(
    'ignores failed edits, edits without a path and tools other than edit and write',
    async () => {
      await setUp();
      harness.cwd.writeFile('a.ts', 'const a = 1;');

      const run = await runPiExtension(harness, extensionPath, [
        toolResult('a.ts', 'edit', true),
        toolResult('a.ts', 'bash'),
        toolResult(undefined),
        toolResult('a.ts'),
      ]);

      expect(run.results.slice(0, 3)).toEqual([null, null, null]);
      expect(reminderOf(run.results[3])).toContain('No issues found');
      expect(sqaaCalls()).toBe(1);
    },
    { timeout: 60000 },
  );

  it(
    'resolves the path of an edit the way Pi does',
    async () => {
      await setUp();
      harness.cwd.writeFile('src/a.ts', 'const a = 1;');
      harness.cwd.writeFile('src/b.ts', 'const b = 1;');
      harness.cwd.writeFile('my notes.ts', 'const c = 1;');
      const noBreakSpace = String.fromCharCode(0x00a0);

      const run = await runPiExtension(harness, extensionPath, [
        toolResult('@src/a.ts'),
        toolResult(pathToFileURL(join(harness.cwd.path, 'src', 'b.ts')).href),
        toolResult(`my${noBreakSpace}notes.ts`),
      ]);

      expect(reminderOf(run.results[0])).toContain('src/a.ts');
      expect(reminderOf(run.results[1])).toContain('src/b.ts');
      expect(reminderOf(run.results[2])).toContain('my notes.ts');
    },
    { timeout: 60000 },
  );

  describe.skipIf(process.platform === 'win32')('when the sonar command misbehaves', () => {
    let stubDir: string;

    beforeEach(() => {
      stubDir = mkdtempSync(join(tmpdir(), 'sonar-pi-stub-'));
    });

    afterEach(() => {
      rmSync(stubDir, { recursive: true, force: true });
    });

    function stubSonar(stdout: string): void {
      const script = join(stubDir, 'sonar');
      writeFileSync(
        script,
        `#!/bin/sh\necho invoked >> "${join(stubDir, 'invoked.txt')}"\ncat > /dev/null\nprintf '%s' '${stdout}'\n`,
      );
      chmodSync(script, 0o755);
    }

    it.each([
      ['something that is not JSON', 'not json'],
      ['null', 'null'],
      ['a context that is not a string', '{"context":42}'],
      ['findings that are not a string', '{"findings":42}'],
      ['empty findings', '{"findings":"  "}'],
    ])(
      'stays silent when sonar answers with %s',
      async (_description, stdout) => {
        await setUp();
        harness.cwd.writeFile('a.ts', 'const a = 1;');
        stubSonar(stdout);

        const run = await runPiExtension(harness, extensionPath, [toolResult('a.ts'), settle()], {
          env: { PATH: `${stubDir}:/usr/bin:/bin` },
        });

        expect(run.results).toEqual([null, null]);
        expect(existsSync(join(stubDir, 'invoked.txt'))).toBe(true);
      },
      { timeout: 60000 },
    );

    it(
      'stays silent when the sonar command cannot be found',
      async () => {
        await setUp();
        harness.cwd.writeFile('a.ts', 'const a = 1;');

        const run = await runPiExtension(harness, extensionPath, [toolResult('a.ts'), settle()], {
          env: { PATH: stubDir },
        });

        expect(run.results).toEqual([null, null]);
        expect(sqaaCalls()).toBe(0);
      },
      { timeout: 60000 },
    );
  });
});
