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

function newPrompt() {
  return {
    event: 'before_agent_start',
    payload: { type: 'before_agent_start', prompt: 'do the work', images: [] },
  };
}

function reminderOf(result: unknown): string {
  return (result as ToolResultAnswer)?.content[1]?.text ?? '';
}

function deepReminderOf(result: unknown): string {
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

  it(
    'reports the analysis after each edit and asks once, at the end of the run, for a DEEP analysis of the analyzed files',
    async () => {
      await setUp();
      harness.cwd.writeFile('a.ts', 'const a = 1;');
      harness.cwd.writeFile('b.ts', 'const b = 1;');

      const run = await runPiExtension(harness, extensionPath, [
        toolResult('a.ts'),
        toolResult('b.ts', 'write'),
        toolResult('a.ts'),
        settle(),
        settle(),
      ]);

      expect([...run.registered].sort()).toEqual([
        'agent_before_settle',
        'before_agent_start',
        'tool_result',
      ]);
      const afterEdit = run.results[0] as ToolResultAnswer;
      expect(afterEdit?.content).toHaveLength(2);
      expect(afterEdit?.content[0].text).toBe('Edited a.ts');
      expect(reminderOf(afterEdit)).toStartWith('<system-reminder>\n');
      expect(reminderOf(afterEdit)).toContain('No issues found');
      expect(reminderOf(afterEdit)).toContain('a.ts');
      expect(reminderOf(afterEdit)).toContain('Sonar Vortex analysis');
      expect(reminderOf(afterEdit)).toEndWith('\n</system-reminder>');
      expect(sqaaCalls()).toBe(3);

      const atEnd = run.results[3] as SettleAnswer;
      expect(atEnd?.continue).toBe(true);
      expect(atEnd?.entries).toHaveLength(1);
      expect(atEnd?.entries[0].type).toBe('custom_message');
      expect(atEnd?.entries[0].customType).toBe('sonar-deep-reminder');
      expect(atEnd?.entries[0].display).toBe(false);
      expect(deepReminderOf(atEnd)).toBe(
        '<system-reminder>\n' +
          "Before ending your turn, run `sonar analyze agentic --depth DEEP --file 'a.ts' --file 'b.ts'` and summarize the result for the user.\n" +
          '</system-reminder>',
      );
      expect(run.results[4]).toBeNull();
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

      const run = await runPiExtension(harness, extensionPath, [toolResult('a.ts'), settle()]);

      expect(reminderOf(run.results[0])).toContain('Remove the unused variable');
      expect(reminderOf(run.results[0])).toContain('typescript:S1481');
      expect(deepReminderOf(run.results[1])).toContain("--file 'a.ts'");
    },
    { timeout: 60000 },
  );

  it(
    'does nothing, and forces no extra turn, until the project is linked to Sonar',
    async () => {
      await setUp({ linked: false });
      harness.cwd.writeFile('a.ts', 'const a = 1;');

      const unlinked = await runPiExtension(harness, extensionPath, [toolResult('a.ts'), settle()]);

      expect(unlinked.results).toEqual([null, null]);
      expect(sqaaCalls()).toBe(0);

      harness.cwd.writeFile('sonar-project.properties', PROJECT_PROPERTIES);

      const linked = await runPiExtension(harness, extensionPath, [toolResult('a.ts'), settle()]);

      expect(reminderOf(linked.results[0])).toContain('No issues found');
      expect(deepReminderOf(linked.results[1])).toContain("--file 'a.ts'");
      expect(sqaaCalls()).toBe(1);
    },
    { timeout: 60000 },
  );

  it(
    'stays silent, and forces no extra turn, when the analysis server fails',
    async () => {
      await setUp({ sqaaStatusCode: 500 });
      harness.cwd.writeFile('a.ts', 'const a = 1;');

      const run = await runPiExtension(harness, extensionPath, [toolResult('a.ts'), settle()]);

      expect(run.results).toEqual([null, null]);
      expect(sqaaCalls()).toBe(1);
    },
    { timeout: 60000 },
  );

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

  it(
    'single-quotes the paths of the DEEP command, so the shell expands nothing in them',
    async () => {
      await setUp();
      const names = ["it's $HOME b.ts", 'back`tick.ts', 'plain.ts'];
      for (const name of names) {
        harness.cwd.writeFile(name, 'const x = 1;');
      }

      const run = await runPiExtension(harness, extensionPath, [
        ...names.map((name) => toolResult(name)),
        settle(),
      ]);

      const text = deepReminderOf(run.results[names.length]);
      expect(text).toContain("--file 'it'\\''s $HOME b.ts'");
      if (process.platform !== 'win32') {
        const command = /run `(.*)` and summarize/s.exec(text)?.[1] ?? '';
        const fileArguments = command.replace('sonar analyze agentic --depth DEEP ', '');
        const printed = Bun.spawnSync(['sh', '-c', `printf '%s\n' ${fileArguments}`], {
          cwd: harness.cwd.path,
        }).stdout.toString();
        expect(printed.trimEnd().split('\n')).toEqual(names.flatMap((name) => ['--file', name]));
      }
    },
    { timeout: 60000 },
  );

  it(
    'keeps the entries proposed by other extensions',
    async () => {
      await setUp();
      harness.cwd.writeFile('a.ts', 'const a = 1;');
      const existing = { type: 'custom', customType: 'other-extension', data: 1 };

      const run = await runPiExtension(harness, extensionPath, [
        toolResult('a.ts'),
        settle({ entries: [existing] }),
      ]);

      const atEnd = run.results[1] as SettleAnswer;
      expect(atEnd?.entries).toHaveLength(2);
      expect(atEnd?.entries[0]).toEqual(existing as never);
      expect(atEnd?.entries[1].customType).toBe('sonar-deep-reminder');
    },
    { timeout: 60000 },
  );

  it(
    'forces no extra turn after a run that ended in error, and forgets its files',
    async () => {
      await setUp();
      harness.cwd.writeFile('a.ts', 'const a = 1;');

      const run = await runPiExtension(harness, extensionPath, [
        toolResult('a.ts'),
        settle({ outcome: 'error' }),
        settle(),
      ]);

      expect(reminderOf(run.results[0])).toContain('No issues found');
      expect(run.results.slice(1)).toEqual([null, null]);
    },
    { timeout: 60000 },
  );

  it(
    'forgets the files of an interrupted prompt, for which Pi never reaches the end of the run',
    async () => {
      await setUp();
      harness.cwd.writeFile('a.ts', 'const a = 1;');
      harness.cwd.writeFile('b.ts', 'const b = 1;');

      const run = await runPiExtension(harness, extensionPath, [
        toolResult('a.ts'),
        newPrompt(),
        toolResult('b.ts'),
        settle(),
      ]);

      expect(deepReminderOf(run.results[3])).toContain("--file 'b.ts'");
      expect(deepReminderOf(run.results[3])).not.toContain('a.ts');
    },
    { timeout: 60000 },
  );

  it(
    'asks for the DEEP analysis only once per prompt, even when the agent keeps editing',
    async () => {
      await setUp();
      harness.cwd.writeFile('a.ts', 'const a = 1;');
      harness.cwd.writeFile('b.ts', 'const b = 1;');
      harness.cwd.writeFile('c.ts', 'const c = 1;');

      const run = await runPiExtension(harness, extensionPath, [
        toolResult('a.ts'),
        settle(),
        toolResult('b.ts'),
        settle(),
        newPrompt(),
        toolResult('c.ts'),
        settle(),
      ]);

      expect((run.results[1] as SettleAnswer)?.continue).toBe(true);
      expect(run.results[3]).toBeNull();
      expect(deepReminderOf(run.results[6])).toContain("--file 'c.ts'");
      expect(deepReminderOf(run.results[6])).not.toContain('b.ts');
    },
    { timeout: 60000 },
  );

  it(
    'leaves out files outside the working directory or deleted before the end of the run',
    async () => {
      await setUp();
      harness.cwd.writeFile('a.ts', 'const a = 1;');
      harness.cwd.writeFile('gone.ts', 'const g = 1;');
      const outsideDir = mkdtempSync(join(tmpdir(), 'sonar-pi-outside-'));
      try {
        const outside = join(outsideDir, 'notes.ts');
        writeFileSync(outside, 'const n = 1;');

        const run = await runPiExtension(harness, extensionPath, [
          toolResult('a.ts'),
          toolResult(outside, 'write'),
          toolResult('gone.ts'),
          { remove: join(harness.cwd.path, 'gone.ts') },
          settle(),
        ]);

        expect(deepReminderOf(run.results[4])).toContain("--file 'a.ts'");
        expect(deepReminderOf(run.results[4])).not.toContain('notes.ts');
        expect(deepReminderOf(run.results[4])).not.toContain('gone.ts');
      } finally {
        rmSync(outsideDir, { recursive: true, force: true });
      }
    },
    { timeout: 60000 },
  );

  it(
    'asks for a DEEP analysis of a file whose name starts with two dots',
    async () => {
      await setUp();
      harness.cwd.writeFile('..cache/x.ts', 'const x = 1;');

      const run = await runPiExtension(harness, extensionPath, [
        toolResult('..cache/x.ts'),
        settle(),
      ]);

      expect(deepReminderOf(run.results[1])).toContain(`--file '${join('..cache', 'x.ts')}'`);
    },
    { timeout: 60000 },
  );

  it(
    'runs the hook in the working directory Pi reports, not in the directory of the Pi process',
    async () => {
      await setUp();
      harness.cwd.writeFile('a.ts', 'const a = 1;');

      const run = await runPiExtension(harness, extensionPath, [toolResult('a.ts'), settle()], {
        processCwd: harness.userHome.path,
      });

      expect(reminderOf(run.results[0])).toContain('No issues found');
      expect(deepReminderOf(run.results[1])).toContain("--file 'a.ts'");
    },
    { timeout: 60000 },
  );

  it(
    'stays silent when the session id cannot be read',
    async () => {
      await setUp();
      harness.cwd.writeFile('a.ts', 'const a = 1;');

      const run = await runPiExtension(harness, extensionPath, [toolResult('a.ts'), settle()], {
        sessionIdThrows: true,
      });

      expect(run.results).toEqual([null, null]);
      expect(sqaaCalls()).toBe(0);
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
